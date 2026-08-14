import type { SyncData, Profile, CoverTemplate, AppSettings } from '../types';
import { DEFAULT_SETTINGS, SYNC_SCHEMA_VERSION } from '../types';
import {
  emptySyncData,
  normalizeProfile,
  normalizeSettings,
  normalizeSyncData,
  normalizeTemplate,
  SyncValidationError,
  type ValidationIssue,
} from './validate';

/**
 * `chrome.storage.sync` access layer.
 *
 * ## Why one key per entity (P1-8)
 *
 * The previous layout kept the entire `SyncData` in a single item and every
 * write was read-all → merge → write-all. Two contexts (popup + options) writing
 * at the same time silently dropped one of the changes, and — less obviously —
 * the whole profile set had to fit into `QUOTA_BYTES_PER_ITEM` (8 KB), not the
 * 100 KB the spec assumes.
 *
 * Now each profile and each template owns its own key, with a separate key
 * holding the display order:
 *
 * ```
 * jobfill.schemaVersion    number
 * jobfill.profileIds       string[]      order only
 * jobfill.profile.<id>     Profile
 * jobfill.activeProfileId  string
 * jobfill.templateIds      string[]
 * jobfill.template.<id>    CoverTemplate
 * jobfill.settings         AppSettings
 * ```
 *
 * Consequences:
 *  - the popup switching the active profile and the options page editing a
 *    profile now touch disjoint keys — they cannot clobber each other;
 *  - editing two different profiles concurrently is safe; editing the *same*
 *    profile resolves to last-write-wins, which is the semantically correct
 *    outcome (chrome.storage offers no compare-and-swap primitive, so a true
 *    transaction is not available at any price);
 *  - writes inside one context are additionally serialised through a promise
 *    queue, so `await`-less callers cannot interleave a read-modify-write;
 *  - per-item quota now applies per profile instead of to the whole dataset.
 */

const PREFIX = 'jobfill.';
const K = {
  schemaVersion: `${PREFIX}schemaVersion`,
  profileIds: `${PREFIX}profileIds`,
  activeProfileId: `${PREFIX}activeProfileId`,
  templateIds: `${PREFIX}templateIds`,
  settings: `${PREFIX}settings`,
} as const;

const PROFILE_PREFIX = `${PREFIX}profile.`;
const TEMPLATE_PREFIX = `${PREFIX}template.`;

/** Pre-v1.1 single-blob key, migrated away on first access. */
const LEGACY_KEY = 'jobfill_sync';

const profileKey = (id: string) => `${PROFILE_PREFIX}${id}`;
const templateKey = (id: string) => `${TEMPLATE_PREFIX}${id}`;

// ─── Write serialisation ──────────────────────────────────────────────────────

