// ─── Domain types ────────────────────────────────────────────────────────────

/**
 * The answers JobFill types into application forms.
 *
 * Every entry is a `string`, including the ones that look like other types: a
 * date of birth, a postal code and a number of years are all *what the user
 * typed*, and the re-spellings a form may want (`1990-03-15` → `15.03.1990`,
 * `5+ years` → `5`) are computed in `shared/filler/atoms.ts` instead of being
 * stored twice. A field left blank is a legitimate state and always means the
 * same thing everywhere: nothing is written and the control is reported as
 * missing data — never guessed.
 *
 * The breadth is the point. The first live run against a Workday form asked for
 * 18 entries and could answer 6; two of the rest were filled *wrongly*, because
 * the heuristics did not recognise "Legal Middle Name" / "Preferred Name", the
 * classifier was asked instead, and with no such entry in the profile the only
 * answers available to it were guesses. An entry that exists — even an empty one
 * — removes both the gap and the incentive to invent.
 */
export interface Profile {
  id: string;
  /** Display label, e.g. "Frontend", "QA" */
  label: string;

  // ── Name ────────────────────────────────────────────────────────────────────
  firstName: string;
  /** "Legal middle name". Blank for most Europeans, and blank is an answer. */
  middleName: string;
  lastName: string;
  /**
   * The name to be addressed by ("Preferred name", "Goes by").
   *
   * Never derived from {@link Profile.firstName}: an empty preferred name is not
   * evidence that the given name is the preferred one, and writing the given
   * name here is precisely the guess this field was added to stop.
   */
  preferredName: string;
  /** Jr., Sr., III, Ph.D. — a separate box on most US-authored forms. */
  nameSuffix: string;

  // ── Contact ─────────────────────────────────────────────────────────────────
  email: string;
  /** E.164 format, default region +420 */
  phone: string;
  linkedin: string;
  github: string;
  website: string;

  // ── Address ─────────────────────────────────────────────────────────────────
  addressLine1: string;
  /** Flat, floor, c/o — the second line ATS forms offer and rarely require. */
  addressLine2: string;
  city: string;
  /** "State / Province / County" — one box wherever a form asks at all. */
  state: string;
  postalCode: string;
  /** Full name or ISO-3166 alpha-2; `countryName` / `countryCode` re-spell it. */
  country: string;

  // ── Background ──────────────────────────────────────────────────────────────
  nationality: string;
  /**
   * ISO `yyyy-mm-dd`, which is what `<input type="date">` in settings stores.
   * The derived atoms re-spell it (`15.03.1990`, and separate day/month/year for
   * forms with three boxes); an unparsable value derives nothing at all.
   */
  dateOfBirth: string;
  workPermit: string;
  /** Highest level attained, from the ladder the settings page offers. */
  education: string;
  /** "ŘP skupiny B" — asked on a large share of Czech postings. */
  drivingLicence: string;
  /** Language to be contacted in, e.g. "English". */
  preferredLanguage: string;

  // ── Work ────────────────────────────────────────────────────────────────────
  currentTitle: string;
  currentEmployer: string;
  /** As written ("5", "5+", "3–5 years"); `experienceYears` digits it. */
  yearsOfExperience: string;
  salaryExpectation: string;
  availability: string;
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

/**
 * Version of the `chrome.storage.sync` layout written by this build.
 *
 * - **v1** — the original shape.
 * - **v2** — 16 further {@link Profile} entries (middle/preferred name and
 *   suffix, postal address, background, current role). Purely additive: every
 *   new entry is a string that a v1 profile was never asked for, so migrating is
 *   filling them in as empty. See `MIGRATIONS` in `shared/storage/validate.ts`.
 */
export const SYNC_SCHEMA_VERSION = 2;

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
    middleName: '',
    lastName: '',
    preferredName: '',
    nameSuffix: '',

    email: '',
    phone: '',
    linkedin: '',
    github: '',
    website: '',

    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',

    nationality: '',
    dateOfBirth: '',
    workPermit: '',
    education: '',
    drivingLicence: '',
    preferredLanguage: '',

    currentTitle: '',
    currentEmployer: '',
    yearsOfExperience: '',
    salaryExpectation: '',
    availability: '',
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
