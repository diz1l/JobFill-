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
 * Remote-sync state of a single journal entry.
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
   * Opt-in LLM classification of the fields the heuristics could not recognise.
   * **Off by default and fail-closed**: nothing is sent unless this is exactly
   * `true` (see `normalizeSettings`). The request carries field fingerprints
   * only — never profile data.
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
 * The confidence ceiling for a match that came from the language model.
 *
 * A model-derived match is *never* `high`. The form is submitted to an employer,
 * and a non-deterministic source may not write into it silently: everything the
 * classifier fills is highlighted amber ("check this") exactly like a heuristic
 * `medium` match.
 *
 * The ceiling lives in the type system rather than in calling code:
 * `LlmFieldConfidence` has exactly one inhabitant, so `'high'` is not assignable
 * to it, and {@link LLM_FIELD_CONFIDENCE} is the only value any LLM path can
 * hand to `highlightField`. There is no confidence *parameter* there to override.
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
  /**
   * Controls the heuristics could not name at all. **Not** the same thing as
   * {@link FillSummary.noData} — see there.
   */
  unrecognized: number;
  fileInputs: number;
  aiQuestions: number;  // open-ended fields that need AI

  /**
   * Fields whose type we *did* recognise and had nothing to write into: the
   * profile entry is blank, or — for the cover letter — no template exists yet.
   * Separate from `unrecognized` because "we did not understand this field" and
   * "we understood it and have no data for you" lead to different actions; folded
   * together, a first-run install looked identical to a page of opaque controls.
   *
   * Optional on purpose: a `FillSummary` travels over the message bus, and a
   * reply from an older build omits it. Read it as `summary.noData ?? 0`.
   */
  noData?: number;

  /**
   * The distinct field types behind {@link FillSummary.noData}, in page order
   * (`'coverLetter'`, `'phone'`, …). `noData` counts *controls*, this lists
   * *kinds*, so two blank phone boxes are `noData: 2` / one entry here.
   *
   * Turn it into a sentence with `describeMissingData()` from
   * `shared/filler/missingData` — a DOM-free leaf module the popup can import.
   */
  missingFields?: string[];
}

/**
 * What `fillPage()` actually returns: every optional counter present. The
 * optionality on {@link FillSummary} is for summaries that arrived from
 * somewhere else, and code that just produced one should not `?? 0` its own
 * output.
 */
export type CompleteFillSummary = Required<FillSummary>;

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
  // Opt-in: a fresh install never talks to an LLM while filling.
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
 * Build a journal entry. Counterpart of {@link createEmptyProfile}.
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
