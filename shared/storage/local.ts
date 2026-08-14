import type { LocalData, ApplicationEntry, RemoteSyncStatus } from '../types';

const KEYS = {
  groqApiKey: 'groq_api_key',
  groqModel: 'groq_model',
  notionToken: 'notion_token',
  notionDatabaseId: 'notion_db_id',
  sheetsEndpoint: 'sheets_endpoint',
  applicationLog: 'application_log',
} as const;

/** Newest-first cap on the local journal. */
export const MAX_LOG_ENTRIES = 500;

// ─── Write serialisation ──────────────────────────────────────────────────────

/**
 * The journal is a single array under one key, so concurrent read-modify-write
 * would drop entries. All mutations go through this chain; the background worker
 * is in practice the only writer, which makes the guarantee complete for it.
 */
let logChain: Promise<unknown> = Promise.resolve();

function enqueueLog<T>(op: () => Promise<T>): Promise<T> {
  const run = logChain.then(op, op);
  logChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── API credentials ─────────────────────────────────────────────────────────

export async function getGroqApiKey(): Promise<string | undefined> {
  const r = await chrome.storage.local.get(KEYS.groqApiKey);
  return r[KEYS.groqApiKey] as string | undefined;
}

export async function setGroqApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.groqApiKey]: key });
}

export async function getGroqModel(): Promise<string> {
  const r = await chrome.storage.local.get(KEYS.groqModel);
  return (r[KEYS.groqModel] as string | undefined) ?? 'llama-3.3-70b-versatile';
}

export async function setGroqModel(model: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.groqModel]: model });
}

export async function getNotionCredentials(): Promise<
  Pick<LocalData, 'notionToken' | 'notionDatabaseId'>
> {
  const r = await chrome.storage.local.get([KEYS.notionToken, KEYS.notionDatabaseId]);
  return {
    notionToken: r[KEYS.notionToken] as string | undefined,
    notionDatabaseId: r[KEYS.notionDatabaseId] as string | undefined,
  };
}

export async function setNotionCredentials(token: string, databaseId: string): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.notionToken]: token,
    [KEYS.notionDatabaseId]: databaseId,
  });
}

export async function getSheetsEndpoint(): Promise<string | undefined> {
  const r = await chrome.storage.local.get(KEYS.sheetsEndpoint);
  return r[KEYS.sheetsEndpoint] as string | undefined;
}

export async function setSheetsEndpoint(url: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.sheetsEndpoint]: url });
}

// ─── Application log ──────────────────────────────────────────────────────────

/** Defensive read: a hand-edited / half-written value must not crash the popup. */
function readLog(raw: unknown): ApplicationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ApplicationEntry =>
      typeof e === 'object' && e !== null && typeof (e as ApplicationEntry).id === 'string',
  );
}

export async function getApplicationLog(): Promise<ApplicationEntry[]> {
  const r = await chrome.storage.local.get(KEYS.applicationLog);
  return readLog(r[KEYS.applicationLog]);
}

async function mutateLog(
  mutator: (log: ApplicationEntry[]) => ApplicationEntry[],
): Promise<ApplicationEntry[]> {
  return enqueueLog(async () => {
    const r = await chrome.storage.local.get(KEYS.applicationLog);
    const next = mutator(readLog(r[KEYS.applicationLog])).slice(0, MAX_LOG_ENTRIES);
    await chrome.storage.local.set({ [KEYS.applicationLog]: next });
    return next;
  });
}

export async function appendLogEntry(entry: ApplicationEntry): Promise<void> {
  await mutateLog((log) => [entry, ...log.filter((e) => e.id !== entry.id)]); // newest first
}

export async function updateLogEntrySync(
  id: string,
  remoteSync: RemoteSyncStatus,
): Promise<void> {
  await mutateLog((log) => log.map((e) => (e.id === id ? { ...e, remoteSync } : e)));
}

export async function getLogEntry(id: string): Promise<ApplicationEntry | undefined> {
  return (await getApplicationLog()).find((e) => e.id === id);
}

export async function clearApplicationLog(): Promise<void> {
  await mutateLog(() => []);
}
