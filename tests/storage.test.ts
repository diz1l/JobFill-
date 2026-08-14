import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Minimal chrome.storage fake ──────────────────────────────────────────────

interface FakeArea {
  data: Record<string, unknown>;
  get: (keys?: string | string[] | null) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
  getBytesInUse: (keys?: string | string[] | null) => Promise<number>;
  QUOTA_BYTES: number;
}

function createArea(quota = 102_400): FakeArea {
  const area: FakeArea = {
    data: {},
    QUOTA_BYTES: quota,
    get: async (keys) => {
      if (keys === undefined || keys === null) return { ...area.data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in area.data) out[k] = area.data[k];
      return out;
    },
    set: async (items) => {
      Object.assign(area.data, structuredClone(items));
    },
    remove: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete area.data[k];
    },
    getBytesInUse: async () => JSON.stringify(area.data).length,
  };
  return area;
}

const sync = createArea();
const local = createArea();

vi.stubGlobal('chrome', { storage: { sync, local } });

const syncStore = await import('../shared/storage/sync');
const localStore = await import('../shared/storage/local');
const retryQueue = await import('../shared/storage/retryQueue');
const { normalizeSyncData, SyncValidationError } = await import('../shared/storage/validate');
const { createEmptyProfile, DEFAULT_SETTINGS } = await import('../shared/types');

beforeEach(async () => {
  sync.data = {};
  local.data = {};
  await syncStore.clearSyncData();
});

// ─── Layout & basic round-trips ───────────────────────────────────────────────

