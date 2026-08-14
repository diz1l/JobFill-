// ─── Domain types ────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  /** Display label, e.g. "Frontend", "QA" */
  label: string;
  firstName: string;
  lastName: string;
  email: string;
  /** E.164 format, default region +420 */
  phone: string;
  city: string;
  linkedin: string;
  github: string;
  website: string;
  salaryExpectation: string;
  availability: string;
  workPermit: string;
  about: string;
}

export interface CoverTemplate {
  id: string;
  label: string;
  /** Supports {company}, {position}, {source} placeholders */
  body: string;
}

/**
 * Remote-sync state of a single journal entry (FR-6.3).
 *
 * - `off`     — no remote backend configured; local copy only. Terminal.
 * - `pending` — queued for (or awaiting) the remote write. Not terminal.
 * - `ok`      — successfully mirrored to Notion / Sheets. Terminal.
 * - `failed`  — first attempt and the single retry both failed. Terminal.
 */
export type RemoteSyncStatus = 'ok' | 'pending' | 'failed' | 'off';

export interface ApplicationEntry {
  id: string;
  timestamp: string; // ISO 8601
  company: string;
  position: string;
  url: string;
  profileId: string;
  status: 'submitted';
  remoteSync: RemoteSyncStatus;
}

// ─── Storage shapes ───────────────────────────────────────────────────────────

/** Version of the `chrome.storage.sync` layout written by this build. */
export const SYNC_SCHEMA_VERSION = 1;

/** chrome.storage.sync — cross-device, ≤ 100 KB */
export interface SyncData {
  schemaVersion: typeof SYNC_SCHEMA_VERSION;
  profiles: Profile[];
  activeProfileId: string;
  coverTemplates: CoverTemplate[];
  settings: AppSettings;
}

export type LogBackend = 'notion' | 'sheets' | 'off';

export interface AppSettings {
  highlightDurationMs: number;
  logBackend: LogBackend;
  /**
   * FR-5.3 — opt-in LLM classification of the fields the heuristics could not
   * recognise. **Off by default and fail-closed**: nothing is sent to Groq
   * unless this is exactly `true` (see `normalizeSettings`). The request carries
   * field fingerprints only — never profile data (S-3).
   */
  llmFieldClassification: boolean;
}

/** chrome.storage.local — secrets + bulky data, never synced */
export interface LocalData {
  groqApiKey?: string;
  groqModel?: string;
  notionToken?: string;
  notionDatabaseId?: string;
  sheetsEndpoint?: string;
  applicationLog: ApplicationEntry[];
}

// ─── Field-matching types ─────────────────────────────────────────────────────

export type FieldConfidence = 'high' | 'medium' | 'low' | 'none';

/**
 * FR-5.3 — the confidence ceiling for a match that came from the language model.
 *
 * A model-derived match is *never* `high`. The form is submitted to an employer,
 * and a non-deterministic source may not write into it silently: everything the
 * classifier fills is highlighted amber ("check this") exactly like a heuristic
 * `medium` match.
 *
 * The ceiling is expressed in the type system rather than in the calling code:
 * `LlmFieldConfidence` has exactly one inhabitant, so `'high'` is not assignable
 * to it, and {@link LLM_FIELD_CONFIDENCE} is the only value any LLM code path
 * can hand to `highlightField`. There is no confidence *parameter* anywhere on
 * that path to override.
 */
export type LlmFieldConfidence = Extract<FieldConfidence, 'medium'>;

/** The single value {@link LlmFieldConfidence} admits. */
export const LLM_FIELD_CONFIDENCE: LlmFieldConfidence = 'medium';

export interface FieldMatch {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  fieldType: string;
  confidence: FieldConfidence;
  /** Resolved value from the active profile */
  value: string;
}

export interface FillSummary {
  total: number;
  high: number;
  medium: number;
  unrecognized: number;
  fileInputs: number;
  aiQuestions: number;  // open-ended fields that need AI
}

// ─── Job-info extraction ──────────────────────────────────────────────────────

export interface JobInfo {
  company?: string;
  position?: string;
  description?: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: AppSettings = {
  highlightDurationMs: 3000,
  logBackend: 'off',
  // FR-5.3 is opt-in: a fresh install never talks to Groq while filling.
  llmFieldClassification: false,
};

export const DEFAULT_SYNC_DATA: SyncData = {
  schemaVersion: SYNC_SCHEMA_VERSION,
  profiles: [],
  activeProfileId: '',
  coverTemplates: [],
  settings: DEFAULT_SETTINGS,
};

export const DEFAULT_LOCAL_DATA: Partial<LocalData> = {
  applicationLog: [],
};

export function createEmptyProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: crypto.randomUUID(),
    label: 'My Profile',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    city: '',
    linkedin: '',
    github: '',
    website: '',
    salaryExpectation: '',
    availability: '',
    workPermit: '',
    about: '',
    ...overrides,
  };
}

/** Upper bound for a single journal text field — keeps storage.local small. */
const MAX_ENTRY_TEXT = 200;
/** Upper bound for the stored URL. */
const MAX_ENTRY_URL = 2000;

function clipText(value: unknown, max = MAX_ENTRY_TEXT): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/**
 * Everything the caller (popup) has to know to log an application.
 * `id`, `timestamp`, `status` and `remoteSync` are derived — never supplied by UI.
 */
export interface NewApplicationInput {
  /** Job info extracted from the page. Missing fields degrade gracefully. */
  jobInfo?: JobInfo;
  /** Profile the form was filled with. */
  profileId: string;
  /** URL of the job posting (usually `tab.url`). */
  url: string;
}

/**
 * Build a journal entry (FR-6.1). Counterpart of {@link createEmptyProfile}.
 *
 * The background worker — never the UI — calls this, so a malformed message can
 * not put a broken record into `chrome.storage.local`.
 */
export function createApplicationEntry(
  input: NewApplicationInput,
  overrides: Partial<ApplicationEntry> = {},
): ApplicationEntry {
  const jobInfo = input?.jobInfo ?? {};
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    company: clipText(jobInfo.company),
    position: clipText(jobInfo.position),
    url: clipText(input?.url, MAX_ENTRY_URL),
    profileId: clipText(input?.profileId, 100),
    status: 'submitted',
    remoteSync: 'pending',
    ...overrides,
  };
}
