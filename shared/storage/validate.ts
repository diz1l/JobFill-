import type { AppSettings, CoverTemplate, LogBackend, Profile, SyncData } from '../types';
import { DEFAULT_SETTINGS, SYNC_SCHEMA_VERSION } from '../types';

/**
 * Hand-written schema validation for everything that enters `chrome.storage.sync`;
 * a validator library would cost more bundle than the rules it checks.
 *
 * **strict** (`importSyncData`) rejects a structurally broken file with a message
 * naming the offending path. **lenient** (storage reads, legacy-blob migration)
 * repairs everything to a usable shape — refusing to boot is never an option.
 */

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  /** JSON-ish path of the problem, e.g. `profiles[2].email`. */
  path: string;
  message: string;
  severity: IssueSeverity;
}

export class SyncValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    const lines = issues
      .filter((i) => i.severity === 'error')
      .map((i) => `• ${i.path}: ${i.message}`);
    super(`This file is not a valid JobFill backup:\n${lines.join('\n')}`);
    this.name = 'SyncValidationError';
  }
}

export interface NormalizeResult {
  data: SyncData;
  issues: ValidationIssue[];
}

// ─── Migrations ───────────────────────────────────────────────────────────────

type RawObject = Record<string, unknown>;
type Migration = (data: RawObject) => RawObject;

/**
 * Keyed by the version being migrated *from*. To introduce schema v2:
 *   1. bump `SYNC_SCHEMA_VERSION` in `shared/types.ts` and update `SyncData`;
 *   2. add `1: (d) => ({ ...d, schemaVersion: 2, /* new fields *\/ })` below.
 * Everything else — storage reads, import, the legacy-blob path — picks it up.
 */
const MIGRATIONS: Record<number, Migration> = {};

function migrate(raw: RawObject, issues: ValidationIssue[]): RawObject {
  let data = raw;
  let version = typeof data.schemaVersion === 'number' ? data.schemaVersion : NaN;

  if (!Number.isInteger(version) || version < 1) {
    issues.push({
      path: 'schemaVersion',
      message: `expected an integer ≥ 1, got ${describe(data.schemaVersion)}`,
      severity: 'error',
    });
    return { ...data, schemaVersion: SYNC_SCHEMA_VERSION };
  }

  if (version > SYNC_SCHEMA_VERSION) {
    issues.push({
      path: 'schemaVersion',
      message: `file was written by a newer version of JobFill (v${version}; this build understands v${SYNC_SCHEMA_VERSION}). Update the extension first.`,
      severity: 'error',
    });
    return data;
  }

  while (version < SYNC_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      issues.push({
        path: 'schemaVersion',
        message: `no migration from v${version} to v${SYNC_SCHEMA_VERSION}`,
        severity: 'error',
      });
      break;
    }
    data = step(data);
    const next = typeof data.schemaVersion === 'number' ? data.schemaVersion : version + 1;
    /* istanbul ignore next — guards a buggy migration, not user input */
    if (next <= version) break;
    version = next;
  }

  return data;
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept strings; coerce finite numbers/booleans; anything else is a warning. */
function readString(
  source: RawObject,
  key: string,
  path: string,
  issues: ValidationIssue[],
  fallback = '',
): string {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  issues.push({
    path: `${path}.${key}`,
    message: `expected a string, got ${describe(value)} — field cleared`,
    severity: 'warning',
  });
  return fallback;
}

function readArray(source: RawObject, key: string, issues: ValidationIssue[]): unknown[] {
  const value = source[key];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  issues.push({
    path: key,
    message: `expected an array, got ${describe(value)}`,
    severity: 'error',
  });
  return [];
}

// ─── Entities ─────────────────────────────────────────────────────────────────

/** Whitelist — unknown keys are dropped so junk never eats the sync quota. */
const PROFILE_FIELDS = [
  'label',
  'firstName',
  'lastName',
  'email',
  'phone',
  'city',
  'linkedin',
  'github',
  'website',
  'salaryExpectation',
  'availability',
  'workPermit',
  'about',
] as const;

export function normalizeProfile(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): Profile | null {
  if (!isObject(raw)) {
    issues.push({
      path,
      message: `expected a profile object, got ${describe(raw)} — entry skipped`,
      severity: 'warning',
    });
    return null;
  }

  const profile = { id: readString(raw, 'id', path, issues) } as Profile;
  if (!profile.id) profile.id = crypto.randomUUID();

  for (const field of PROFILE_FIELDS) {
    profile[field] = readString(raw, field, path, issues);
  }
  if (!profile.label) profile.label = 'Imported profile';

  return profile;
}

