import type { FillSummary, JobInfo, ApplicationEntry, RemoteSyncStatus } from './types';
// Type-only, so it is erased at compile time and creates no runtime cycle with
// `api/notion.ts` — which imports this file's error copy for real.
import type { NotionSchemaReport } from './api/notion';

// ─── Popup → Content ──────────────────────────────────────────────────────────

export type PopupToContentMessage =
  | { type: 'FILL_FORM'; profileId: string }
  | { type: 'EXTRACT_JOB_INFO' }
  | { type: 'FILL_COVER_TEXT'; text: string }
  | { type: 'FILL_ANSWERS'; answers: Record<string, string> };

/**
 * The envelope every popup/background → content message travels in. Requests are
 * broadcast to *all* frames of a tab (no `frameId`, hence no `webNavigation`
 * permission), so the reply must say which broadcast it answers — two `Fill`
 * clicks in a row would otherwise pour their results into one bucket. The caller
 * mints the id, the frame echoes it back untouched.
 */
export type FrameRequest = PopupToContentMessage & { requestId: string };

// ─── Content → Popup ──────────────────────────────────────────────────────────

export interface OpenQuestion {
  id: string;
  text: string;
}

export type ContentToPopupMessage =
  | { type: 'FILL_RESULT'; summary: FillSummary; openQuestions: OpenQuestion[] }
  | { type: 'JOB_INFO'; jobInfo: JobInfo };

/**
 * Discriminant of {@link FrameReplyMessage}. Namespaced because this travels on
 * the same `chrome.runtime.onMessage` bus as every other extension message.
 */
export const FRAME_REPLY = 'JOBFILL_FRAME_REPLY';

/**
 * A frame's answer to a {@link FrameRequest}.
 *
 * Sent with `chrome.runtime.sendMessage`, **not** `sendResponse`: Chrome hands
 * the sender of a broadcast only the *first* `sendResponse`, so on a page with
 * two form frames one of them was always dropped. The runtime bus lets every
 * frame report, and gives the caller `sender.frameId` — exactly what
 * `webNavigation.getAllFrames` used to provide.
 */
export interface FrameReplyMessage {
  type: typeof FRAME_REPLY;
  /** Echo of {@link FrameRequest.requestId}. */
  requestId: string;
  /** The frame's answer — whatever it would have passed to `sendResponse`. */
  payload: unknown;
}

// ─── Any → Background ────────────────────────────────────────────────────────

/**
 * `LOG_APPLICATION` carries *raw inputs*, not a ready `ApplicationEntry`: `id`,
 * `timestamp`, `status` and `remoteSync` are derived in the background worker
 * (`createApplicationEntry`), so no caller can write a malformed journal record.
 */
export type ToBackgroundMessage =
  | { type: 'GENERATE_COVER'; jobInfo: JobInfo; profileId: string }
  | { type: 'ANSWER_QUESTIONS'; questions: OpenQuestion[]; profileId: string; jobInfo: JobInfo }
  /**
   * `fingerprints` are the output of `serializeFingerprint`: the attribute-derived
   * identity of a control and nothing else — never profile data, never page text.
   * At most {@link MAX_CLASSIFY_FIELDS} entries; the sender caps, and the LLM
   * client caps again before the request leaves the browser.
   *
   * The answer carries *value templates*, not field types — see `CLASSIFY_RESULT`.
   */
  | { type: 'CLASSIFY_FIELDS'; fingerprints: string[] }
  /**
   * Read a Notion database's schema so Settings can tell the user which properties
   * are missing *before* an application fails to log. Routed through the worker
   * rather than called from the options page for two reasons: the worker is the
   * sole network egress point, and the schema cache in `api/notion.ts` is module
   * state — a check run on the page would warm the page's copy, never the
   * worker's, and so would prove nothing about the code that actually writes.
   */
  | { type: 'INSPECT_NOTION'; token: string; databaseId: string }
  /**
   * "Check key" for the LLM credentials, the counterpart of `INSPECT_NOTION` and
   * routed through the worker for the same reasons, plus one: the check must
   * exercise the very copy of `shared/api/groq.ts` that fills forms, otherwise a
   * green tick proves nothing about the path that actually fails.
   *
   * All four fields are what the user has *typed*, not what is stored — the check
   * has to answer "is the thing in my clipboard any good?" before it is saved, and
   * the options page says next to the result whether the checked values are the
   * saved ones (see `GroqCheck`). Omitting `provider` / `baseUrl` yields Groq and
   * its built-in URL: the behaviour that predates the provider setting.
   */
  | {
      type: 'CHECK_GROQ';
      apiKey: string;
      model: string;
      provider?: string;
      /** Only meaningful when `provider` is `custom`. */
      baseUrl?: string;
    }
  | { type: 'LOG_APPLICATION'; jobInfo?: JobInfo; profileId: string; url: string };