/**
 * Serialises mutations *within this JavaScript context*. Cross-context safety
 * comes from the key layout above, not from this queue.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = writeChain.then(op, op);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

let migrationPromise: Promise<void> | null = null;

async function runLegacyMigration(): Promise<void> {
  const all = await chrome.storage.sync.get(null);
  const legacy = all[LEGACY_KEY];
  if (legacy === undefined) return;

  // Lenient: a corrupted legacy blob must not brick the extension.
  const { data } = normalizeSyncData(legacy);
  const alreadySplit = all[K.profileIds] !== undefined;
  if (!alreadySplit) await writeWholeDataset(data);
  await chrome.storage.sync.remove(LEGACY_KEY);
}

function ensureMigrated(): Promise<void> {
  const pending =
    migrationPromise ??
    runLegacyMigration().catch((err) => {
      // Allow a later call to retry instead of caching the failure forever.
      migrationPromise = null;
      throw err;
    });
  migrationPromise = pending;
  return pending;
}

// ─── Raw read/write ───────────────────────────────────────────────────────────

function collect<T>(
  all: Record<string, unknown>,
  ids: unknown,
  keyOf: (id: string) => string,
  normalize: (raw: unknown, path: string, issues: ValidationIssue[]) => T | null,
  path: string,
): T[] {
  const list = Array.isArray(ids) ? ids : [];
  const out: T[] = [];
  const issues: ValidationIssue[] = [];
  list.forEach((id, i) => {
    if (typeof id !== 'string') return;
    const item = normalize(all[keyOf(id)], `${path}[${i}]`, issues);
    if (item) out.push(item);
  });
  return out;
}

async function readAll(): Promise<SyncData> {
  await ensureMigrated();
  const all = await chrome.storage.sync.get(null);

  const profiles = collect(all, all[K.profileIds], profileKey, normalizeProfile, 'profiles');
  const coverTemplates = collect(
    all,
    all[K.templateIds],
    templateKey,
    normalizeTemplate,
    'coverTemplates',
  );

  const settings = normalizeSettings(all[K.settings], []);
  const activeRaw = all[K.activeProfileId];
  const activeProfileId = typeof activeRaw === 'string' ? activeRaw : '';

  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    profiles,
    activeProfileId: profiles.some((p) => p.id === activeProfileId)
      ? activeProfileId
      : (profiles[0]?.id ?? ''),
    coverTemplates,
    settings,
  };
}

/** Replace the entire dataset (import / legacy migration). Not incremental. */
async function writeWholeDataset(data: SyncData): Promise<void> {
  const all = await chrome.storage.sync.get(null);
  const stale = Object.keys(all).filter(
    (k) => k.startsWith(PROFILE_PREFIX) || k.startsWith(TEMPLATE_PREFIX),
  );
  if (stale.length) await chrome.storage.sync.remove(stale);

  const payload: Record<string, unknown> = {
    [K.schemaVersion]: SYNC_SCHEMA_VERSION,
    [K.profileIds]: data.profiles.map((p) => p.id),
    [K.activeProfileId]: data.activeProfileId,
    [K.templateIds]: data.coverTemplates.map((t) => t.id),
    [K.settings]: data.settings,
  };
  for (const profile of data.profiles) payload[profileKey(profile.id)] = profile;
  for (const template of data.coverTemplates) payload[templateKey(template.id)] = template;

  await chrome.storage.sync.set(payload);
}

/** Shallow value comparison — avoids burning sync write quota on no-op saves. */
function unchanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Full snapshot ────────────────────────────────────────────────────────────

/** Everything in one object — used by the export path and by content scripts. */
export async function getSyncSnapshot(): Promise<SyncData> {
  return readAll();
}

// ─── Profiles ────────────────────────────────────────────────────────────────

export async function getProfiles(): Promise<Profile[]> {
  return (await readAll()).profiles;
}

/**
 * Persist a full profile list (order included). Only the entries that actually
 * changed are written, so a save from the options page does not touch profiles
 * the user did not edit.
 */
export async function saveProfiles(profiles: Profile[]): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    const all = await chrome.storage.sync.get(null);
    const nextIds = profiles.map((p) => p.id);
    const prevIds = Array.isArray(all[K.profileIds]) ? (all[K.profileIds] as string[]) : [];

    const payload: Record<string, unknown> = {};
    for (const profile of profiles) {
      if (!unchanged(all[profileKey(profile.id)], profile)) {
        payload[profileKey(profile.id)] = profile;
      }
    }
    if (!unchanged(prevIds, nextIds)) payload[K.profileIds] = nextIds;

    const removed = prevIds.filter((id) => !nextIds.includes(id));

    // Keep the active pointer valid when the active profile disappears.
    const active = all[K.activeProfileId];
    if (typeof active === 'string' && removed.includes(active)) {
      payload[K.activeProfileId] = nextIds[0] ?? '';
    }

    if (Object.keys(payload).length) await chrome.storage.sync.set(payload);
    if (removed.length) await chrome.storage.sync.remove(removed.map(profileKey));
  });
}

export async function getActiveProfileId(): Promise<string> {
  return (await readAll()).activeProfileId;
}