export function normalizeTemplate(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): CoverTemplate | null {
  if (!isObject(raw)) {
    issues.push({
      path,
      message: `expected a template object, got ${describe(raw)} — entry skipped`,
      severity: 'warning',
    });
    return null;
  }

  const id = readString(raw, 'id', path, issues) || crypto.randomUUID();
  const label = readString(raw, 'label', path, issues) || 'Imported template';
  const body = readString(raw, 'body', path, issues);
  return { id, label, body };
}

const LOG_BACKENDS: readonly LogBackend[] = ['notion', 'sheets', 'off'];

export function normalizeSettings(raw: unknown, issues: ValidationIssue[]): AppSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_SETTINGS };
  if (!isObject(raw)) {
    issues.push({
      path: 'settings',
      message: `expected an object, got ${describe(raw)}`,
      severity: 'error',
    });
    return { ...DEFAULT_SETTINGS };
  }

  let highlightDurationMs = DEFAULT_SETTINGS.highlightDurationMs;
  const rawDuration = raw.highlightDurationMs;
  if (typeof rawDuration === 'number' && Number.isFinite(rawDuration)) {
    highlightDurationMs = Math.min(60_000, Math.max(0, Math.round(rawDuration)));
  } else if (rawDuration !== undefined) {
    issues.push({
      path: 'settings.highlightDurationMs',
      message: `expected a number, got ${describe(rawDuration)} — default used`,
      severity: 'warning',
    });
  }

  let logBackend = DEFAULT_SETTINGS.logBackend;
  const rawBackend = raw.logBackend;
  if (typeof rawBackend === 'string' && (LOG_BACKENDS as string[]).includes(rawBackend)) {
    logBackend = rawBackend as LogBackend;
  } else if (rawBackend !== undefined) {
    issues.push({
      path: 'settings.logBackend',
      message: `expected one of ${LOG_BACKENDS.join(' | ')}, got ${describe(rawBackend)} — logging disabled`,
      severity: 'warning',
    });
  }

  // Fail-closed on purpose: this flag is the only thing standing between a fill
  // and a network request, so anything that is not the boolean `true` — a string
  // "true", a 1, a missing key, a corrupted item — leaves the feature off.
  let llmFieldClassification = DEFAULT_SETTINGS.llmFieldClassification;
  const rawClassification = raw.llmFieldClassification;
  if (typeof rawClassification === 'boolean') {
    llmFieldClassification = rawClassification;
  } else if (rawClassification !== undefined) {
    issues.push({
      path: 'settings.llmFieldClassification',
      message: `expected a boolean, got ${describe(rawClassification)} — AI field classification left off`,
      severity: 'warning',
    });
  }

  return { highlightDurationMs, logBackend, llmFieldClassification };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export interface NormalizeOptions {
  /** Reject instead of repair on structural errors. Used by import. */
  strict?: boolean;
}

/**
 * Validate + migrate an arbitrary value into a `SyncData`.
 * In strict mode throws {@link SyncValidationError} if any `error`-level issue
 * was found; warnings are always returned for the caller to surface.
 */
export function normalizeSyncData(raw: unknown, options: NormalizeOptions = {}): NormalizeResult {
  const issues: ValidationIssue[] = [];

  if (!isObject(raw)) {
    issues.push({
      path: '(root)',
      message: `expected a JobFill export object, got ${describe(raw)}`,
      severity: 'error',
    });
    if (options.strict) throw new SyncValidationError(issues);
    return { data: emptySyncData(), issues };
  }

  const migrated = migrate(raw, issues);

  const profiles: Profile[] = [];
  readArray(migrated, 'profiles', issues).forEach((item, i) => {
    const profile = normalizeProfile(item, `profiles[${i}]`, issues);
    if (profile) profiles.push(profile);
  });

  const coverTemplates: CoverTemplate[] = [];
  readArray(migrated, 'coverTemplates', issues).forEach((item, i) => {
    const template = normalizeTemplate(item, `coverTemplates[${i}]`, issues);
    if (template) coverTemplates.push(template);
  });

  const settings = normalizeSettings(migrated.settings, issues);

  let activeProfileId = '';
  const rawActive = migrated.activeProfileId;
  if (typeof rawActive === 'string') {
    activeProfileId = rawActive;
  } else if (rawActive !== undefined && rawActive !== null) {
    issues.push({
      path: 'activeProfileId',
      message: `expected a string, got ${describe(rawActive)}`,
      severity: 'warning',
    });
  }
  if (!profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId = profiles[0]?.id ?? '';
  }

  if (options.strict && issues.some((i) => i.severity === 'error')) {
    throw new SyncValidationError(issues);
  }

  return {
    data: {
      schemaVersion: SYNC_SCHEMA_VERSION,
      profiles,
      activeProfileId,
      coverTemplates,
      settings,
    },
    issues,
  };
}

export function emptySyncData(): SyncData {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    profiles: [],
    activeProfileId: '',
    coverTemplates: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}