/**
 * Hard ceiling on how many fingerprints one classification request may carry.
 *
 * A large ATS form can enumerate 100+ controls, and the batch is one request with
 * one JSON answer, so the binding constraint is the *response* budget
 * (`max_tokens` in `planFieldTemplates`): an entry such as
 * `"12":"{firstName} {lastName}",` costs ≈ 17 tokens, putting 40 entries at
 * ≈ 700 against a 1200-token budget. A truncated reply is invalid JSON and loses
 * the *whole* batch, not one field. The cap also bounds egress per fill
 * (~1–2 k prompt tokens) and keeps the request inside the 15 s timeout. Fields
 * beyond it stay unrecognised — as if the feature were switched off.
 *
 * Lives in the wire contract because both ends enforce it: the content script
 * when it builds the batch, and `shared/api/groq.ts` at the egress point.
 */
export const MAX_CLASSIFY_FIELDS = 40;

// ─── Background → Any ────────────────────────────────────────────────────────

/**
 * Why an LLM call failed, in the words the user needs.
 *
 * `BAD_MODEL` and `BAD_REQUEST` exist because everything that was not a 401 or a
 * 429 used to collapse into `NETWORK_ERROR`: a decommissioned model, answered
 * with `400 {"error":{"code":"model_decommissioned"}}`, was reported as "could
 * not reach Groq. Check your connection." The user checked their connection.
 */
export type ApiErrorKind =
  | 'MISSING_KEY'
  | 'UNAUTHORIZED'
  /**
   * The key belongs to a different service — recognised by its prefix, locally,
   * before any request is made. Its own kind rather than an `UNAUTHORIZED`
   * variant because the key is valid, merely addressed to the wrong company:
   * checking it fixes nothing, the provider dropdown fixes everything.
   */
  | 'WRONG_PROVIDER'
  /** The model does not exist on this account, or is no longer served. */
  | 'BAD_MODEL'
  /** Groq understood the request and refused it for some other reason. */
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

/**
 * Result of `CHECK_GROQ`: what the key can do, and whether the configured model
 * is one of those things. The two facts are separate because they fail and are
 * fixed separately — a valid key with a retired model is the exact case that
 * produced "Groq API key is invalid or expired" for a perfectly good key.
 */
export interface GroqCheckReport {
  /** The checked key, masked (`gsk_…a1b2`), so the answer names its subject. */
  keyHint: string;
  /** Provider the check ran against, by name — "Groq", "OpenRouter", … */
  provider: string;
  /** Model that was probed — never empty; the provider default is filled in. */
  model: string;
  /** `true` when a one-token completion with {@link model} came back. */
  modelOk: boolean;
  /** UI copy for why the probe failed. Absent when {@link modelOk}. */
  modelProblem?: string;
  /** Kind behind {@link modelProblem} — separates "wrong model" from "unclear". */
  modelProblemKind?: ApiErrorKind;
  /**
   * Model ids to *offer*, alphabetical — not necessarily everything the endpoint
   * returned. Groq and OpenAI answer `GET /models` with what this key may use: a
   * short list, all of it worth rendering. OpenRouter answers with its entire
   * catalogue of several hundred ids, and several hundred pills is not a UI — so
   * for a catalogue-scoped provider the worker sends a *shortlist* related to the
   * model the user typed and sets {@link modelsAreCatalogue}.
   */
  models: string[];
  /** How many ids the endpoint actually reported. */
  modelCount: number;
  /** `true` when {@link models} is a shortlist out of a catalogue, not the whole answer. */
  modelsAreCatalogue?: boolean;
  /** Where to browse the full catalogue, when there is one. */
  modelsPageUrl?: string;
}

export type FromBackgroundMessage =
  | { type: 'GENERATION_RESULT'; text: string }
  | { type: 'ANSWERS_RESULT'; answers: Record<string, string> }
  /**
   * The model's answer: `"<fingerprint index>" → value template`.
   *
   * A template is a string of `{placeholder}` references to profile atoms
   * (`"{firstName} {lastName}"`), resolved in the page by
   * `shared/filler/valueTemplate.ts`. Neither a value nor a field-type name, and
   * both omissions are deliberate: a type name cannot say "this box wants the
   * first name and the surname", which is the case this path exists for; a value
   * would mean the model had been shown the profile. It sees atom *names* only.
   *
   * Note what this message cannot carry: a confidence. Everything filled from it
   * is amber (`LLM_FIELD_CONFIDENCE`), with no field through which the model
   * could ask for more.
   */
  | { type: 'CLASSIFY_RESULT'; templates: Record<string, string> }
  | {
      type: 'LOG_RESULT';
      /** `true` when the entry reached the local `chrome.storage.local` journal. */
      success: boolean;
      /** The entry as persisted — use `entry.id` to correlate, `entry.remoteSync` to render. */
      entry: ApplicationEntry;
      /** Remote-backend outcome at the time the response was sent. */
      remoteSync: RemoteSyncStatus;
      /** Human-readable note when the remote write is pending or failed. */
      message?: string;
    }
  | { type: 'NOTION_SCHEMA_RESULT'; report: NotionSchemaReport }
  | { type: 'NOTION_SCHEMA_ERROR'; kind: RemoteLogErrorKind; message: string }
  /** The key was accepted; `report.modelOk` says whether the model was too. */
  | { type: 'GROQ_CHECK_RESULT'; report: GroqCheckReport }
  /**
   * The key itself could not be used — nothing about the model is known.
   * `detail` is Groq's own `error.message`, carried apart from `message` so the
   * options page can rewrite the advice without losing the evidence.
   */
  | { type: 'GROQ_CHECK_ERROR'; kind: ApiErrorKind; message: string; detail?: string }
  | { type: 'API_ERROR'; kind: ApiErrorKind; message: string };

