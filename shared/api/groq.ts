/**
 * The LLM client.
 *
 * Named after Groq for historical reasons — the file is imported by name from
 * several places and is not worth renaming — but nothing in it is
 * Groq-specific any more. Every provider it talks to speaks the same
 * OpenAI-compatible protocol, and *which* one is answered by
 * {@link LlmEndpoint}, resolved from settings by the caller. See
 * `shared/api/provider.ts` for why that indirection exists.
 */
import type { JobInfo, Profile } from '../types';
import {
  apiErrorMessage,
  MAX_CLASSIFY_FIELDS,
  type ApiErrorKind,
  type SelectQuestion,
} from '../messages';
import { httpJson, HttpError } from './http';
import {
  chatCompletionsUrl,
  keyProviderMismatch,
  modelsUrl,
  type LlmEndpoint,
} from './provider';
import {
  buildFieldTemplatePrompt,
  FIELD_TEMPLATE_SYSTEM_PROMPT,
  validateFieldTemplates,
} from './fieldTemplates';
import {
  buildOptionChoicePrompt,
  OPTION_CHOICE_SYSTEM_PROMPT,
  validateOptionChoices,
} from './optionChoice';
import { askableSelects } from '../filler/questionPolicy';
import type { ValueTemplate } from '../filler/valueTemplate';

const TIMEOUT_MS = 15_000;

export class GroqApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    /**
     * The provider's own `error.message`, kept apart from the copy it was folded
     * into.
     *
     * The same failure has to be phrased differently in the popup ("open
     * Settings") and in Settings itself ("pick one from the list below"), so a
     * caller that rewrites the sentence must be able to keep the one part it
     * cannot write itself — what the provider actually said.
     */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'GroqApiError';
  }
}

interface GroqResponse {
  choices: Array<{ message: { content: string } }>;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatRequest {
  endpoint: LlmEndpoint;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Ask for `response_format: json_object`. */
  json?: boolean;
}

/** Every provider here speaks the OpenAI error shape: `{"error":{"message":…}}`. */
interface GroqErrorBody {
  error?: { message?: unknown; code?: unknown; type?: unknown };
}

/**
 * The two fields of an error body worth showing.
 *
 * Only *parsed* values are returned, never the raw body: an HTML error page or a
 * proxy's plain-text complaint must not reach the UI, while `error.message` is a
 * documented, human-written field — the same rule `shared/api/notion.ts` follows
 * with `notionMessage`.
 */
function groqErrorBody(body?: string): { detail?: string; code?: string } {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as GroqErrorBody;
    // Groq's longest real message — the decommissioning notice with its docs
    // link — is ~230 characters; the cap is only there so a proxy that answers
    // with prose cannot push a paragraph into an error banner.
    const detail =
      typeof parsed.error?.message === 'string' ? parsed.error.message.slice(0, 300) : undefined;
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : undefined;
    return { detail, code };
  } catch {
    return {};
  }
}

/** `error.code` values that mean "this model", not "this request". */
const MODEL_CODE = /model_decommissioned|model_not_found|model_terms_required|does_not_exist/i;
/** Fallback when the provider sends prose but no code, e.g. "The model `x` does not exist". */
const MODEL_TEXT = /\bmodel\b/i;

function withDetail(base: string, provider: string, detail?: string): string {
  return detail ? `${base} ${provider} said: ${detail}` : base;
}

function badModelMessage(provider: string, model?: string, detail?: string): string {
  const subject = model
    ? `${provider} does not serve the model “${model}”.`
    : `${provider} does not serve the configured model.`;
  return `${withDetail(subject, provider, detail)} Open Settings → API & Logging and pick one with “Check key”.`;
}

/**
 * Map a transport failure onto the user-facing error states.
 *
 * The `default: NETWORK_ERROR` this replaces was the bug behind the first live
 * run: `BAD_REQUEST` (a decommissioned model) and `NOT_FOUND` (a model id that
 * never existed) both landed in it, so the user was told to check a connection
 * that was working. The reason is in the response body — `HttpError` has
 * carried it all along — and it is read here.
 *
 * The endpoint is threaded in from the call site because the error text is far
 * more useful when it names the provider that refused and the model it refused.
 */