export async function setActiveProfileId(id: string): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    await chrome.storage.sync.set({ [K.activeProfileId]: id });
  });
}

export async function getActiveProfile(): Promise<Profile | undefined> {
  const { profiles, activeProfileId } = await readAll();
  return profiles.find((p) => p.id === activeProfileId);
}

/**
 * Preferred way to change one profile: writes a single key, so it cannot lose a
 * concurrent edit made to a different profile in another extension page.
 */
export async function upsertProfile(profile: Profile): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    const stored = await chrome.storage.sync.get([K.profileIds, profileKey(profile.id)]);
    const ids = Array.isArray(stored[K.profileIds]) ? (stored[K.profileIds] as string[]) : [];

    const payload: Record<string, unknown> = {};
    if (!unchanged(stored[profileKey(profile.id)], profile)) {
      payload[profileKey(profile.id)] = profile;
    }
    if (!ids.includes(profile.id)) payload[K.profileIds] = [...ids, profile.id];

    if (Object.keys(payload).length) await chrome.storage.sync.set(payload);
  });
}

/** Counterpart of {@link upsertProfile}; also repairs `activeProfileId`. */
export async function deleteProfile(id: string): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    const stored = await chrome.storage.sync.get([K.profileIds, K.activeProfileId]);
    const ids = Array.isArray(stored[K.profileIds]) ? (stored[K.profileIds] as string[]) : [];
    const nextIds = ids.filter((x) => x !== id);

    const payload: Record<string, unknown> = { [K.profileIds]: nextIds };
    if (stored[K.activeProfileId] === id) payload[K.activeProfileId] = nextIds[0] ?? '';

    await chrome.storage.sync.set(payload);
    await chrome.storage.sync.remove(profileKey(id));
  });
}

// ─── Cover templates ──────────────────────────────────────────────────────────

export async function getCoverTemplates(): Promise<CoverTemplate[]> {
  return (await readAll()).coverTemplates;
}

export async function saveCoverTemplates(templates: CoverTemplate[]): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    const all = await chrome.storage.sync.get(null);
    const nextIds = templates.map((t) => t.id);
    const prevIds = Array.isArray(all[K.templateIds]) ? (all[K.templateIds] as string[]) : [];

    const payload: Record<string, unknown> = {};
    for (const template of templates) {
      if (!unchanged(all[templateKey(template.id)], template)) {
        payload[templateKey(template.id)] = template;
      }
    }
    if (!unchanged(prevIds, nextIds)) payload[K.templateIds] = nextIds;

    const removed = prevIds.filter((id) => !nextIds.includes(id));
    if (Object.keys(payload).length) await chrome.storage.sync.set(payload);
    if (removed.length) await chrome.storage.sync.remove(removed.map(templateKey));
  });
}

export async function upsertCoverTemplate(template: CoverTemplate): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    const stored = await chrome.storage.sync.get([K.templateIds, templateKey(template.id)]);
    const ids = Array.isArray(stored[K.templateIds]) ? (stored[K.templateIds] as string[]) : [];

    const payload: Record<string, unknown> = {};
    if (!unchanged(stored[templateKey(template.id)], template)) {
      payload[templateKey(template.id)] = template;
    }
    if (!ids.includes(template.id)) payload[K.templateIds] = [...ids, template.id];

    if (Object.keys(payload).length) await chrome.storage.sync.set(payload);
  });
}

export async function deleteCoverTemplate(id: string): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    const stored = await chrome.storage.sync.get(K.templateIds);
    const ids = Array.isArray(stored[K.templateIds]) ? (stored[K.templateIds] as string[]) : [];
    await chrome.storage.sync.set({ [K.templateIds]: ids.filter((x) => x !== id) });
    await chrome.storage.sync.remove(templateKey(id));
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * Both accessors below run every value through `normalizeSettings`, which is
 * also what makes the FR-5.3 opt-in (`settings.llmFieldClassification`) safe:
 * the flag is `false` unless the stored item holds a literal boolean `true`, so
 * a corrupted or hand-edited sync item can not switch network egress on. Read it
 * with {@link getSettings}, write it with `saveSettings({ llmFieldClassification })`
 * — there is deliberately no dedicated setter that could bypass the validator.
 */