describe('sync storage layout', () => {
  it('stores each profile under its own key (P1-8)', async () => {
    const a = createEmptyProfile({ label: 'Frontend', firstName: 'Ada' });
    const b = createEmptyProfile({ label: 'QA', firstName: 'Grace' });
    await syncStore.saveProfiles([a, b]);

    expect(sync.data[`jobfill.profile.${a.id}`]).toMatchObject({ firstName: 'Ada' });
    expect(sync.data[`jobfill.profile.${b.id}`]).toMatchObject({ firstName: 'Grace' });
    expect(sync.data['jobfill.profileIds']).toEqual([a.id, b.id]);
  });

  it('round-trips profiles in order', async () => {
    const a = createEmptyProfile({ label: 'A' });
    const b = createEmptyProfile({ label: 'B' });
    await syncStore.saveProfiles([a, b]);
    expect((await syncStore.getProfiles()).map((p) => p.label)).toEqual(['A', 'B']);
  });

  it('does not rewrite unchanged profiles', async () => {
    const a = createEmptyProfile({ label: 'A' });
    await syncStore.saveProfiles([a]);

    const spy = vi.spyOn(sync, 'set');
    await syncStore.saveProfiles([a]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('concurrent writes (P1-8)', () => {
  it('an active-profile switch does not clobber a concurrent profile edit', async () => {
    const a = createEmptyProfile({ label: 'A' });
    const b = createEmptyProfile({ label: 'B' });
    await syncStore.saveProfiles([a, b]);

    // Popup switches profile while options saves an edited profile — the old
    // read-modify-write layout lost one of the two.
    await Promise.all([
      syncStore.setActiveProfileId(b.id),
      syncStore.upsertProfile({ ...a, firstName: 'Edited' }),
    ]);

    expect(await syncStore.getActiveProfileId()).toBe(b.id);
    expect((await syncStore.getProfiles()).find((p) => p.id === a.id)?.firstName).toBe('Edited');
  });

  it('two concurrent edits of different profiles both survive', async () => {
    const a = createEmptyProfile({ label: 'A' });
    const b = createEmptyProfile({ label: 'B' });
    await syncStore.saveProfiles([a, b]);

    await Promise.all([
      syncStore.upsertProfile({ ...a, city: 'Prague' }),
      syncStore.upsertProfile({ ...b, city: 'Brno' }),
    ]);

    const profiles = await syncStore.getProfiles();
    expect(profiles.find((p) => p.id === a.id)?.city).toBe('Prague');
    expect(profiles.find((p) => p.id === b.id)?.city).toBe('Brno');
  });

  it('deleting the active profile repoints activeProfileId', async () => {
    const a = createEmptyProfile({ label: 'A' });
    const b = createEmptyProfile({ label: 'B' });
    await syncStore.saveProfiles([a, b]);
    await syncStore.setActiveProfileId(a.id);

    await syncStore.deleteProfile(a.id);

    expect(await syncStore.getActiveProfileId()).toBe(b.id);
    expect(sync.data[`jobfill.profile.${a.id}`]).toBeUndefined();
  });
});

describe('legacy blob migration', () => {
  it('splits the old single-key blob and removes it', async () => {
    const id = 'legacy-1';
    sync.data['jobfill_sync'] = {
      schemaVersion: 1,
      profiles: [{ ...createEmptyProfile({ label: 'Old' }), id }],
      activeProfileId: id,
      coverTemplates: [{ id: 't1', label: 'T', body: 'hi' }],
      settings: { highlightDurationMs: 1000, logBackend: 'notion' },
    };

    const profiles = await syncStore.getProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0].label).toBe('Old');
    expect(sync.data['jobfill_sync']).toBeUndefined();
    expect(sync.data[`jobfill.profile.${id}`]).toBeDefined();
    expect(await syncStore.getSettings()).toEqual({
      highlightDurationMs: 1000,
      logBackend: 'notion',
      // Absent from the pre-FR-5.3 blob → off, like on a fresh install.
      llmFieldClassification: false,
    });
  });
});

// ─── Import validation (P1-7 / FR-1.4) ────────────────────────────────────────

describe('importSyncData validation', () => {
  const valid = {
    schemaVersion: 1,
    profiles: [{ ...createEmptyProfile({ label: 'Imported' }), id: 'p1' }],
    activeProfileId: 'p1',
    coverTemplates: [],
    settings: { highlightDurationMs: 3000, logBackend: 'off' },
  };

  it('imports a valid export', async () => {
    const report = await syncStore.importSyncData(JSON.stringify(valid));
    expect(report.profiles).toBe(1);
    expect(report.warnings).toHaveLength(0);
    expect((await syncStore.getProfiles())[0].label).toBe('Imported');
  });

  it('rejects non-JSON with a readable message', async () => {
    await expect(syncStore.importSyncData('not json')).rejects.toThrow(/not valid JSON/);
  });

  it('rejects `profiles: "string"` and names the field (P1-7)', async () => {
    const broken = JSON.stringify({ ...valid, profiles: 'oops' });
    await expect(syncStore.importSyncData(broken)).rejects.toThrow(/profiles.*expected an array/s);
  });

  it('rejects a file from a newer schema version', async () => {
    const future = JSON.stringify({ ...valid, schemaVersion: 99 });
    await expect(syncStore.importSyncData(future)).rejects.toThrow(/newer version/);
  });

  it('rejects a missing schemaVersion', async () => {
    const noVersion = JSON.stringify({ profiles: [], coverTemplates: [] });
    await expect(syncStore.importSyncData(noVersion)).rejects.toThrow(SyncValidationError);
  });

  it('leaves storage untouched when validation fails', async () => {
    await syncStore.saveProfiles([createEmptyProfile({ label: 'Existing' })]);
    await expect(
      syncStore.importSyncData(JSON.stringify({ ...valid, profiles: 42 })),
    ).rejects.toThrow();
    expect((await syncStore.getProfiles())[0].label).toBe('Existing');
  });

  it('repairs field-level problems and reports them as warnings', async () => {
    const messy = JSON.stringify({
      ...valid,
      profiles: [{ id: 'p1', label: 'Ok', email: 42, city: { nested: true } }, 'garbage'],
    });
    const report = await syncStore.importSyncData(messy);

    expect(report.profiles).toBe(1);
    expect(report.warnings.map((w) => w.path)).toContain('profiles[0].city');
    const [profile] = await syncStore.getProfiles();
    expect(profile.email).toBe('42'); // numeric coercion is safe
    expect(profile.city).toBe(''); // object is not
  });

  it('drops unknown keys so junk cannot eat the sync quota', async () => {
    const withJunk = JSON.stringify({
      ...valid,
      profiles: [{ id: 'p1', label: 'Ok', evil: 'x'.repeat(5000) }],
    });
    await syncStore.importSyncData(withJunk);
    expect(JSON.stringify(sync.data)).not.toContain('evil');
  });

  it('repoints activeProfileId when it references a missing profile', async () => {
    const dangling = JSON.stringify({ ...valid, activeProfileId: 'nope' });
    await syncStore.importSyncData(dangling);
    expect(await syncStore.getActiveProfileId()).toBe('p1');
  });

  it('export → import is a fixed point', async () => {
    const a = createEmptyProfile({ label: 'A', email: 'a@b.c' });
    await syncStore.saveProfiles([a]);
    await syncStore.setActiveProfileId(a.id);
    await syncStore.saveSettings({ logBackend: 'sheets' });

    const dump = await syncStore.exportSyncData();
    sync.data = {};
    await syncStore.importSyncData(dump);

    expect((await syncStore.getProfiles())[0]).toEqual(a);
    expect(await syncStore.getActiveProfileId()).toBe(a.id);
    expect((await syncStore.getSettings()).logBackend).toBe('sheets');
  });
});

describe('normalizeSyncData (lenient mode)', () => {
  it('never throws on garbage', () => {
    const { data, issues } = normalizeSyncData('total garbage');
    expect(data.profiles).toEqual([]);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('falls back to default settings for an invalid logBackend', () => {
    const { data } = normalizeSyncData({
      schemaVersion: 1,
      profiles: [],
      settings: { logBackend: 'carrier-pigeon' },
    });
    expect(data.settings.logBackend).toBe('off');
  });
});

// ─── FR-5.3 opt-in ────────────────────────────────────────────────────────────

describe('settings.llmFieldClassification', () => {
  it('is off on a fresh install', async () => {
    expect(DEFAULT_SETTINGS.llmFieldClassification).toBe(false);
    expect((await syncStore.getSettings()).llmFieldClassification).toBe(false);
  });

  it('round-trips once the user turns it on, and back off again', async () => {
    await syncStore.saveSettings({ llmFieldClassification: true });
    expect((await syncStore.getSettings()).llmFieldClassification).toBe(true);
    // …and the other settings survive the partial write.
    expect((await syncStore.getSettings()).logBackend).toBe('off');

    await syncStore.saveSettings({ llmFieldClassification: false });
    expect((await syncStore.getSettings()).llmFieldClassification).toBe(false);
  });

  /**
   * This flag is the only thing between a fill and a network request, so it does
   * not get the benefit of the doubt: anything that is not a literal boolean is
   * read as "off" and reported as a repaired value.
   */
  it('fails closed on anything that is not a boolean', async () => {
    for (const junk of ['true', 1, {}, null]) {
      sync.data['jobfill.settings'] = { highlightDurationMs: 3000, llmFieldClassification: junk };
      expect((await syncStore.getSettings()).llmFieldClassification).toBe(false);
    }

    const { data, issues } = normalizeSyncData({
      schemaVersion: 1,
      profiles: [],
      settings: { llmFieldClassification: 'yes please' },
    });
    expect(data.settings.llmFieldClassification).toBe(false);
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'settings.llmFieldClassification', severity: 'warning' }),
    );
  });

  it('survives export → import', async () => {
    await syncStore.saveSettings({ llmFieldClassification: true });
    const dump = await syncStore.exportSyncData();
    sync.data = {};
    await syncStore.importSyncData(dump);

    expect((await syncStore.getSettings()).llmFieldClassification).toBe(true);
  });
});

// ─── Quota (FR-1.2) ───────────────────────────────────────────────────────────

describe('getStorageUsage', () => {
  it('reports percent and the 80% warning flag', async () => {
    await syncStore.saveProfiles([createEmptyProfile({ label: 'A' })]);

    const low = await syncStore.getStorageUsage();
    expect(low.percent).toBeLessThan(syncStore.SYNC_QUOTA_WARN_PERCENT);
    expect(low.warn).toBe(false);

    sync.data['bulk'] = 'x'.repeat(90_000);
    const high = await syncStore.getStorageUsage();
    expect(high.percent).toBeGreaterThanOrEqual(syncStore.SYNC_QUOTA_WARN_PERCENT);
    expect(high.warn).toBe(true);
    expect(await syncStore.getStorageUsagePercent()).toBe(high.percent);
  });
});

// ─── Application log ──────────────────────────────────────────────────────────

describe('application log', () => {
  const entry = (id: string) => ({
    id,
    timestamp: new Date().toISOString(),
    company: 'ACME',
    position: 'Dev',
    url: 'https://example.com',
    profileId: 'p1',
    status: 'submitted' as const,
    remoteSync: 'pending' as const,
  });

  it('prepends newest first and updates remoteSync in place', async () => {
    await localStore.appendLogEntry(entry('a'));
    await localStore.appendLogEntry(entry('b'));
    expect((await localStore.getApplicationLog()).map((e) => e.id)).toEqual(['b', 'a']);

    await localStore.updateLogEntrySync('a', 'ok');
    expect((await localStore.getLogEntry('a'))?.remoteSync).toBe('ok');
    expect((await localStore.getLogEntry('b'))?.remoteSync).toBe('pending');
  });

  it('serialises concurrent appends without losing entries', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => localStore.appendLogEntry(entry(`e${i}`))),
    );
    expect(await localStore.getApplicationLog()).toHaveLength(20);
  });

  it('caps the journal at MAX_LOG_ENTRIES', async () => {
    local.data['application_log'] = Array.from({ length: localStore.MAX_LOG_ENTRIES }, (_, i) =>
      entry(`old${i}`),
    );
    await localStore.appendLogEntry(entry('new'));

    const log = await localStore.getApplicationLog();
    expect(log).toHaveLength(localStore.MAX_LOG_ENTRIES);
    expect(log[0].id).toBe('new');
  });

  it('survives a corrupted stored value', async () => {
    local.data['application_log'] = 'not an array';
    expect(await localStore.getApplicationLog()).toEqual([]);
  });
});