/** Narrow a background response by its discriminant, e.g. `BackgroundResponse<'LOG_RESULT'>`. */
export type BackgroundResponse<T extends FromBackgroundMessage['type']> = Extract<
  FromBackgroundMessage,
  { type: T }
>;

export type AnyMessage =
  | PopupToContentMessage
  | ContentToPopupMessage
  | FrameReplyMessage
  | ToBackgroundMessage
  | FromBackgroundMessage;

// ─── API error messages ───────────────────────────────────────────────────────

/**
 * Distinct, actionable copy for every LLM failure mode. Callers render
 * `API_ERROR.message`, which the background fills from here — raw exception text
 * must never reach the UI.
 *
 * `{provider}` is substituted with the configured provider's name. It used to be
 * the literal word "Groq" in seven sentences, which stopped being true the moment
 * the endpoint became selectable — and "Groq rejected this key" is exactly the
 * sentence that cost this extension's first user an hour on an OpenRouter key.
 */
const API_ERROR_TEMPLATES: Record<ApiErrorKind, string> = {
  MISSING_KEY:
    'The API key for {provider} is not configured. Add it in Settings and press “Save settings”.',
  UNAUTHORIZED:
    '{provider} rejected the API key. Open Settings and use “Check key” to see what {provider} says about it.',
  WRONG_PROVIDER:
    'The saved API key was issued by a different service than {provider}. Open Settings and either switch the provider or paste a {provider} key.',
  BAD_MODEL:
    '{provider} does not serve the model configured in Settings — it was renamed, retired, or belongs to a different provider. Open Settings and pick one from the list.',
  BAD_REQUEST: '{provider} rejected the request. Open Settings and check the model name.',
  RATE_LIMITED: '{provider} is rate-limiting this key. Please wait a moment and try again.',
  TIMEOUT: 'The request to {provider} timed out (15 s). Check your connection.',
  NETWORK_ERROR: 'Network error — could not reach {provider}. Check your connection.',
};

/** Stand-in when the caller has no provider to name. */
const SOME_PROVIDER = 'the AI provider';

/**
 * User-facing copy for `kind`, naming `provider` wherever the sentence refers to
 * it. The leading character is capitalised afterwards, so one template reads
 * correctly for both “Groq rejected…” and “The AI provider rejected…”.
 */
export function apiErrorMessage(kind: ApiErrorKind, provider = SOME_PROVIDER): string {
  const text = API_ERROR_TEMPLATES[kind].replace(/\{provider\}/g, provider);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The same copy with no provider to name — safe to render as-is. Kept as a map
 * because callers index it by kind; anything that *knows* the provider should
 * call {@link apiErrorMessage} instead.
 */
export const API_ERROR_MESSAGES: Record<ApiErrorKind, string> = Object.fromEntries(
  (Object.keys(API_ERROR_TEMPLATES) as ApiErrorKind[]).map((kind) => [kind, apiErrorMessage(kind)]),
) as Record<ApiErrorKind, string>;

// ─── Remote logging error messages ────────────────────────────────────────────

export type RemoteLogErrorKind =
  /** Backend selected in settings but its credentials are empty. */
  | 'NOT_CONFIGURED'
  /** Token rejected, or the integration has no access to the database/Web App. */
  | 'UNAUTHORIZED'
  /** Notion database is missing the properties we need, or types do not match. */
  | 'SCHEMA_MISMATCH'
  /** Database / Web App URL does not exist. */
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  /** Backend answered with something that is not the expected JSON. */
  | 'BAD_RESPONSE';

export const REMOTE_LOG_ERROR_MESSAGES: Record<RemoteLogErrorKind, string> = {
  NOT_CONFIGURED: 'Logging backend is selected but not configured. Finish setup in Settings.',
  UNAUTHORIZED:
    'The logging backend rejected the credentials. Check the token and that the target is shared with the integration.',
  SCHEMA_MISMATCH: 'The target database does not have the properties JobFill needs.',
  NOT_FOUND: 'The logging destination was not found. Check the database ID / Web App URL.',
  RATE_LIMITED: 'The logging backend is rate-limiting requests. JobFill will retry once.',
  TIMEOUT: 'The logging backend did not respond in time. JobFill will retry once.',
  NETWORK_ERROR: 'Could not reach the logging backend. The entry is saved locally.',
  BAD_RESPONSE: 'The logging backend returned an unexpected response.',
};
