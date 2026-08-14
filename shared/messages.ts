import type { FillSummary, JobInfo, ApplicationEntry, RemoteSyncStatus } from './types';
// Type-only: erased at compile time, so this does not create a module cycle with
// `api/notion.ts`, which imports the error copy from this file at runtime.
import type { NotionSchemaReport } from './api/notion';

// ─── Popup → Content ──────────────────────────────────────────────────────────

export type PopupToContentMessage =
  | { type: 'FILL_FORM'; profileId: string }
  | { type: 'EXTRACT_JOB_INFO' }
  | { type: 'FILL_COVER_TEXT'; text: string }
  | { type: 'FILL_ANSWERS'; answers: Record<string, string> };

/**
 * P0-5 — the envelope every popup/background → content message travels in.
 *
 * The request is broadcast to *all* frames of a tab (no `frameId`, therefore no
 * `webNavigation` permission), so a reply has to say which broadcast it belongs
 * to: two `Fill` clicks in a row would otherwise pour their results into one
 * bucket. The caller mints the id, the frame echoes it back untouched.
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
 * It is sent with `chrome.runtime.sendMessage`, **not** `sendResponse`: Chrome
 * hands the sender of a broadcast only the *first* `sendResponse`, so on a page
 * with two form frames one of them was always dropped. Going through the runtime
 * bus lets every frame report, and gives the caller `sender.frameId` for free —
 * which is exactly the piece of information `webNavigation.getAllFrames` used to
 * provide.
 */
export interface FrameReplyMessage {
  type: typeof FRAME_REPLY;
  /** Echo of {@link FrameRequest.requestId}. */
  requestId: string;
  /** Whatever the frame would previously have passed to `sendResponse`. */
  payload: unknown;
}

// ─── Any → Background ────────────────────────────────────────────────────────

/**
 * `LOG_APPLICATION` deliberately carries *raw inputs*, not a ready
 * `ApplicationEntry`: `id`, `timestamp`, `status` and `remoteSync` are derived in
 * the background worker (see `createApplicationEntry`), so no caller can write a
 * malformed record into the journal.
 */
export type ToBackgroundMessage =
  | { type: 'GENERATE_COVER'; jobInfo: JobInfo; profileId: string }
  | { type: 'ANSWER_QUESTIONS'; questions: OpenQuestion[]; profileId: string; jobInfo: JobInfo }
  /**
   * FR-5.3 — `fingerprints` are the output of `serializeFingerprint`, i.e. the
   * attribute-derived identity of a control and nothing else (S-3). At most
   * {@link MAX_CLASSIFY_FIELDS} entries; the sender caps and the Groq client
   * caps again before the request leaves the browser.
   */
  | { type: 'CLASSIFY_FIELDS'; fingerprints: string[] }
  /**
   * P1-13 — read a Notion database's schema so Settings can tell the user which
   * properties are missing *before* an application fails to log. Routed through
   * the worker rather than called from the options page for two reasons: S-2,
   * and the schema cache in `api/notion.ts` is module state — a check run on the
   * page would warm the page's copy, never the worker's, and so would prove
   * nothing about the code that actually writes.
   */
  | { type: 'INSPECT_NOTION'; token: string; databaseId: string }
  | { type: 'LOG_APPLICATION'; jobInfo?: JobInfo; profileId: string; url: string };

/**
 * FR-5.3 — hard ceiling on how many fingerprints one classification request may
 * carry. A large ATS form can enumerate 100+ controls, and the batch is a single
 * request with a single JSON answer, so the binding constraint is the *response*
 * budget (`max_tokens: 500` in `classifyFields`): the reply is one flat map, and
 * a mapping entry such as `"12":"availability",` costs ≈ 9 tokens. 40 entries is
 * therefore ≈ 360 tokens — comfortably inside the budget, which matters because
 * a truncated reply is invalid JSON and loses the *whole* batch, not one field.
 *
 * It also bounds what leaves the browser per fill (~1–2 k prompt tokens) and
 * keeps the request inside the 15 s Groq timeout. Fields beyond the cap simply
 * stay unrecognised — the same outcome as having the feature switched off.
 *
 * Lives here, in the wire contract, because both ends enforce it: the content
 * script when it builds the batch and `shared/api/groq.ts` at the egress point.
 */
export const MAX_CLASSIFY_FIELDS = 40;

// ─── Background → Any ────────────────────────────────────────────────────────

export type ApiErrorKind =
  | 'MISSING_KEY'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

export type FromBackgroundMessage =
  | { type: 'GENERATION_RESULT'; text: string }
  | { type: 'ANSWERS_RESULT'; answers: Record<string, string> }
  | { type: 'CLASSIFY_RESULT'; classifications: Record<string, string> }
  | {
      type: 'LOG_RESULT';
      /** `true` when the entry reached `chrome.storage.local` (FR-6.3 local copy). */
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
  | { type: 'API_ERROR'; kind: ApiErrorKind; message: string };

/** Narrow a background response by its discriminant, e.g. `BackgroundResponse<'LOG_RESULT'>`. */
export type BackgroundResponse<T extends FromBackgroundMessage['type']> = Extract<
  FromBackgroundMessage,
  { type: T }
>;

// ─── Union ───────────────────────────────────────────────────────────────────

export type AnyMessage =
  | PopupToContentMessage
  | ContentToPopupMessage
  | FrameReplyMessage
  | ToBackgroundMessage
  | FromBackgroundMessage;

// ─── API error messages (FR-5.4) ──────────────────────────────────────────────

/**
 * Distinct, actionable copy for every Groq failure mode. Callers render
 * `API_ERROR.message`, which the background fills from this map — raw exception
 * text must never reach the UI.
 */
export const API_ERROR_MESSAGES: Record<ApiErrorKind, string> = {
  MISSING_KEY: 'Groq API key is not configured. Add it in Settings.',
  UNAUTHORIZED: 'Groq API key is invalid or expired.',
  RATE_LIMITED: 'Groq rate limit exceeded. Please wait a moment and try again.',
  TIMEOUT: 'Request to Groq timed out (15 s). Check your connection.',
  NETWORK_ERROR: 'Network error — could not reach Groq. Check your connection.',
};

// ─── Remote logging error messages (FR-6.2 / FR-6.3) ──────────────────────────

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
