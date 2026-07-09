import type { SyncData, Profile, CoverTemplate, AppSettings } from '../types';
import { DEFAULT_SYNC_DATA } from '../types';

const STORAGE_KEY = 'jobfill_sync';

async function getSyncData(): Promise<SyncData> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  return { ...DEFAULT_SYNC_DATA, ...(result[STORAGE_KEY] as Partial<SyncData>) };
}

async function setSyncData(data: Partial<SyncData>): Promise<void> {
  const current = await getSyncData();
  await chrome.storage.sync.set({ [STORAGE_KEY]: { ...current, ...data } });
}

// ─── Profiles ────────────────────────────────────────────────────────────────

export async function getProfiles(): Promise<Profile[]> {
  return (await getSyncData()).profiles;
}

export async function saveProfiles(profiles: Profile[]): Promise<void> {
  await setSyncData({ profiles });
}

export async function getActiveProfileId(): Promise<string> {
  return (await getSyncData()).activeProfileId;
}

export async function setActiveProfileId(id: string): Promise<void> {
  await setSyncData({ activeProfileId: id });
}

export async function getActiveProfile(): Promise<Profile | undefined> {
  const { profiles, activeProfileId } = await getSyncData();
  return profiles.find((p) => p.id === activeProfileId);
}

export async function upsertProfile(profile: Profile): Promise<void> {
  const profiles = await getProfiles();
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  await saveProfiles(profiles);
}

export async function deleteProfile(id: string): Promise<void> {
  const profiles = await getProfiles();
  await saveProfiles(profiles.filter((p) => p.id !== id));
}

// ─── Cover templates ──────────────────────────────────────────────────────────

export async function getCoverTemplates(): Promise<CoverTemplate[]> {
  return (await getSyncData()).coverTemplates;
}

export async function saveCoverTemplates(templates: CoverTemplate[]): Promise<void> {
  await setSyncData({ coverTemplates: templates });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<AppSettings> {
  return (await getSyncData()).settings;
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await getSettings();
  await setSyncData({ settings: { ...current, ...settings } });
}

// ─── Schema management ────────────────────────────────────────────────────────

export async function getStorageUsagePercent(): Promise<number> {
  return new Promise((resolve) => {
    chrome.storage.sync.getBytesInUse(null, (bytes) => {
      resolve(Math.round((bytes / chrome.storage.sync.QUOTA_BYTES) * 100));
    });
  });
}

// ─── Export / Import ──────────────────────────────────────────────────────────

export async function exportSyncData(): Promise<string> {
  const data = await getSyncData();
  return JSON.stringify(data, null, 2);
}

export async function importSyncData(json: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON file.');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as SyncData).schemaVersion !== 1
  ) {
    throw new Error('Unrecognised file format. Expected JobFill export with schemaVersion: 1.');
  }

  await chrome.storage.sync.set({ [STORAGE_KEY]: parsed });
}
