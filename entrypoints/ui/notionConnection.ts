import {
  clearNotionSchemaCache,
  inspectNotionDatabase,
  type NotionSchemaReport,
} from '../../shared/api/notion';
import { toRemoteLogError } from '../../shared/api/remoteLog';
import type { RemoteLogErrorKind } from '../../shared/messages';

/**
 * "Check connection" transport for the options page (P1-13).
 *
 * `shared/api/notion.ts` grew a full schema reader — `inspectNotionDatabase` +
 * `describeMapping` — that nothing ever called, so the user still typed a token
 * and a database id blind and learned about a mismatch only when an application
 * failed to log. This module is the missing wire.
 *
 * ── Which side performs the request ─────────────────────────────────────────
 * S-2 ("the background worker is the sole network egress point") is the reason
 * the worker is preferred, and there is a second, harder reason: the schema
 * cache inside `shared/api/notion.ts` is *module state*. A check performed on
 * the options page warms the options page's copy of that map, which the write
 * path in the worker never sees — so the button would prove nothing about the
 * code that actually logs applications. Routing through the worker makes the
 * check exercise the very same module instance, cache included.
 *
 * The worker route is live: `INSPECT_NOTION` is declared in
 * `shared/messages.ts` and handled by `handleInspectNotion` in
 * `entrypoints/background.ts`, which clears the schema cache before inspecting
 * (without that, a re-check after the user fixed their database would replay the
 * 10-minute cached failure and the button would look broken).
 *
 * The page-side call is kept as a fallback for the case where the worker has no
 * handler — an older build, or a worker that failed to start. It is allowed
 * rather than merely tolerated: the options page runs on the extension origin
 * and `https://api.notion.com/*` is in `host_permissions` (wxt.config.ts), so
 * the fetch is not subject to a foreign page's CSP or to CORS, which is the
 * concern S-2 exists for. Its one real drawback is the cache split described
 * above, which is why it is the fallback and not the default.
 *
 * ── Wire contract (mirrored in shared/messages.ts) ──────────────────────────
 *   ToBackgroundMessage   | { type: 'INSPECT_NOTION'; token: string; databaseId: string }
 *   FromBackgroundMessage | { type: 'NOTION_SCHEMA_RESULT'; report: NotionSchemaReport }
 *                         | { type: 'NOTION_SCHEMA_ERROR'; kind: RemoteLogErrorKind; message: string }
 */

export type NotionCheckRoute = 'background' | 'page';

export type NotionCheckResult =
  | { ok: true; report: NotionSchemaReport; via: NotionCheckRoute }
  | { ok: false; kind: RemoteLogErrorKind; message: string; via: NotionCheckRoute };

/** Mirrors the `ToBackgroundMessage` member listed above. */
export interface InspectNotionMessage {
  type: 'INSPECT_NOTION';
  token: string;
  databaseId: string;
}

/** Mirrors the two `FromBackgroundMessage` members listed above. */
export type NotionSchemaResponse =
  | { type: 'NOTION_SCHEMA_RESULT'; report: NotionSchemaReport }
  | { type: 'NOTION_SCHEMA_ERROR'; kind: RemoteLogErrorKind; message: string };

/**
 * `shared/api/notion.ts` writes its copy for the *write* path, where the
 * transport failures end with "the entry is saved locally" / "JobFill will
 * retry once". Nothing is being logged during a connection check, so those
 * three kinds get wording that matches what the user actually did. Every other
 * kind — the 401 and 404 explanations especially — is already exactly right and
 * passes through untouched.
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
