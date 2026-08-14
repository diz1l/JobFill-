import type { JobInfo, Profile } from '../types';
import { API_ERROR_MESSAGES, MAX_CLASSIFY_FIELDS, type ApiErrorKind } from '../messages';
import { httpJson, HttpError } from './http';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 15_000;

export class GroqApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
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
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Ask Groq for `response_format: json_object`. */
  json?: boolean;
}

/** Map a transport failure onto the five FR-5.4 error states. */
function toGroqError(err: unknown): GroqApiError {
  if (err instanceof GroqApiError) return err;

  if (err instanceof HttpError) {
    let kind: ApiErrorKind;
    switch (err.kind) {
      case 'TIMEOUT':
        kind = 'TIMEOUT';
        break;
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
        kind = 'UNAUTHORIZED';
        break;
      case 'RATE_LIMITED':
        kind = 'RATE_LIMITED';
        break;
      default:
        kind = 'NETWORK_ERROR';
    }
    return new GroqApiError(kind, API_ERROR_MESSAGES[kind]);
  }

  return new GroqApiError('NETWORK_ERROR', API_ERROR_MESSAGES.NETWORK_ERROR);
}

/**
 * The one place that talks to Groq. Every public function below is a prompt
 * plus a parser on top of this call — timeout, auth and status handling are not
 * duplicated anywhere.
 */
async function chatCompletion(req: ChatRequest): Promise<string> {
  if (!req.apiKey) {
    throw new GroqApiError('MISSING_KEY', API_ERROR_MESSAGES.MISSING_KEY);
  }

  try {
    const data = await httpJson<GroqResponse>(GROQ_API_URL, {
      service: 'Groq',
      method: 'POST',
      timeoutMs: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    return data.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    throw toGroqError(err);
  }
}

export async function generateMotivation(
  jobInfo: JobInfo,
  profile: Profile,
  apiKey: string,
  model: string,
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
    apiKey,
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 300,
    temperature: 0.7,
  });
}

/** Field types the classifier is allowed to return (FR-5.3 schema). */
export const CLASSIFIABLE_FIELD_TYPES = [
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'linkedin',
  'github',
  'website',
  'salary',
  'city',
  'coverLetter',
  'availability',
  'workPermit',
  'about',
  'unknown',
] as const;

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(CLASSIFIABLE_FIELD_TYPES);

/**
 * Validate the model's JSON against the FR-5.3 schema: keys must be indices of
 * the submitted fingerprints, values must be known field types. Anything else is
 * dropped, so a hallucinated response leaves fields unclassified instead of
 * mislabelling them.
 */
export function validateClassification(
  raw: unknown,
  fingerprintCount: number,
): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= fingerprintCount) continue;
    if (typeof value !== 'string') continue;
    if (!FIELD_TYPE_SET.has(value)) continue;
    if (value === 'unknown') continue;
    out[String(index)] = value;
  }
  return out;
}

/**
 * Classify field fingerprints via LLM — optional feature flag (FR-5.3).
 * Sends only serialized fingerprint strings — no user data (S-3).
 *
 * This is the egress point, so the {@link MAX_CLASSIFY_FIELDS} cap is applied
 * here as well as at the call site: a caller that ignores it cannot make this
 * function put a hundred fields on the wire, and the indices the model answers
 * with are validated against the *truncated* batch, never the original one.
 *
 * Returns a map of `"<fingerprint index>" → field type`; unclassifiable or
 * schema-violating entries are simply absent.
 */
export async function classifyFields(
  fingerprints: string[],
  apiKey: string,
  model: string,
): Promise<Record<string, string>> {
  const batch = fingerprints.slice(0, MAX_CLASSIFY_FIELDS);
  if (batch.length === 0) return {};

  const prompt = `You are a JSON API. Classify each HTML form field fingerprint by type.
Field types: ${CLASSIFIABLE_FIELD_TYPES.join(', ')}.
Respond ONLY with a JSON object mapping each fingerprint index to its type.

Fingerprints:
${batch.map((f, i) => `${i}: "${f}"`).join('\n')}`;

  const raw = await chatCompletion({
    apiKey,
    model,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 500,
    temperature: 0,
    json: true,
  });

  try {
    return validateClassification(JSON.parse(raw || '{}'), batch.length);
  } catch {
    // Invalid JSON → fields remain unclassified (FR-5.3)
    return {};
  }
}

function detectLanguage(text?: string): string {
  if (!text) return 'English';
  const czechIndicators = /[áčďéěíňóřšťúůžÁČĎÉĚÍŇÓŘŠŤÚŮŽ]/;
  return czechIndicators.test(text) ? 'Czech' : 'English';
}

/**
 * Generate answers to open-ended job application questions (FR-5.2 extension).
 * Returns an array of answer strings aligned with the input questions array.
 */
export async function answerOpenQuestions(
  questions: string[],
  profile: Profile,
  jobInfo: JobInfo,
  apiKey: string,
  model: string,
): Promise<string[]> {
  if (!apiKey) throw new GroqApiError('MISSING_KEY', API_ERROR_MESSAGES.MISSING_KEY);
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
    apiKey,
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 800,
    temperature: 0.6,
    json: true,
  });

  try {
    // Groq json_object mode wraps arrays — handle both {"answers": [...]} and [...]
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
