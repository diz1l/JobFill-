import type { LocalData, ApplicationEntry } from '../types';

const KEYS = {
  groqApiKey: 'groq_api_key',
  groqModel: 'groq_model',
  notionToken: 'notion_token',
  notionDatabaseId: 'notion_db_id',
  sheetsEndpoint: 'sheets_endpoint',
  applicationLog: 'application_log',
} as const;

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

export async function getApplicationLog(): Promise<ApplicationEntry[]> {
  const r = await chrome.storage.local.get(KEYS.applicationLog);
  return (r[KEYS.applicationLog] as ApplicationEntry[] | undefined) ?? [];
}

export async function appendLogEntry(entry: ApplicationEntry): Promise<void> {
  const log = await getApplicationLog();
  log.unshift(entry); // newest first
  // Keep at most 500 entries locally
  if (log.length > 500) log.splice(500);
  await chrome.storage.local.set({ [KEYS.applicationLog]: log });
}

export async function updateLogEntrySync(
  id: string,
  remoteSync: ApplicationEntry['remoteSync'],
): Promise<void> {
  const log = await getApplicationLog();
  const entry = log.find((e) => e.id === id);
  if (entry) {
    entry.remoteSync = remoteSync;
    await chrome.storage.local.set({ [KEYS.applicationLog]: log });
  }
}