// ─── Retry queue (FR-6.3 / NFR-5) ─────────────────────────────────────────────

describe('remote log retry queue', () => {
  const task = (id: string, overrides = {}) => ({
    entryId: id,
    entry: {
      id,
      timestamp: new Date().toISOString(),
      company: 'ACME',
      position: 'Dev',
      url: 'https://example.com',
      profileId: 'p1',
      status: 'submitted' as const,
      remoteSync: 'pending' as const,
    },
    backend: 'notion' as const,
    attempts: 1,
    nextAttemptAt: Date.now() - 1,
    ...overrides,
  });

  it('persists to chrome.storage.local, not memory (NFR-5)', async () => {
    await retryQueue.enqueueRetry(task('a'));
    expect(local.data['remote_log_queue']).toHaveLength(1);
  });

  it('replaces an existing task for the same entry', async () => {
    await retryQueue.enqueueRetry(task('a'));
    await retryQueue.enqueueRetry(task('a', { attempts: 2 }));
    const queue = await retryQueue.getRetryQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].attempts).toBe(2);
  });

  it('only returns tasks that are due and still have attempts left', async () => {
    await retryQueue.enqueueRetry(task('due'));
    await retryQueue.enqueueRetry(task('later', { nextAttemptAt: Date.now() + 60_000 }));
    await retryQueue.enqueueRetry(task('exhausted', { attempts: retryQueue.MAX_ATTEMPTS }));

    expect((await retryQueue.getDueTasks()).map((t) => t.entryId)).toEqual(['due']);
  });

  it('reports the earliest due timestamp for alarm scheduling', async () => {
    const soon = Date.now() + 1000;
    await retryQueue.enqueueRetry(task('a', { nextAttemptAt: soon + 5000 }));
    await retryQueue.enqueueRetry(task('b', { nextAttemptAt: soon }));
    expect(await retryQueue.getNextDueAt()).toBe(soon);

    await retryQueue.clearRetryQueue();
    expect(await retryQueue.getNextDueAt()).toBeNull();
  });

  it('allows exactly one retry (FR-6.3)', () => {
    expect(retryQueue.MAX_ATTEMPTS).toBe(2);
  });
});