function toGroqError(err: unknown, endpoint?: LlmEndpoint): GroqApiError {
  if (err instanceof GroqApiError) return err;
  const provider = endpoint?.label ?? 'The AI provider';
  const model = endpoint?.model;

  if (!(err instanceof HttpError)) {
    return new GroqApiError('NETWORK_ERROR', apiErrorMessage('NETWORK_ERROR', provider));
  }

  const { detail, code } = groqErrorBody(err.body);

  switch (err.kind) {
    case 'TIMEOUT':
      return new GroqApiError('TIMEOUT', apiErrorMessage('TIMEOUT', provider));

    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return new GroqApiError(
        'UNAUTHORIZED',
        withDetail(apiErrorMessage('UNAUTHORIZED', provider), provider, detail),
        detail,
      );

    case 'RATE_LIMITED':
      return new GroqApiError(
        'RATE_LIMITED',
        withDetail(apiErrorMessage('RATE_LIMITED', provider), provider, detail),
        detail,
      );

    // 404 on these two endpoints only ever means "no such model"; 400 means it
    // once the provider's own code or message says so, and "bad request"
    // otherwise.
    case 'NOT_FOUND':
    case 'BAD_REQUEST': {
      const aboutModel =
        err.kind === 'NOT_FOUND' || MODEL_CODE.test(code ?? '') || MODEL_TEXT.test(detail ?? '');
      return aboutModel
        ? new GroqApiError('BAD_MODEL', badModelMessage(provider, model, detail), detail)
        : new GroqApiError(
            'BAD_REQUEST',
            withDetail(apiErrorMessage('BAD_REQUEST', provider), provider, detail),
            detail,
          );
    }

    // SERVER_ERROR / NETWORK_ERROR / BAD_RESPONSE: the provider is unreachable or
    // broken, and there is nothing in Settings for the user to fix.
    default:
      return new GroqApiError('NETWORK_ERROR', apiErrorMessage('NETWORK_ERROR', provider));
  }
}

/**
 * Refuse before the request when the key belongs to somebody else.
 *
 * Two reasons, and the second is the stronger one:
 *
 *   1. the error it replaces ("Groq said: Invalid API Key") is unactionable, and
 *      cost the first user of this extension an hour;
 *   2. an API key is a credential. Posting an OpenRouter key to `api.groq.com`
 *      hands a working secret to a company that was never meant to see it. That
 *      is worth preventing even when the user would eventually notice.
 *
 * `WRONG_PROVIDER` is its own error kind because it is the one entry in the
 * taxonomy that does not mean "something is broken": the key works, it is just
 * addressed to the wrong company, and the fix is a dropdown rather than a new
 * key.
 */
function assertKeyBelongsHere(endpoint: LlmEndpoint): void {
  const mismatch = keyProviderMismatch(endpoint.providerId, endpoint.apiKey);
  if (mismatch) throw new GroqApiError('WRONG_PROVIDER', mismatch);
}

function assertUsable(endpoint: LlmEndpoint): void {
  if (!endpoint.apiKey) {
    throw new GroqApiError('MISSING_KEY', apiErrorMessage('MISSING_KEY', endpoint.label));
  }
  if (!endpoint.baseUrl) {
    throw new GroqApiError(
      'BAD_REQUEST',
      `No API URL is configured for ${endpoint.label}. Open Settings → API & Logging and add one.`,
    );
  }
  assertKeyBelongsHere(endpoint);
}

/**
 * The one place that talks to the model. Every public function below is a prompt
 * plus a parser on top of this call — timeout, auth and status handling are not
 * duplicated anywhere.
 */
