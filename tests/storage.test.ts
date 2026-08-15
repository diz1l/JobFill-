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
const { emptySyncData, normalizeSyncData, SyncValidationError } = await import(
  '../shared/storage/validate'
);
const { createEmptyProfile, DEFAULT_SETTINGS, SYNC_SCHEMA_VERSION } = await import(
  '../shared/types'
);

beforeEach(async () => {
  sync.data = {};
  local.data = {};
  await syncStore.clearSyncData();
});

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
      // Absent from the old blob → off, like on a fresh install.
      llmFieldClassification: false,
    });
  });
});

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

  it('ignores exhausted tasks when scheduling, so the alarm cannot spin', async () => {
    // `runTask` clears a task once it gives up, but the worker can be evicted
    // between writing the entry status and clearing the queue. If the scheduler
    // still counted that leftover as due, it would re-arm forever for work
    // `getDueTasks` declines to hand out.
    await retryQueue.enqueueRetry(task('exhausted', { attempts: retryQueue.MAX_ATTEMPTS }));

    expect(await retryQueue.getDueTasks()).toEqual([]);
    expect(await retryQueue.getNextDueAt()).toBeNull();
  });

  it('schedules for the earliest task that can still run, not the earliest stored', async () => {
    const soon = Date.now() + 1000;
    await retryQueue.enqueueRetry(
      task('exhausted', { nextAttemptAt: soon, attempts: retryQueue.MAX_ATTEMPTS }),
    );
    await retryQueue.enqueueRetry(task('live', { nextAttemptAt: soon + 5000 }));

    expect(await retryQueue.getNextDueAt()).toBe(soon + 5000);
  });

  it('allows exactly one retry (FR-6.3)', () => {
    expect(retryQueue.MAX_ATTEMPTS).toBe(2);
  });

  it('removes a single task and leaves the rest of the queue alone', async () => {
    await retryQueue.enqueueRetry(task('a'));
    await retryQueue.enqueueRetry(task('b'));

    await retryQueue.removeRetry('a');
    expect((await retryQueue.getRetryQueue()).map((t) => t.entryId)).toEqual(['b']);

    // Removing something that is not there is a no-op, not an error: the drain
    // loop calls this after every successful write, queued or not.
    await retryQueue.removeRetry('never-queued');
    expect((await retryQueue.getRetryQueue()).map((t) => t.entryId)).toEqual(['b']);
  });

  it('ignores stored records that are not tasks', async () => {
    local.data['remote_log_queue'] = [
      task('good'),
      null,
      'nonsense',
      { entryId: 'no-attempts' },
      { attempts: 1 },
    ];
    expect((await retryQueue.getRetryQueue()).map((t) => t.entryId)).toEqual(['good']);

    local.data['remote_log_queue'] = 'not an array';
    expect(await retryQueue.getRetryQueue()).toEqual([]);
  });

  it('does not wedge the queue when one write fails', async () => {
    const spy = vi.spyOn(local, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES exceeded'));
    await expect(retryQueue.enqueueRetry(task('a'))).rejects.toThrow(/QUOTA_BYTES/);
    spy.mockRestore();

    await retryQueue.enqueueRetry(task('b'));
    expect((await retryQueue.getRetryQueue()).map((t) => t.entryId)).toEqual(['b']);
  });
});

/**
 * `sync` is mirrored to Google's servers and to every machine the browser
 * profile is signed into, and deleting a key later undoes neither. So API keys,
 * tokens and Web App URLs go into `chrome.storage.local` and nowhere else.
 *
 * Worth a test of its own rather than trusting the call sites: every one of the
 * writers below is a two-line function that would look equally correct pointing
 * at the wrong area.
 */
describe('S-1 — secrets never reach chrome.storage.sync', () => {
  const SECRETS = {
    apiKey: 'gsk_test_not_a_real_key',
    notionToken: 'secret_notionintegrationtoken',
    notionDb: 'a1b2c3d4e5f6',
    sheets: 'https://script.google.com/macros/s/AKfyPRIVATE/exec',
    customBaseUrl: 'https://llm.internal.example/v1',
  };

  async function storeEverySecret(): Promise<void> {
    await localStore.setGroqApiKey(SECRETS.apiKey);
    await localStore.setLlmProvider('custom', SECRETS.customBaseUrl);
    await localStore.setNotionCredentials(SECRETS.notionToken, SECRETS.notionDb);
    await localStore.setSheetsEndpoint(SECRETS.sheets);
  }

  it('puts every credential in local and no trace of it in sync', async () => {
    await storeEverySecret();
    // Do everything that writes to sync, so nothing can smuggle a secret along.
    await syncStore.saveProfiles([createEmptyProfile({ label: 'A', email: 'a@b.c' })]);
    await syncStore.saveCoverTemplates([{ id: 't1', label: 'T', body: 'Dear {company}' }]);
    await syncStore.saveSettings({ logBackend: 'notion' });

    const synced = JSON.stringify(sync.data);
    for (const secret of Object.values(SECRETS)) expect(synced).not.toContain(secret);

    // Not just the values — the keys are not there either, empty or otherwise.
    expect(Object.keys(sync.data).every((k) => k.startsWith('jobfill.'))).toBe(true);
    expect(JSON.stringify(local.data)).toContain(SECRETS.apiKey);
  });

  it('keeps them out of the export file, which the user mails to themselves', async () => {
    await storeEverySecret();
    await syncStore.saveProfiles([createEmptyProfile({ label: 'A' })]);

    const dump = await syncStore.exportSyncData();
    for (const secret of Object.values(SECRETS)) expect(dump).not.toContain(secret);
    expect(Object.keys(JSON.parse(dump)).sort()).toEqual([
      'activeProfileId',
      'coverTemplates',
      'profiles',
      'schemaVersion',
      'settings',
    ]);
  });

  it('leaves them untouched when the synced dataset is reset', async () => {
    await storeEverySecret();
    await syncStore.saveProfiles([createEmptyProfile({ label: 'A' })]);
    // A device that has not opened the extension since the split still carries
    // the old blob; "reset" has to take that with it or it comes straight back.
    sync.data['jobfill_sync'] = { schemaVersion: 1, profiles: [] };

    await syncStore.clearSyncData();
    expect(sync.data['jobfill_sync']).toBeUndefined();

    expect(await syncStore.getProfiles()).toEqual([]);
    expect(await syncStore.getSettings()).toEqual(DEFAULT_SETTINGS);
    // "Reset settings" is not "log me out of my own API key".
    expect(await localStore.getGroqApiKey()).toBe(SECRETS.apiKey);
    expect(await localStore.getSheetsEndpoint()).toBe(SECRETS.sheets);
    expect((await localStore.getNotionCredentials()).notionToken).toBe(SECRETS.notionToken);
  });
});

