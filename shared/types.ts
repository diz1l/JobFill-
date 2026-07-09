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

export interface ApplicationEntry {
  id: string;
  timestamp: string; // ISO 8601
  company: string;
  position: string;
  url: string;
  profileId: string;
  status: 'submitted';
  remoteSync: 'ok' | 'pending' | 'failed';
}

// ─── Storage shapes ───────────────────────────────────────────────────────────

/** chrome.storage.sync — cross-device, ≤ 100 KB */
export interface SyncData {
  schemaVersion: 1;
  profiles: Profile[];
  activeProfileId: string;
  coverTemplates: CoverTemplate[];
  settings: AppSettings;
}

export interface AppSettings {
  highlightDurationMs: number;
  logBackend: 'notion' | 'sheets' | 'off';
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
};

export const DEFAULT_SYNC_DATA: SyncData = {
  schemaVersion: 1,
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