async function chatCompletion(req: ChatRequest): Promise<string> {
  assertUsable(req.endpoint);

  try {
    const data = await httpJson<GroqResponse>(chatCompletionsUrl(req.endpoint.baseUrl), {
      service: req.endpoint.label,
      method: 'POST',
      timeoutMs: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.endpoint.apiKey}`,
        ...req.endpoint.headers,
      },
      body: JSON.stringify({
        model: req.endpoint.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    return data.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    throw toGroqError(err, req.endpoint);
  }
}

// ─── Diagnostics (“Check key” in Settings) ────────────────────────────────────

/** Shape of `GET /models` — only the id is read. */
interface GroqModelList {
  data?: Array<{ id?: unknown }>;
}

/**
 * Every model id `GET /models` reports, alphabetical.
 *
 * Doubles as the cheapest possible key test: the endpoint needs no body, costs
 * no tokens, and answers 401 for a key the provider does not recognise — which
 * is what lets the caller state "the key is fine, the model is not" instead of
 * guessing.
 *
 * What the list *means* differs per provider: Groq and OpenAI answer with the
 * models this key may use, OpenRouter and Together with their whole catalogue.
 * That distinction is `Provider.catalogue`, and it belongs to the UI — this
 * function reports what it was told, unfiltered.
 */
export async function listModels(endpoint: LlmEndpoint): Promise<string[]> {
  if (!endpoint.apiKey) {
    throw new GroqApiError('MISSING_KEY', apiErrorMessage('MISSING_KEY', endpoint.label));
  }
  if (!endpoint.baseUrl) {
    throw new GroqApiError(
      'BAD_REQUEST',
      `No API URL is configured for ${endpoint.label}. Open Settings → API & Logging and add one.`,
    );
  }
  assertKeyBelongsHere(endpoint);

  try {
    const data = await httpJson<GroqModelList>(modelsUrl(endpoint.baseUrl), {
      service: endpoint.label,
      timeoutMs: TIMEOUT_MS,
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, ...endpoint.headers },
    });
    return (data.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    throw toGroqError(err, endpoint);
  }
}

/**
 * Ask the configured model for one token.
 *
 * Deliberately routed through {@link chatCompletion}: a check that used a
 * different request builder could pass while filling still failed. A retired
 * model is refused here exactly as it is during a fill — same URL, same headers,
 * same error translation — for a request that costs a single token.
 */
export async function probeModel(endpoint: LlmEndpoint): Promise<void> {
  await chatCompletion({
    endpoint,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 1,
    temperature: 0,
  });
}

export async function generateMotivation(
  jobInfo: JobInfo,
  profile: Profile,
  endpoint: LlmEndpoint,
): Promise<string> {
  const language = detectLanguage(jobInfo.description);

  const systemPrompt = `You are an assistant that writes concise, professional job application motivation paragraphs.
Write 3-5 sentences in ${language}. Be specific to the role and company. Do not use generic filler phrases.
Return only the paragraph — no preamble, no markdown.`;

  const userPrompt = `Job title: ${jobInfo.position ?? 'unknown'}
Company: ${jobInfo.company ?? 'unknown'}
Job description (excerpt): ${(jobInfo.description ?? '').slice(0, 800)}

Applicant summary: ${profile.about || `${profile.firstName} ${profile.lastName}`}
Skills: (derived from profile summary above)

Write a motivation paragraph.`;

  return chatCompletion({
    endpoint,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 300,
    temperature: 0.7,
  });
}

/**
 * Ask the model what belongs in the fields the heuristics could not name, and
 * get back a *value template* per field.
 *
 * Sends only serialized fingerprints — no user data, and since the answer names
 * profile atoms rather than carrying values, none is needed. The contract, the
 * prompt and every validation rule live in `./fieldTemplates.ts`.
 *
 * This is the egress point, so the {@link MAX_CLASSIFY_FIELDS} cap is applied
 * here as well as at the call site: a caller that ignores it cannot make this
 * function put a hundred fields on the wire, and the indices the model answers
 * with are validated against the *truncated* batch, never the original.
 *
 * Every failure, a missing key included, returns `{}` rather than throwing —
 * see `handleClassifyFields` for why this path stays silent.
 */
export async function planFieldTemplates(
  fingerprints: string[],
  endpoint: LlmEndpoint,
): Promise<Record<string, ValueTemplate>> {
  const batch = fingerprints.slice(0, MAX_CLASSIFY_FIELDS);
  if (batch.length === 0) return {};
  if (!endpoint.apiKey || !endpoint.baseUrl) return {};
  if (keyProviderMismatch(endpoint.providerId, endpoint.apiKey)) return {};

  const raw = await chatCompletion({
    endpoint,
    messages: [
      { role: 'system', content: FIELD_TEMPLATE_SYSTEM_PROMPT },
      { role: 'user', content: buildFieldTemplatePrompt(batch) },
    ],
    // Templates are longer than the type names this used to return: a full batch
    // of 40 costs ≈ 700 tokens of JSON. The budget is deliberately well clear of
    // that, because a truncated reply is invalid JSON and loses the *whole*
    // batch rather than one field.
    maxTokens: 1200,
    temperature: 0,
    json: true,
  });

  try {
    return validateFieldTemplates(JSON.parse(raw || '{}'), batch);
  } catch {
    // Invalid JSON → fields stay as the heuristics left them.
    return {};
  }
}

/**
 * Ask which of a dropdown's own options answers it, and get back an *index* per
 * dropdown.
 *
 * This is the one request in the extension that carries text read out of the
 * page: the labels of a `<select>`'s own options. Nothing else — no profile
 * value, no page prose, no other control's contents, and no dropdown the user
 * has already answered. {@link askableSelects} is applied here as well as where
 * the batch was built, so the policy that decides what may be asked about (no
 * protected question, no yes/no list, size-capped) is enforced at the point the
 * bytes leave the browser and not only at the point they were assembled.
 *
 * Silent on every failure, for the same reason as {@link planFieldTemplates}:
 * this is an unattended pass over controls nothing was written into.
 */
export async function chooseSelectOptions(
  selects: SelectQuestion[],
  endpoint: LlmEndpoint,
): Promise<Record<string, number>> {
  const batch = askableSelects(selects);
  if (batch.length === 0) return {};
  if (!endpoint.apiKey || !endpoint.baseUrl) return {};
  if (keyProviderMismatch(endpoint.providerId, endpoint.apiKey)) return {};

  const raw = await chatCompletion({
    endpoint,
    messages: [
      { role: 'system', content: OPTION_CHOICE_SYSTEM_PROMPT },
      { role: 'user', content: buildOptionChoicePrompt(batch) },
    ],
    // An answer is `"3": 2,` — eight tokens per dropdown, at most eight
    // dropdowns. The budget is an order of magnitude clear of that, because a
    // truncated reply is invalid JSON and loses the whole batch.
    maxTokens: 300,
    temperature: 0,
    json: true,
  });

  try {
    // Validated against the *filtered* batch, never the caller's list: an index
    // the caller offered but policy removed addresses a different dropdown here.
    return validateOptionChoices(JSON.parse(raw || '{}'), batch);
  } catch {
    return {};
  }
}

function detectLanguage(text?: string): string {
  if (!text) return 'English';
  const czechIndicators = /[áčďéěíňóřšťúůžÁČĎÉĚÍŇÓŘŠŤÚŮŽ]/;
  return czechIndicators.test(text) ? 'Czech' : 'English';
}

/**
 * Generate answers to open-ended job application questions. Returns an array of
 * answer strings aligned with the input questions array.
 */
export async function answerOpenQuestions(
  questions: string[],
  profile: Profile,
  jobInfo: JobInfo,
  endpoint: LlmEndpoint,
): Promise<string[]> {
  if (!endpoint.apiKey) {
    throw new GroqApiError('MISSING_KEY', apiErrorMessage('MISSING_KEY', endpoint.label));
  }
  if (questions.length === 0) return [];

  const language = detectLanguage(jobInfo.description ?? questions.join(' '));

  const systemPrompt = `You are a job application assistant. Answer each application question concisely and professionally in ${language}.
Respond ONLY with a JSON array of strings — one answer per question, in the same order.
Each answer should be 1–3 sentences. Tailor each answer to the applicant's experience and the role.`;

  const userPrompt = `Role: ${jobInfo.position ?? 'Software Engineer'}
Company: ${jobInfo.company ?? 'the company'}
Applicant profile: ${profile.about || `${profile.firstName} ${profile.lastName}`}

Questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Respond with a JSON array: ["answer to q1", "answer to q2", ...]`;

  const raw = await chatCompletion({
    endpoint,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 800,
    temperature: 0.6,
    json: true,
  });

  try {
    // json_object mode wraps arrays — handle both {"answers": [...]} and [...]
    const parsed: unknown = JSON.parse(raw || '[]');
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : extractAnswerArray(parsed as Record<string, unknown>);
    return questions.map((_, i) => (typeof arr[i] === 'string' ? (arr[i] as string) : ''));
  } catch {
    return questions.map(() => '');
  }
}

function extractAnswerArray(parsed: Record<string, unknown> | null): unknown[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const candidate = parsed.answers ?? parsed.responses;
  if (Array.isArray(candidate)) return candidate;
  return Object.values(parsed);
}