// ─── LLM credentials & provider selection (local.ts) ──────────────────────────

describe('LLM credentials in chrome.storage.local', () => {
  it('round-trips the API key under the key an existing install already uses', async () => {
    expect(await localStore.getGroqApiKey()).toBeUndefined();
    await localStore.setGroqApiKey('gsk_secret');
    expect(await localStore.getGroqApiKey()).toBe('gsk_secret');
    // Renaming this key would silently log every current user out of their key.
    expect(local.data['groq_api_key']).toBe('gsk_secret');
  });

  /**
   * The implicit migration: nothing is written when the provider setting is
   * introduced, so "no provider stored" has to keep answering what it answered
   * before — including the model id, which is Groq-shaped and means nothing
   * anywhere else.
   */
  it('means Groq, with its old URL and old default model, when nothing is stored', async () => {
    expect(await localStore.getLlmProvider()).toBe('groq');
    expect(await localStore.getGroqModel()).toBe('llama-3.3-70b-versatile');
    expect(await localStore.getCustomBaseUrl()).toBe('');

    expect(await localStore.getLlmEndpoint()).toMatchObject({
      providerId: 'groq',
      label: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      apiKey: '',
    });
  });

  it('reads junk in the provider key as Groq rather than as a broken install', async () => {
    local.data['llm_provider'] = 'altavista';
    expect(await localStore.getLlmProvider()).toBe('groq');
    expect((await localStore.getLlmEndpoint()).baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(await localStore.getGroqModel()).toBe('llama-3.3-70b-versatile');
  });

  it('defaults the model per provider, and prefers a stored one', async () => {
    await localStore.setLlmProvider('openrouter');
    expect(await localStore.getGroqModel()).toBe('meta-llama/llama-3.3-70b-instruct');

    await localStore.setGroqModel('  vendor/typed-by-hand  ');
    expect(await localStore.getGroqModel()).toBe('vendor/typed-by-hand');

    // A field the user emptied is not a model id — fall back rather than 404.
    await localStore.setGroqModel('   ');
    expect(await localStore.getGroqModel()).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  it('keeps a custom base URL only while the provider is custom', async () => {
    await localStore.setLlmProvider('custom', 'https://llm.internal/v1');
    expect(await localStore.getLlmProvider()).toBe('custom');
    expect(await localStore.getCustomBaseUrl()).toBe('https://llm.internal/v1');
    expect((await localStore.getLlmEndpoint()).baseUrl).toBe('https://llm.internal/v1');

    // Switching away clears it: a stale URL that comes back on the next switch
    // is a request going somewhere the user no longer expects.
    await localStore.setLlmProvider('groq');
    expect(await localStore.getCustomBaseUrl()).toBe('');
    expect(local.data['llm_base_url']).toBe('');

    await localStore.setLlmProvider('custom');
    expect((await localStore.getLlmEndpoint()).baseUrl).toBe('');
  });

  it('assembles the whole endpoint in one storage round-trip', async () => {
    await localStore.setGroqApiKey('sk-or-v1-abc');
    await localStore.setLlmProvider('openrouter');
    await localStore.setGroqModel('vendor/model');

    const spy = vi.spyOn(local, 'get');
    const endpoint = await localStore.getLlmEndpoint();
    // One read, not four: a partial read is how a stale custom URL or a missing
    // default creeps into a request.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    expect(endpoint).toMatchObject({
      providerId: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-abc',
      model: 'vendor/model',
    });
    expect(endpoint.headers).toEqual({ 'X-Title': 'JobFill' });
  });
});

describe('remote-logging credentials', () => {
  it('round-trips the Notion token and database id together', async () => {
    expect(await localStore.getNotionCredentials()).toEqual({
      notionToken: undefined,
      notionDatabaseId: undefined,
    });

    await localStore.setNotionCredentials('secret_abc', 'db-1');
    expect(await localStore.getNotionCredentials()).toEqual({
      notionToken: 'secret_abc',
      notionDatabaseId: 'db-1',
    });
  });

  it('round-trips the Sheets Web App URL', async () => {
    expect(await localStore.getSheetsEndpoint()).toBeUndefined();
    await localStore.setSheetsEndpoint('https://script.google.com/macros/s/x/exec');
    expect(await localStore.getSheetsEndpoint()).toBe('https://script.google.com/macros/s/x/exec');
  });
});

describe('application log — the rest of the surface', () => {
  const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    timestamp: new Date().toISOString(),
    company: 'ACME',
    position: 'Dev',
    url: 'https://example.com',
    profileId: 'p1',
    status: 'submitted' as const,
    remoteSync: 'pending' as const,
    ...overrides,
  });

  it('replaces an entry instead of listing the same application twice', async () => {
    await localStore.appendLogEntry(entry('a'));
    await localStore.appendLogEntry(entry('b'));
    await localStore.appendLogEntry(entry('a', { company: 'ACME (retried)' }));

    const log = await localStore.getApplicationLog();
    expect(log.map((e) => e.id)).toEqual(['a', 'b']);
    expect(log[0].company).toBe('ACME (retried)');
  });

  it('ignores a status update for an id that is not in the journal', async () => {
    await localStore.appendLogEntry(entry('a'));
    await localStore.updateLogEntrySync('trimmed-away', 'failed');

    expect((await localStore.getLogEntry('a'))?.remoteSync).toBe('pending');
    expect(await localStore.getLogEntry('trimmed-away')).toBeUndefined();
  });

  it('drops stored records that are not entries', async () => {
    local.data['application_log'] = [entry('ok'), null, 42, { noId: true }, { id: 7 }];
    expect((await localStore.getApplicationLog()).map((e) => e.id)).toEqual(['ok']);
  });

  it('clears the journal', async () => {
    await localStore.appendLogEntry(entry('a'));
    await localStore.clearApplicationLog();
    expect(await localStore.getApplicationLog()).toEqual([]);
    expect(local.data['application_log']).toEqual([]);
  });

  it('exports the journal key so a storage listener can recognise its writes', async () => {
    await localStore.appendLogEntry(entry('a'));
    expect(local.data[localStore.APPLICATION_LOG_KEY]).toHaveLength(1);
  });

  it('does not wedge the write chain when one journal write fails', async () => {
    const spy = vi.spyOn(local, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES exceeded'));
    await expect(localStore.appendLogEntry(entry('boom'))).rejects.toThrow(/QUOTA_BYTES/);
    spy.mockRestore();

    await localStore.appendLogEntry(entry('after'));
    expect((await localStore.getApplicationLog()).map((e) => e.id)).toEqual(['after']);
  });
});

