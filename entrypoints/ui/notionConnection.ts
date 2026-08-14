import {
  clearNotionSchemaCache,
  inspectNotionDatabase,
  type NotionSchemaReport,
} from '../../shared/api/notion';
import { toRemoteLogError } from '../../shared/api/remoteLog';
import type { RemoteLogErrorKind } from '../../shared/messages';

/**
 * "Check connection" transport for the options page: the wire between the
 * options form and the schema reader in `shared/api/notion.ts`, without which a
 * user typed a token and a database id blind and learned about a mismatch only
 * when an application failed to log.
 *
 * The worker is the preferred route because it is the sole network egress point,
 * and because the schema cache in `shared/api/notion.ts` is *module state*: a
 * check performed on the options page warms the page's copy, which the worker's
 * write path never sees, so the button would prove nothing about the code that
 * actually logs. `handleInspectNotion` clears that cache before inspecting —
 * without it, a re-check after the user fixed their database would replay the
 * 10-minute cached failure and the button would look broken.
 *
 * The page-side call is a fallback for a worker with no handler (older build, or
 * one that failed to start). It is safe rather than merely tolerated: the
 * options page runs on the extension origin with `https://api.notion.com/*` in
 * `host_permissions`, so no foreign CSP or CORS applies. Its only drawback is
 * the cache split above, which is why it is not the default.
 */

export type NotionCheckRoute = 'background' | 'page';

export type NotionCheckResult =
  | { ok: true; report: NotionSchemaReport; via: NotionCheckRoute }
  | { ok: false; kind: RemoteLogErrorKind; message: string; via: NotionCheckRoute };

/** Mirrors the `INSPECT_NOTION` member of `ToBackgroundMessage`. */
export interface InspectNotionMessage {
  type: 'INSPECT_NOTION';
  token: string;
  databaseId: string;
}

/** Mirrors the two matching `FromBackgroundMessage` members. */
export type NotionSchemaResponse =
  | { type: 'NOTION_SCHEMA_RESULT'; report: NotionSchemaReport }
  | { type: 'NOTION_SCHEMA_ERROR'; kind: RemoteLogErrorKind; message: string };

/**
 * `shared/api/notion.ts` writes its copy for the *write* path, where transport
 * failures end with "the entry is saved locally" / "JobFill will retry once".
 * Nothing is being logged during a connection check, so those three kinds get
 * wording that matches what the user actually did; every other kind passes
 * through untouched.
 */
const CHECK_COPY: Partial<Record<RemoteLogErrorKind, string>> = {
  NETWORK_ERROR: 'Could not reach Notion. Check your connection, then try again.',
  TIMEOUT: 'Notion did not answer within 15 s. Try again in a moment.',
  RATE_LIMITED: 'Notion is rate-limiting requests. Wait a few seconds, then try again.',
};

function failure(kind: RemoteLogErrorKind, message: string, via: NotionCheckRoute): NotionCheckResult {
  return { ok: false, kind, message: CHECK_COPY[kind] ?? message, via };
}

/**
 * Resolves with `undefined` when the worker has no handler for the message —
 * the listener returns `false`, the channel closes and the callback fires with
 * no response. That is a feature probe, not a failure, so it must not surface.
 */
function askBackground(message: InspectNotionMessage): Promise<NotionCheckResult | undefined> {
  if (typeof chrome?.runtime?.sendMessage !== 'function') return Promise.resolve(undefined);

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply: NotionSchemaResponse | undefined) => {
        // Touching `lastError` marks it handled; otherwise Chrome logs
        // "Unchecked runtime.lastError" every time the probe misses.
        void chrome.runtime.lastError;
        if (reply?.type === 'NOTION_SCHEMA_RESULT') {
          resolve({ ok: true, report: reply.report, via: 'background' });
        } else if (reply?.type === 'NOTION_SCHEMA_ERROR') {
          resolve(failure(reply.kind, reply.message, 'background'));
        } else {
          resolve(undefined);
        }
      });
    } catch {
      // No extension context at all (plain-page rendering, tests).
      resolve(undefined);
    }
  });
}

/**
 * Read the database schema and report what JobFill would be able to write.
 * Never throws: every failure comes back as `{ ok: false, message }` with the
 * actionable copy `shared/api/notion.ts` already writes for each HTTP outcome.
 */
export async function checkNotionConnection(
  token: string,
  databaseId: string,
): Promise<NotionCheckResult> {
  const fromWorker = await askBackground({ type: 'INSPECT_NOTION', token, databaseId });
  if (fromWorker) return fromWorker;

  try {
    // A re-check must re-read: the user pressed the button *because* they
    // changed something in Notion.
    clearNotionSchemaCache(databaseId);
    const report = await inspectNotionDatabase(token, databaseId);
    return { ok: true, report, via: 'page' };
  } catch (err) {
    const error = toRemoteLogError(err, 'Notion');
    return failure(error.kind, error.message, 'page');
  }
}
