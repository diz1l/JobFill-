import type { FillSummary, JobInfo, ApplicationEntry } from './types';

// ─── Popup → Content ──────────────────────────────────────────────────────────

export type PopupToContentMessage =
  | { type: 'FILL_FORM'; profileId: string }
  | { type: 'EXTRACT_JOB_INFO' }
  | { type: 'FILL_COVER_TEXT'; text: string }
  | { type: 'FILL_ANSWERS'; answers: Record<string, string> };

// ─── Content → Popup ──────────────────────────────────────────────────────────

export interface OpenQuestion {
  id: string;
  text: string;
}

export type ContentToPopupMessage =
  | { type: 'FILL_RESULT'; summary: FillSummary; openQuestions: OpenQuestion[] }
  | { type: 'JOB_INFO'; jobInfo: JobInfo };

// ─── Any → Background ────────────────────────────────────────────────────────

export type ToBackgroundMessage =
  | { type: 'GENERATE_COVER'; jobInfo: JobInfo; profileId: string }
  | { type: 'ANSWER_QUESTIONS'; questions: OpenQuestion[]; profileId: string; jobInfo: JobInfo }
  | { type: 'CLASSIFY_FIELDS'; fingerprints: string[] }
  | { type: 'LOG_APPLICATION'; entry: ApplicationEntry };

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
  | { type: 'LOG_RESULT'; success: boolean }
  | { type: 'API_ERROR'; kind: ApiErrorKind; message: string };

// ─── Union ───────────────────────────────────────────────────────────────────

export type AnyMessage =
  | PopupToContentMessage
  | ContentToPopupMessage
  | ToBackgroundMessage
  | FromBackgroundMessage;

// ─── API error messages ───────────────────────────────────────────────────────

export const API_ERROR_MESSAGES: Record<ApiErrorKind, string> = {
  MISSING_KEY: 'Groq API key is not configured. Add it in Settings.',
  UNAUTHORIZED: 'Groq API key is invalid or expired.',
  RATE_LIMITED: 'Groq rate limit exceeded. Please wait a moment and try again.',
  TIMEOUT: 'Request to Groq timed out (15 s). Check your connection.',
  NETWORK_ERROR: 'Network error — could not reach Groq. Check your connection.',
};