describe('cover templates', () => {
  const tpl = (id: string, body = `Dear {company}, ${id}`) => ({ id, label: id.toUpperCase(), body });

  it('stores each template under its own key and round-trips the order', async () => {
    await syncStore.saveCoverTemplates([tpl('a'), tpl('b')]);

    expect(sync.data['jobfill.template.a']).toMatchObject({ label: 'A' });
    expect(sync.data['jobfill.templateIds']).toEqual(['a', 'b']);
    expect((await syncStore.getCoverTemplates()).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('does not rewrite unchanged templates', async () => {
    await syncStore.saveCoverTemplates([tpl('a')]);

    const spy = vi.spyOn(sync, 'set');
    await syncStore.saveCoverTemplates([tpl('a')]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('removes the key of a template dropped from the list', async () => {
    await syncStore.saveCoverTemplates([tpl('a'), tpl('b')]);
    await syncStore.saveCoverTemplates([tpl('b')]);

    expect(sync.data['jobfill.template.a']).toBeUndefined();
    expect((await syncStore.getCoverTemplates()).map((t) => t.id)).toEqual(['b']);
  });

  it('upserts a new template and edits an existing one in place', async () => {
    await syncStore.upsertCoverTemplate(tpl('a'));
    expect(sync.data['jobfill.templateIds']).toEqual(['a']);

    await syncStore.upsertCoverTemplate(tpl('a', 'edited body'));
    expect(sync.data['jobfill.templateIds']).toEqual(['a']);
    expect((await syncStore.getCoverTemplates())[0].body).toBe('edited body');

    // An unchanged upsert costs no write quota either.
    const spy = vi.spyOn(sync, 'set');
    await syncStore.upsertCoverTemplate(tpl('a', 'edited body'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('two concurrent edits of different templates both survive', async () => {
    await syncStore.saveCoverTemplates([tpl('a'), tpl('b')]);

    await Promise.all([
      syncStore.upsertCoverTemplate(tpl('a', 'A body')),
      syncStore.upsertCoverTemplate(tpl('b', 'B body')),
    ]);

    const stored = await syncStore.getCoverTemplates();
    expect(stored.find((t) => t.id === 'a')?.body).toBe('A body');
    expect(stored.find((t) => t.id === 'b')?.body).toBe('B body');
  });

  it('deletes one template without touching the others', async () => {
    await syncStore.saveCoverTemplates([tpl('a'), tpl('b')]);
    await syncStore.deleteCoverTemplate('a');

    expect(sync.data['jobfill.template.a']).toBeUndefined();
    expect((await syncStore.getCoverTemplates()).map((t) => t.id)).toEqual(['b']);

    // …and deleting from an empty store is a no-op, not a crash.
    sync.data = {};
    await syncStore.deleteCoverTemplate('ghost');
    expect(await syncStore.getCoverTemplates()).toEqual([]);
  });
});

describe('snapshot reads', () => {
  it('getSyncSnapshot answers with everything in one object', async () => {
    const a = createEmptyProfile({ label: 'A' });
    await syncStore.saveProfiles([a]);
    await syncStore.saveCoverTemplates([{ id: 't', label: 'T', body: 'b' }]);
    await syncStore.saveSettings({ highlightDurationMs: 1234 });

    expect(await syncStore.getSyncSnapshot()).toEqual({
      schemaVersion: SYNC_SCHEMA_VERSION,
      profiles: [a],
      activeProfileId: a.id,
      coverTemplates: [{ id: 't', label: 'T', body: 'b' }],
      settings: { ...DEFAULT_SETTINGS, highlightDurationMs: 1234 },
    });
  });

  it('getActiveProfile resolves the pointer to the profile itself', async () => {
    const a = createEmptyProfile({ label: 'A', firstName: 'Ada' });
    const b = createEmptyProfile({ label: 'B', firstName: 'Grace' });
    await syncStore.saveProfiles([a, b]);

    expect((await syncStore.getActiveProfile())?.firstName).toBe('Ada');
    await syncStore.setActiveProfileId(b.id);
    expect((await syncStore.getActiveProfile())?.firstName).toBe('Grace');
  });

  it('repoints a dangling active pointer at read time', async () => {
    const a = createEmptyProfile({ label: 'A' });
    await syncStore.saveProfiles([a]);
    sync.data['jobfill.activeProfileId'] = 'deleted-on-another-device';

    // Sync is eventually consistent: the pointer can outlive the profile it
    // names. The popup still has to open on *something*.
    expect(await syncStore.getActiveProfileId()).toBe(a.id);
    expect((await syncStore.getActiveProfile())?.id).toBe(a.id);

    sync.data['jobfill.activeProfileId'] = { not: 'a string' };
    expect(await syncStore.getActiveProfileId()).toBe(a.id);
  });

  it('answers with no profiles rather than throwing on a corrupted order list', async () => {
    sync.data['jobfill.profileIds'] = 'not an array';
    expect(await syncStore.getProfiles()).toEqual([]);
    expect(await syncStore.getActiveProfileId()).toBe('');

    sync.data['jobfill.profileIds'] = ['p1', 42, null];
    sync.data['jobfill.profile.p1'] = { id: 'p1', label: 'Real' };
    // 42 names no key, and `jobfill.profile.undefined` is not a profile either.
    expect((await syncStore.getProfiles()).map((p) => p.label)).toEqual(['Real']);
  });

  it('skips an id in the order list whose profile key never arrived', async () => {
    // `chrome.storage.sync` delivers keys independently, so the order list can
    // legitimately mention a profile whose own item has not landed yet. Showing
    // a blank profile for it would be worse than showing it a moment later.
    const a = createEmptyProfile({ label: 'Arrived' });
    await syncStore.saveProfiles([a]);
    sync.data['jobfill.profileIds'] = [a.id, 'still-in-flight'];

    expect((await syncStore.getProfiles()).map((p) => p.label)).toEqual(['Arrived']);
  });
});

describe('profile writes that remove things', () => {
  it('deletes the keys of profiles dropped from a full save and repoints the active one', async () => {
    const a = createEmptyProfile({ label: 'A' });
    const b = createEmptyProfile({ label: 'B' });
    await syncStore.saveProfiles([a, b]);
    await syncStore.setActiveProfileId(a.id);

    await syncStore.saveProfiles([b]);

    expect(sync.data[`jobfill.profile.${a.id}`]).toBeUndefined();
    expect(sync.data['jobfill.profileIds']).toEqual([b.id]);
    expect(await syncStore.getActiveProfileId()).toBe(b.id);
  });

  it('empties the active pointer when the last profile goes', async () => {
    const a = createEmptyProfile({ label: 'A' });
    await syncStore.saveProfiles([a]);
    await syncStore.setActiveProfileId(a.id);

    await syncStore.deleteProfile(a.id);

    expect(sync.data['jobfill.activeProfileId']).toBe('');
    expect(await syncStore.getProfiles()).toEqual([]);
  });

  it('empties the active pointer when a save removes every profile', async () => {
    const a = createEmptyProfile({ label: 'A' });
    await syncStore.saveProfiles([a]);
    await syncStore.setActiveProfileId(a.id);

    await syncStore.saveProfiles([]);

    expect(sync.data['jobfill.activeProfileId']).toBe('');
    expect(sync.data[`jobfill.profile.${a.id}`]).toBeUndefined();
  });

  it('deleting from a store that has no order list is a no-op', async () => {
    sync.data = {};
    await syncStore.deleteProfile('ghost');
    expect(await syncStore.getProfiles()).toEqual([]);
  });

  it('deleting a profile that is not the active one leaves the pointer alone', async () => {
    const a = createEmptyProfile({ label: 'A' });
    const b = createEmptyProfile({ label: 'B' });
    await syncStore.saveProfiles([a, b]);
    await syncStore.setActiveProfileId(a.id);

    await syncStore.deleteProfile(b.id);
    expect(await syncStore.getActiveProfileId()).toBe(a.id);
  });

  it('upsert appends a profile the order list has never seen', async () => {
    const a = createEmptyProfile({ label: 'A' });
    const b = createEmptyProfile({ label: 'B' });
    await syncStore.upsertProfile(a);
    await syncStore.upsertProfile(b);

    expect(sync.data['jobfill.profileIds']).toEqual([a.id, b.id]);
    expect((await syncStore.getProfiles()).map((p) => p.label)).toEqual(['A', 'B']);

    const spy = vi.spyOn(sync, 'set');
    await syncStore.upsertProfile(b);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not wedge the write chain when one save fails', async () => {
    const spy = vi.spyOn(sync, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES_PER_ITEM'));
    await expect(syncStore.saveSettings({ logBackend: 'sheets' })).rejects.toThrow(/QUOTA_BYTES/);
    spy.mockRestore();

    await syncStore.saveSettings({ logBackend: 'notion' });
    expect((await syncStore.getSettings()).logBackend).toBe('notion');
  });
});

describe('legacy blob migration, the awkward cases', () => {
  const legacyBlob = (id: string) => ({
    schemaVersion: 1,
    profiles: [{ ...createEmptyProfile({ label: 'Old' }), id }],
    activeProfileId: id,
    coverTemplates: [],
    settings: { highlightDurationMs: 1000, logBackend: 'off' },
  });

  it('drops the blob without overwriting an already-split dataset', async () => {
    // Two devices, one upgraded first: the blob is still on the wire while the
    // new keys are already authoritative, and re-applying it would undo
    // everything done since. Both layouts must be seeded before the first read —
    // the only moment the migration can see them.
    const current = createEmptyProfile({ label: 'Current' });
    sync.data['jobfill.profileIds'] = [current.id];
    sync.data[`jobfill.profile.${current.id}`] = current;
    sync.data['jobfill.activeProfileId'] = current.id;
    sync.data['jobfill_sync'] = legacyBlob('legacy-1');

    expect((await syncStore.getProfiles()).map((p) => p.label)).toEqual(['Current']);
    expect(sync.data['jobfill_sync']).toBeUndefined();
  });

  it('repairs a corrupted blob rather than refusing to boot', async () => {
    sync.data['jobfill_sync'] = { schemaVersion: 1, profiles: 'nonsense' };
    expect(await syncStore.getProfiles()).toEqual([]);
    expect(sync.data['jobfill_sync']).toBeUndefined();
  });

  it('retries after a failed read instead of caching the failure forever', async () => {
    sync.data['jobfill_sync'] = legacyBlob('m1');

    const spy = vi.spyOn(sync, 'get').mockRejectedValueOnce(new Error('storage offline'));
    await expect(syncStore.getProfiles()).rejects.toThrow('storage offline');
    spy.mockRestore();

    // A transient failure must not leave the extension permanently unmigrated.
    expect((await syncStore.getProfiles()).map((p) => p.id)).toEqual(['m1']);
    expect(sync.data['jobfill_sync']).toBeUndefined();
  });
});

describe('import replaces the dataset rather than merging into it', () => {
  it('removes the profiles and templates that were there before', async () => {
    const old = createEmptyProfile({ label: 'Before' });
    await syncStore.saveProfiles([old]);
    await syncStore.saveCoverTemplates([{ id: 'old-t', label: 'Old', body: 'x' }]);

    await syncStore.importSyncData(
      JSON.stringify({
        schemaVersion: 1,
        profiles: [{ ...createEmptyProfile({ label: 'After' }), id: 'new-p' }],
        activeProfileId: 'new-p',
        coverTemplates: [{ id: 'new-t', label: 'New', body: 'y' }],
        settings: { highlightDurationMs: 3000, logBackend: 'off' },
      }),
    );

    expect(sync.data[`jobfill.profile.${old.id}`]).toBeUndefined();
    expect(sync.data['jobfill.template.old-t']).toBeUndefined();
    expect((await syncStore.getProfiles()).map((p) => p.label)).toEqual(['After']);
    expect((await syncStore.getCoverTemplates()).map((t) => t.id)).toEqual(['new-t']);
  });

  it('rejects a file that is not an object at all', async () => {
    await expect(syncStore.importSyncData('"just a string"')).rejects.toThrow(
      /expected a JobFill export object, got string/,
    );
    await expect(syncStore.importSyncData('[]')).rejects.toThrow(SyncValidationError);
  });
});

describe('getStorageUsage when the browser is unhelpful', () => {
  it('reports zero rather than failing when getBytesInUse throws', async () => {
    const spy = vi.spyOn(sync, 'getBytesInUse').mockRejectedValueOnce(new Error('unavailable'));
    const usage = await syncStore.getStorageUsage();
    spy.mockRestore();

    // A quota reading is a hint in the UI; it must never be the reason a save
    // or a settings page fails to render.
    expect(usage).toEqual({ bytes: 0, quotaBytes: 102_400, percent: 0, warn: false });
  });

  it('falls back to the documented 100 KB when QUOTA_BYTES is missing', async () => {
    const original = sync.QUOTA_BYTES;
    Reflect.deleteProperty(sync, 'QUOTA_BYTES');
    try {
      sync.data['bulk'] = 'x'.repeat(90_000);
      const usage = await syncStore.getStorageUsage();
      expect(usage.quotaBytes).toBe(102_400);
      expect(usage.warn).toBe(true);
    } finally {
      sync.QUOTA_BYTES = original;
    }
  });

  it('does not divide by a zero quota', async () => {
    const original = sync.QUOTA_BYTES;
    sync.QUOTA_BYTES = 0;
    try {
      const usage = await syncStore.getStorageUsage();
      expect(usage.percent).toBe(0);
      expect(usage.warn).toBe(false);
    } finally {
      sync.QUOTA_BYTES = original;
    }
  });

  it('warns at exactly the FR-1.2 threshold, not one byte later', async () => {
    sync.data = {};
    // `getBytesInUse` here is the JSON length of the area, so this is exact.
    sync.data['bulk'] = 'x'.repeat(Math.round(102_400 * 0.8) - 20);
    const usage = await syncStore.getStorageUsage();
    expect(usage.percent).toBe(syncStore.SYNC_QUOTA_WARN_PERCENT);
    expect(usage.warn).toBe(true);
  });
});

// ─── validate.ts — repairs, warnings and refusals ─────────────────────────────

describe('normalizeSyncData repairs a survivable file', () => {
  const base = { schemaVersion: 1, profiles: [], coverTemplates: [] };

  it('coerces scalars a hand-edited file can contain', () => {
    const { data, issues } = normalizeSyncData({
      ...base,
      profiles: [{ id: 'p1', label: 'Ok', phone: 420123456789, workPermit: true, city: null }],
    });

    expect(data.profiles[0].phone).toBe('420123456789');
    expect(data.profiles[0].workPermit).toBe('true');
    // `null` is "not filled in", not a broken value — no warning for it.
    expect(data.profiles[0].city).toBe('');
    expect(issues).toEqual([]);
  });

  it('gives a profile without an id one, and a label to go with it', () => {
    const { data } = normalizeSyncData({ ...base, profiles: [{ firstName: 'Ada' }] });
    expect(data.profiles[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.profiles[0].label).toBe('Imported profile');
    // …and the active pointer follows the profile that now exists.
    expect(data.activeProfileId).toBe(data.profiles[0].id);
  });

  it('skips a template that is not an object and names the entry', () => {
    const { data, issues } = normalizeSyncData({
      ...base,
      coverTemplates: ['garbage', { body: 'Dear {company}' }],
    });

    expect(data.coverTemplates).toHaveLength(1);
    expect(data.coverTemplates[0].label).toBe('Imported template');
    expect(data.coverTemplates[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'coverTemplates[0]', severity: 'warning' }),
    );
  });

  it('replaces settings that are not an object, and says so', () => {
    const { data, issues } = normalizeSyncData({ ...base, settings: 'off please' });
    expect(data.settings).toEqual(DEFAULT_SETTINGS);
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'settings', severity: 'error' }),
    );
    // A `null` settings item is a fresh install, not a broken one.
    expect(normalizeSyncData({ ...base, settings: null }).issues).toEqual([]);
  });

  it('clamps the highlight duration and warns about a non-number', () => {
    const clamp = (highlightDurationMs: unknown) =>
      normalizeSyncData({ ...base, settings: { highlightDurationMs } }).data.settings
        .highlightDurationMs;

    expect(clamp(999_999)).toBe(60_000);
    expect(clamp(-5)).toBe(0);
    expect(clamp(1234.6)).toBe(1235);
    expect(clamp(Number.NaN)).toBe(DEFAULT_SETTINGS.highlightDurationMs);

    const { issues } = normalizeSyncData({ ...base, settings: { highlightDurationMs: 'fast' } });
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'settings.highlightDurationMs', severity: 'warning' }),
    );
  });

  it('warns about an activeProfileId that is not a string, then repoints it', () => {
    const { data, issues } = normalizeSyncData({
      ...base,
      profiles: [{ id: 'p1', label: 'Ok' }],
      activeProfileId: 42,
    });

    expect(data.activeProfileId).toBe('p1');
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'activeProfileId', severity: 'warning' }),
    );

    // …and `null` is simply "unset", which is not worth a warning.
    expect(
      normalizeSyncData({ ...base, profiles: [{ id: 'p1' }], activeProfileId: null }).issues,
    ).toEqual([]);
  });

  it('names the type it actually got for a broken schemaVersion', () => {
    for (const [version, described] of [
      [null, 'null'],
      [undefined, 'undefined'],
      ['1', 'string'],
      [[], 'array'],
      [1.5, 'number'],
      [0, 'number'],
    ] as const) {
      const { issues } = normalizeSyncData({ ...base, schemaVersion: version });
      expect(issues[0]).toMatchObject({ path: 'schemaVersion', severity: 'error' });
      expect(issues[0].message).toContain(described);
    }
  });

  it('renders every error into the message a user is shown', () => {
    const error = new SyncValidationError([
      { path: 'profiles', message: 'expected an array, got string', severity: 'error' },
      { path: 'profiles[0].city', message: 'field cleared', severity: 'warning' },
    ]);
    expect(error.message).toContain('• profiles: expected an array, got string');
    // Warnings are repairs, not reasons to refuse the file — they stay out.
    expect(error.message).not.toContain('field cleared');
  });

  it('emptySyncData is what a fresh install reads', async () => {
    expect(emptySyncData()).toEqual({
      schemaVersion: SYNC_SCHEMA_VERSION,
      profiles: [],
      activeProfileId: '',
      coverTemplates: [],
      settings: DEFAULT_SETTINGS,
    });
    expect(await syncStore.getSyncSnapshot()).toEqual(emptySyncData());
  });
});

// ─── Schema v1 → v2 ───────────────────────────────────────────────────────────

/**
 * The first real schema migration, and with it the first exercise of the
 * migration loop in `validate.ts` — dormant while there was only one version.
 *
 * What has to hold is one sentence: **a v1 profile loses nothing.** It was
 * written by a build that never asked about middle names, addresses or driving
 * licences, so the upgrade is those entries arriving blank and every answer the
 * user did give staying exactly as it was — in storage, and in a backup file
 * they exported months ago and import today.
 */
describe('schema v1 → v2', () => {
  /** A profile with every entry schema v1 had, and none that it did not. */
  const v1Profile = {
    id: 'v1-profile',
    label: 'Frontend',
    firstName: 'Dias',
    lastName: 'Nurgaliyev',
    email: 'dias@example.com',
    phone: '+420123456789',
    city: 'Praha, Czechia',
    linkedin: 'https://www.linkedin.com/in/dias-nur',
    github: 'https://github.com/diz1l',
    website: 'https://dias.dev',
    salaryExpectation: '80 000 Kč',
    availability: '1 September',
    workPermit: 'EU citizen',
    about: 'I build things that work.',
  };

  const v1Export = {
    schemaVersion: 1,
    profiles: [v1Profile],
    activeProfileId: 'v1-profile',
    coverTemplates: [{ id: 't1', label: 'Default', body: 'Dear {company}' }],
    settings: { highlightDurationMs: 3000, logBackend: 'off' },
  };

  /**
   * `createEmptyProfile(v1Profile)` *is* the expected result, and says why in
   * one line: the same answers, plus the v2 entries at their empty default.
   */
  const migrated = () => createEmptyProfile(v1Profile);

  it('carries every v1 answer across and blanks nothing', () => {
    const { data, issues } = normalizeSyncData(v1Export);

    expect(data.schemaVersion).toBe(SYNC_SCHEMA_VERSION);
    expect(data.profiles[0]).toEqual(migrated());
    expect(data.activeProfileId).toBe('v1-profile');
    expect(data.coverTemplates).toEqual(v1Export.coverTemplates);
    // A v1 file is not a broken file: an upgrade is not worth a single warning.
    expect(issues).toEqual([]);
  });

  it('leaves the new entries empty rather than inventing an answer for them', () => {
    const [profile] = normalizeSyncData(v1Export).data.profiles;

    expect(profile.middleName).toBe('');
    expect(profile.preferredName).toBe('');
    expect(profile.country).toBe('');
    expect(profile.dateOfBirth).toBe('');
    expect(profile.yearsOfExperience).toBe('');
    // Notably *not* the given name — the guess this whole change is about.
    expect(profile.preferredName).not.toBe(profile.firstName);
  });

  it('imports a v1 backup file, which is the case a user actually meets', async () => {
    const report = await syncStore.importSyncData(JSON.stringify(v1Export));

    expect(report.profiles).toBe(1);
    expect(report.warnings).toEqual([]);
    expect((await syncStore.getProfiles())[0]).toEqual(migrated());
    // …and the store now says which layout it holds.
    expect(sync.data['jobfill.schemaVersion']).toBe(SYNC_SCHEMA_VERSION);
  });

  it('re-exports what it imported, now at v2', async () => {
    await syncStore.importSyncData(JSON.stringify(v1Export));
    const dump = JSON.parse(await syncStore.exportSyncData());

    expect(dump.schemaVersion).toBe(SYNC_SCHEMA_VERSION);
    expect(dump.profiles[0]).toEqual(migrated());
    // Idempotent: the v2 file it just wrote imports as itself.
    await syncStore.importSyncData(JSON.stringify(dump));
    expect((await syncStore.getProfiles())[0]).toEqual(migrated());
  });

  it('does not overwrite a v2 entry that is already there', () => {
    const half = {
      ...v1Export,
      profiles: [{ ...v1Profile, middleName: 'Serik', country: 'CZ' }],
    };
    const [profile] = normalizeSyncData(half).data.profiles;

    expect(profile.middleName).toBe('Serik');
    expect(profile.country).toBe('CZ');
  });

  it('survives a v1 file whose profiles are not profiles', () => {
    // The migration hands junk through untouched; `normalizeProfile` is what
    // decides about it, exactly as it does for a v2 file.
    const { data, issues } = normalizeSyncData({ ...v1Export, profiles: ['garbage', 42, null] });
    expect(data.profiles).toEqual([]);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);

    // …and one that is not a list at all is still a broken file, not a v1 one.
    expect(() => normalizeSyncData({ ...v1Export, profiles: 'oops' }, { strict: true })).toThrow(
      /profiles.*expected an array/s,
    );
  });

  it('still refuses a file from a version this build does not have', async () => {
    await expect(
      syncStore.importSyncData(JSON.stringify({ ...v1Export, schemaVersion: SYNC_SCHEMA_VERSION + 1 })),
    ).rejects.toThrow(/newer version/);
  });

  it('upgrades the legacy single blob straight from v1 to v2', async () => {
    sync.data['jobfill_sync'] = v1Export;

    expect((await syncStore.getProfiles())[0]).toEqual(migrated());
    expect(sync.data['jobfill_sync']).toBeUndefined();
    expect(sync.data['jobfill.schemaVersion']).toBe(SYNC_SCHEMA_VERSION);
  });

  /**
   * The split layout needs no rewrite at all — every key a v1 build wrote is a
   * valid v2 item, because an absent entry reads as empty. Only the stamp is
   * stale, and spending the sync write quota on rewriting profiles to add empty
   * strings would change nothing a reader can see.
   */
  it('re-stamps a split v1 store without rewriting its profiles', async () => {
    const stored = { ...v1Profile };
    sync.data['jobfill.schemaVersion'] = 1;
    sync.data['jobfill.profileIds'] = [stored.id];
    sync.data[`jobfill.profile.${stored.id}`] = stored;
    sync.data['jobfill.activeProfileId'] = stored.id;

    expect((await syncStore.getProfiles())[0]).toEqual(migrated());
    expect(sync.data['jobfill.schemaVersion']).toBe(SYNC_SCHEMA_VERSION);
    // The item itself is untouched until the user next saves that profile.
    expect(sync.data[`jobfill.profile.${stored.id}`]).toEqual(stored);
  });

  it('writes nothing when the stamp is already current', async () => {
    await syncStore.saveProfiles([createEmptyProfile({ label: 'A' })]);

    const spy = vi.spyOn(sync, 'set');
    expect(await syncStore.getProfiles()).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── Quota, with the v2 profile ───────────────────────────────────────────────

/**
 * `chrome.storage.sync` caps a *single item* at 8 KB, and since the key-per-
 * entity split that item is one profile. Sixteen new entries move the number,
 * so it is measured here rather than assumed: a profile in which every box is
 * filled in — including an "About" paragraph, the only entry with no natural
 * length — has to sit far enough below the ceiling that no realistic user can
 * reach it by typing.
 */
describe('a fully written-out profile against the sync quota (FR-1.2)', () => {
  const full = () =>
    createEmptyProfile({
      label: 'Frontend — Praha',
      firstName: 'Dias',
      middleName: 'Serikuly',
      lastName: 'Nurgaliyev',
      preferredName: 'Dee',
      nameSuffix: 'Jr.',
      email: 'dias.nurgaliyev@example.com',
      phone: '+420123456789',
      linkedin: 'https://www.linkedin.com/in/dias-nurgaliyev',
      github: 'https://github.com/diz1l',
      website: 'https://dias.dev',
      addressLine1: 'Vinohradská 1511/230',
      addressLine2: 'byt 4, 3. patro',
      city: 'Praha, Czechia',
      state: 'Hlavní město Praha',
      postalCode: '100 00',
      country: 'Czechia',
      nationality: 'Kazakhstani',
      dateOfBirth: '1990-03-15',
      workPermit: 'EU citizen — no sponsorship required',
      education: "Master's degree",
      drivingLicence: 'ŘP skupiny B',
      preferredLanguage: 'English',
      currentTitle: 'Senior Frontend Engineer',
      currentEmployer: 'Acme Solutions s.r.o.',
      yearsOfExperience: '5+',
      salaryExpectation: '80 000 Kč / month',
      availability: '1 September, two months notice',
      about:
        'Frontend engineer with five years of experience building browser extensions and ' +
        'design systems in TypeScript and React. I care about accessibility, small bundles ' +
        'and interfaces that say what they are doing. Looking for a product team in Prague ' +
        'or fully remote within the EU, ideally somewhere the front end is the product.',
    });

  /** What Chrome counts against QUOTA_BYTES_PER_ITEM: the key plus its JSON. */
  const itemBytes = (key: string) => key.length + JSON.stringify(sync.data[key]).length;

  it('uses a small fraction of the 8 KB an item is allowed', async () => {
    const profile = full();
    await syncStore.saveProfiles([profile]);

    const bytes = itemBytes(`jobfill.profile.${profile.id}`);
    expect(bytes).toBeLessThan(syncStore.SYNC_QUOTA_BYTES_PER_ITEM / 4);
    // Round-trips whole — nothing was silently dropped on the way in or out.
    expect((await syncStore.getProfiles())[0]).toEqual(profile);
  });

  it('leaves the 100 KB warning alone at ten of them', async () => {
    const profiles = Array.from({ length: 10 }, (_, i) =>
      createEmptyProfile({ ...full(), id: `p${i}`, label: `Profile ${i}` }),
    );
    await syncStore.saveProfiles(profiles);

    const usage = await syncStore.getStorageUsage();
    expect(usage.percent).toBeLessThan(syncStore.SYNC_QUOTA_WARN_PERCENT);
    expect(usage.warn).toBe(false);

    // The warning itself still fires — it is the profiles that are small.
    sync.data['bulk'] = 'x'.repeat(90_000);
    expect((await syncStore.getStorageUsage()).warn).toBe(true);
  });
});