export async function getSettings(): Promise<AppSettings> {
  await ensureMigrated();
  const stored = await chrome.storage.sync.get(K.settings);
  return normalizeSettings(stored[K.settings], []);
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  await enqueue(async () => {
    await ensureMigrated();
    const stored = await chrome.storage.sync.get(K.settings);
    const current = normalizeSettings(stored[K.settings], []);
    await chrome.storage.sync.set({
      [K.settings]: normalizeSettings({ ...current, ...settings }, []),
    });
  });
}

// ─── Quota (FR-1.2) ───────────────────────────────────────────────────────────

/** Warn the user at this fill level, as required by FR-1.2. */
export const SYNC_QUOTA_WARN_PERCENT = 80;

const FALLBACK_QUOTA_BYTES = 102_400;

export interface SyncStorageUsage {
  bytes: number;
  quotaBytes: number;
  /** 0–100, rounded. */
  percent: number;
  /** `true` once the FR-1.2 threshold is reached — render the warning. */
  warn: boolean;
}

/**
 * Current `chrome.storage.sync` utilisation.
 * Callers should render a warning while `warn === true` (FR-1.2).
 */
export async function getStorageUsage(): Promise<SyncStorageUsage> {
  const quotaBytes = chrome.storage.sync.QUOTA_BYTES ?? FALLBACK_QUOTA_BYTES;
  let bytes = 0;
  try {
    bytes = await chrome.storage.sync.getBytesInUse(null);
  } catch {
    bytes = 0;
  }
  const percent = quotaBytes > 0 ? Math.round((bytes / quotaBytes) * 100) : 0;
  return { bytes, quotaBytes, percent, warn: percent >= SYNC_QUOTA_WARN_PERCENT };
}

/** Convenience wrapper kept for existing callers. */
export async function getStorageUsagePercent(): Promise<number> {
  return (await getStorageUsage()).percent;
}

// ─── Export / Import (FR-1.4) ─────────────────────────────────────────────────

export async function exportSyncData(): Promise<string> {
  const data = await readAll();
  return JSON.stringify(data, null, 2);
}

export interface ImportReport {
  profiles: number;
  coverTemplates: number;
  /** Non-fatal repairs — worth showing, but the import succeeded. */
  warnings: ValidationIssue[];
}

/**
 * Validate, migrate and install an exported dataset.
 *
 * Structural problems (`profiles` not an array, unknown `schemaVersion`, a file
 * from a newer build) throw {@link SyncValidationError}, whose `message` names
 * the offending path and is safe to render directly. Field-level problems are
 * repaired and returned as warnings — nothing reaches storage unvalidated.
 */
export async function importSyncData(json: string): Promise<ImportReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SyncValidationError([
      { path: '(file)', message: 'not valid JSON', severity: 'error' },
    ]);
  }

  const { data, issues } = normalizeSyncData(parsed, { strict: true });

  await enqueue(async () => {
    await ensureMigrated();
    await writeWholeDataset(data);
  });

  return {
    profiles: data.profiles.length,
    coverTemplates: data.coverTemplates.length,
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

/** Wipe all synced JobFill keys (settings "reset"). Local secrets are untouched. */
export async function clearSyncData(): Promise<void> {
  await enqueue(async () => {
    const all = await chrome.storage.sync.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX) || k === LEGACY_KEY);
    if (keys.length) await chrome.storage.sync.remove(keys);
    migrationPromise = null;
    await chrome.storage.sync.set({
      [K.schemaVersion]: SYNC_SCHEMA_VERSION,
      [K.settings]: { ...DEFAULT_SETTINGS },
    });
  });
}

export { SyncValidationError, emptySyncData };
export type { ValidationIssue };
