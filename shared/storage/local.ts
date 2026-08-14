import type { LocalData, ApplicationEntry, RemoteSyncStatus } from '../types';
import {
  buildEndpoint,
  DEFAULT_PROVIDER_ID,
  isProviderId,
  providerOf,
  type LlmEndpoint,
  type ProviderId,
} from '../api/provider';

const KEYS = {
  /**
   * Still spelled `groq_*` because that is what existing installs have on disk;
   * renaming would silently log every current user out of their own key. They
   * hold the API key and model of whichever provider is selected.
   */
  groqApiKey: 'groq_api_key',
  groqModel: 'groq_model',
  /** Absent → Groq, which is the only provider that existed before this key. */
  llmProvider: 'llm_provider',
  llmBaseUrl: 'llm_base_url',
  notionToken: 'notion_token',
  notionDatabaseId: 'notion_db_id',
  sheetsEndpoint: 'sheets_endpoint',
  applicationLog: 'application_log',
} as const;

/**
 * Exported so a `chrome.storage.onChanged` subscriber can tell a journal write
 * from every other write to the same area: the popup listens for the retry queue
 * rewriting a `pending` entry and must not re-read on unrelated changes.
 */
export const APPLICATION_LOG_KEY: string = KEYS.applicationLog;

/** Newest-first cap on the local journal. */
export const MAX_LOG_ENTRIES = 500;

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

export async function getGroqApiKey(): Promise<string | undefined> {
  const r = await chrome.storage.local.get(KEYS.groqApiKey);
  return r[KEYS.groqApiKey] as string | undefined;
}

export async function setGroqApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.groqApiKey]: key });
}

/**
 * The configured model, or the selected provider's default — which is per
 * provider and not a constant: `llama-3.3-70b-versatile` is a Groq id that means
 * nothing to OpenRouter, where the same model is `meta-llama/llama-3.3-70b-instruct`.
 */
export async function getGroqModel(): Promise<string> {
  const r = await chrome.storage.local.get([KEYS.groqModel, KEYS.llmProvider]);
  const stored = (r[KEYS.groqModel] as string | undefined)?.trim();
  return stored || providerOf(r[KEYS.llmProvider]).defaultModel;
}

export async function setGroqModel(model: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.groqModel]: model });
}

/**
 * Which OpenAI-compatible service the key belongs to. Stored in `local` next to
 * the key rather than in `sync` settings: a provider that travelled between
 * devices while the key did not would cause exactly the mismatch it prevents.
 */
export async function getLlmProvider(): Promise<ProviderId> {
  const r = await chrome.storage.local.get(KEYS.llmProvider);
  const stored = r[KEYS.llmProvider];
  return isProviderId(stored) ? stored : DEFAULT_PROVIDER_ID;
}

/** The base URL for a `custom` provider. Empty for every built-in one. */
export async function getCustomBaseUrl(): Promise<string> {
  const r = await chrome.storage.local.get(KEYS.llmBaseUrl);
  return (r[KEYS.llmBaseUrl] as string | undefined) ?? '';
}

export async function setLlmProvider(provider: ProviderId, baseUrl = ''): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.llmProvider]: provider,
    // Written unconditionally: a stale custom URL left behind would come back on
    // the next switch and send requests somewhere the user no longer expects.
    [KEYS.llmBaseUrl]: provider === 'custom' ? baseUrl : '',
  });
}

/**
 * Everything one LLM request needs, in a single storage round-trip. Nothing else
 * should assemble an endpoint out of parts — that is where a missing default or a
 * stale custom URL creeps in.
 */
export async function getLlmEndpoint(): Promise<LlmEndpoint> {
  const r = await chrome.storage.local.get([
    KEYS.groqApiKey,
    KEYS.groqModel,
    KEYS.llmProvider,
    KEYS.llmBaseUrl,
  ]);
  return buildEndpoint({
    providerId: r[KEYS.llmProvider],
    apiKey: r[KEYS.groqApiKey] as string | undefined,
    model: r[KEYS.groqModel] as string | undefined,
    customBaseUrl: r[KEYS.llmBaseUrl] as string | undefined,
  });
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
