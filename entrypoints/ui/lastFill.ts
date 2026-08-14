/**
 * The popup's memory of the last fill — the fix for "Log this application" being
 * unreachable in practice.
 *
 * Chrome destroys a browser-action popup the moment it loses focus, and React
 * state dies with it. The whole result of a fill used to live in `useState`, so:
 * fill form → click the page to check a field → popup closes → reopen → empty
 * popup, no button, nothing logged. Anyone who looked at the form they had just
 * filled could no longer record it, which is why "Recent applications" was empty.
 *
 * It lives in `chrome.storage.session`: in memory, cleared on browser restart,
 * never written to disk, covered by the `storage` permission already held, and
 * readable from popup and worker alike since both are trusted contexts. Firefox
 * gained `storage.session` in 115 while the MV2 build declares
 * `strict_min_version: 109`, so {@link area} falls back to `storage.local`
 * there — which is why records are stamped and pruned rather than merely
 * overwritten: on that path the map does survive a restart.
 *
 * A summary is a claim about the page in front of the user: on another tab it is
 * false, and an hour later it is worse than nothing, because the user would log
 * an application they may never have submitted. Hence keyed by tab id, validated
 * against the tab's current origin+path, and expiring after
 * {@link LAST_FILL_TTL_MS}.
 */

import type { OpenQuestion } from '../../shared/messages';
import type { FillSummary, JobInfo, RemoteSyncStatus } from '../../shared/types';

/**
 * How long a fill stays offerable. Filling is the *start* of an application —
 * the user still writes answers, attaches a CV and reads the posting, routinely
 * ten minutes and occasionally twenty. Half an hour covers that without letting
 * yesterday's summary come back, and the popup labels a restored record with its
 * age so it can be judged rather than trusted.
 */
export const LAST_FILL_TTL_MS = 30 * 60_000;

/** Records kept at once. Bounds the fallback path; tabs beyond it are dropped. */
const MAX_RECORDS = 10;

const STORE_KEY = 'jobfill:last-fill';

/** Mirror of the popup's log notice — see `LOG_NOTICE` in popup/App.tsx. */
export interface LastFillLogNotice {
  entryId: string;
  status: RemoteSyncStatus;
  text: string;
}

export interface LastFill {
  /** `pageKey()` of the tab at fill time. A different page is a different fill. */
  page: string;
  /** When the fill happened, epoch ms. Never refreshed by later edits. */
  at: number;
  summary: FillSummary;
  openQuestions: OpenQuestion[];
  /** Frame that owned the form — the target for answers and the cover letter. */
  formFrameId: number | null;
  jobInfo: JobInfo | null;
  /** The generated motivation letter: an API call the user should not lose. */
  generatedText: string;
  /** Result of a completed "Log this application", so it is not offered twice. */
  logNotice: LastFillLogNotice | null;
}

type Store = Record<string, LastFill>;

/**
 * Session storage where available, disk-backed local storage otherwise.
 * `null` outside an extension context (plain-page rendering, tests), where every
 * operation below degrades to a no-op instead of throwing.
 */
function area(): chrome.storage.StorageArea | null {
  return chrome.storage?.session ?? chrome.storage?.local ?? null;
}

/**
 * Identity of the page a fill belongs to: origin + path, without query or hash.
 * Exact URLs are too strict — ATS forms rewrite `?step=2`, add tracking
 * parameters and push hashes as the user moves through the flow, none of which
 * means "different posting". Origin+path survives all of it and still changes on
 * a genuine navigation.
 */
export function pageKey(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function isFresh(fill: LastFill, now: number): boolean {
  return typeof fill?.at === 'number' && now - fill.at < LAST_FILL_TTL_MS;
}

async function readStore(): Promise<Store> {
  const store = area();
  if (!store) return {};
  try {
    const raw = await store.get(STORE_KEY);
    const value = raw[STORE_KEY];
    return typeof value === 'object' && value !== null ? (value as Store) : {};
  } catch {
    return {};
  }
}

/** Drop expired records, then the oldest ones over the cap. */
function prune(store: Store, now: number): Store {
  const live = Object.entries(store).filter(([, fill]) => isFresh(fill, now));
  live.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(live.slice(0, MAX_RECORDS));
}

async function writeStore(store: Store): Promise<void> {
  const target = area();
  if (!target) return;
  try {
    await target.set({ [STORE_KEY]: store });
  } catch {
    // A quota or context failure must never break a fill: the summary is still
    // on screen, it just will not survive the popup closing.
  }
}

/**
 * The fill to restore for this tab, or `null`.
 *
 * `page` is checked here rather than by the caller so that a navigated-away tab
 * can never resurrect a summary about a posting the user has left.
 */
export async function readLastFill(tabId: number, page: string): Promise<LastFill | null> {
  const fill = (await readStore())[String(tabId)];
  if (!fill || !isFresh(fill, Date.now())) return null;
  if (fill.page !== page) return null;
  return fill;
}

export async function writeLastFill(tabId: number, fill: LastFill): Promise<void> {
  const store = prune(await readStore(), Date.now());
  store[String(tabId)] = fill;
  await writeStore(store);
}

/**
 * Forget this tab's fill. Writes only when something actually changes, so the
 * popup can call it unconditionally on every open without touching storage.
 */
export async function clearLastFill(tabId: number): Promise<void> {
  const store = await readStore();
  const pruned = prune(store, Date.now());
  const had = String(tabId) in pruned;
  if (!had && Object.keys(pruned).length === Object.keys(store).length) return;

  delete pruned[String(tabId)];
  await writeStore(pruned);
}
