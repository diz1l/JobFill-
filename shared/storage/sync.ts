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
 * ## Why one key per entity
 *
 * The previous layout kept all of `SyncData` in one item, so every write was
 * read-all → merge → write-all: two contexts (popup + options) writing at the
 * same time silently dropped one change, and — less obviously — the whole profile
 * set had to fit `QUOTA_BYTES_PER_ITEM` (8 KB) rather than the 100 KB total quota.
 *
 * Now `jobfill.profileIds` / `jobfill.templateIds` hold display order only and
 * each entity lives under `jobfill.profile.<id>` / `jobfill.template.<id>`, so
 * concurrent edits touch disjoint keys and the per-item quota applies per profile.
 * Editing the *same* profile from two places is last-write-wins: chrome.storage
 * offers no compare-and-swap, so a real transaction is not available at any price.
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

// ─── Startup migration ────────────────────────────────────────────────────────

let migrationPromise: Promise<void> | null = null;

/**
 * Two upgrades, once per JavaScript context, before the first read or write:
 * the pre-v1.1 single blob, and the schema-version stamp.
 *
 * The stamp is all a *split* store needs. Schema v2 only adds profile entries,
 * and `normalizeProfile` reads an absent entry as `''`, so every key a v1 build
 * wrote is already a valid v2 item — there is nothing to rewrite, and rewriting
 * every profile to add empty strings would spend the sync write quota to change
 * nothing. What would be wrong is leaving `jobfill.schemaVersion` claiming v1
 * forever: it is the only record of the layout's version in this arrangement,
 * and the migration that eventually keys off it must not be handed a lie.
 */
async function runStartupMigration(): Promise<void> {
  const all = await chrome.storage.sync.get(null);
  const legacy = all[LEGACY_KEY];

  if (legacy !== undefined) {
    // Lenient: a corrupted legacy blob must not brick the extension.
    const { data } = normalizeSyncData(legacy);
    const alreadySplit = all[K.profileIds] !== undefined;
    // `writeWholeDataset` stamps the current version itself.
    if (!alreadySplit) await writeWholeDataset(data);
    await chrome.storage.sync.remove(LEGACY_KEY);
    return;
  }

  const stamped = all[K.schemaVersion];
  if (typeof stamped === 'number' && stamped < SYNC_SCHEMA_VERSION) {
    await chrome.storage.sync.set({ [K.schemaVersion]: SYNC_SCHEMA_VERSION });
  }
}

function ensureMigrated(): Promise<void> {
  const pending =
    migrationPromise ??
    runStartupMigration().catch((err) => {
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
 * Both accessors run every value through `normalizeSettings`, which is what makes
 * the `llmFieldClassification` opt-in fail closed against a corrupted or
 * hand-edited sync item. There is deliberately no dedicated setter for that flag
 * that could bypass the validator.
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

// ─── Quota ────────────────────────────────────────────────────────────────────

/** Fill level at which the UI is required to warn the user. */
export const SYNC_QUOTA_WARN_PERCENT = 80;

const FALLBACK_QUOTA_BYTES = 102_400;

/**
 * `chrome.storage.sync.QUOTA_BYTES_PER_ITEM` — the ceiling on **one** key's
 * name plus its JSON value.
 *
 * Named here because the key-per-entity layout is what turned it from a limit
 * on the whole dataset into a limit on a single profile, and the v2 additions
 * are the first change big enough to be worth measuring against it. A fully
 * written-out profile is ~1 KB (see `tests/storage.test.ts`), so the headroom
 * is roughly eightfold and the practical ceiling remains the 100 KB total.
 */
export const SYNC_QUOTA_BYTES_PER_ITEM = 8192;

export interface SyncStorageUsage {
  bytes: number;
  quotaBytes: number;
  /** 0–100, rounded. */
  percent: number;
  /** `true` at or above {@link SYNC_QUOTA_WARN_PERCENT} — render the warning. */
  warn: boolean;
}

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

export async function getStorageUsagePercent(): Promise<number> {
  return (await getStorageUsage()).percent;
}

// ─── Export / Import ──────────────────────────────────────────────────────────

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
 * Validate, migrate and install an exported dataset. Structural problems
 * (`profiles` not an array, unknown `schemaVersion`, a file from a newer build)
 * throw {@link SyncValidationError}, whose `message` names the offending path and
 * is safe to render directly. Field-level problems are repaired and returned as
 * warnings — nothing reaches storage unvalidated.
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
