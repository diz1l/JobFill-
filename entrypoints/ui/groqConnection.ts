/**
 * "Check key" transport for the options page — the LLM counterpart of
 * `notionConnection.ts`. Without it, a user whose key or model was wrong saw one
 * sentence ("Groq API key is invalid or expired") with no way to tell whether
 * the key had even been saved, whether the provider had rejected it, or whether
 * the model in Settings had been decommissioned.
 *
 * The worker performs the request, always — and unlike Notion there is no
 * page-side fallback. The point of the check is to prove something about the
 * code that fills forms, i.e. `shared/api/groq.ts` as loaded *in the worker*; a
 * fallback would answer from a second copy of that module and could pass while
 * filling kept failing, the one outcome this button must never produce. A silent
 * worker is therefore reported as itself rather than papered over.
 */

import type { ApiErrorKind, GroqCheckReport } from '../../shared/messages';
import { providerOf, type ProviderId } from '../../shared/api/provider';

export type GroqCheckResult =
  | { ok: true; report: GroqCheckReport }
  | { ok: false; kind: ApiErrorKind; message: string };

/** Mirrors the `CHECK_GROQ` member of `ToBackgroundMessage`. */
export interface CheckGroqMessage {
  type: 'CHECK_GROQ';
  apiKey: string;
  model: string;
  provider?: string;
  baseUrl?: string;
}

/** Mirrors the two matching `FromBackgroundMessage` members. */
export type GroqCheckResponse =
  | { type: 'GROQ_CHECK_RESULT'; report: GroqCheckReport }
  | { type: 'GROQ_CHECK_ERROR'; kind: ApiErrorKind; message: string; detail?: string };

/**
 * Check-context wording. `API_ERROR_MESSAGES` is written for the popup, where
 * "open Settings and use Check key" is the only useful advice; said *on* the
 * Settings page half a second after the user pressed Check key it is noise, and
 * for a rejected key it hides the one thing worth saying — how a good key gets
 * broken (a partial paste, or a revoked key). Kinds without an entry keep the
 * worker's copy verbatim.
 */
const CHECK_COPY: Partial<Record<ApiErrorKind, string>> = {
  // The full explanation is already under the key field. Repeating it in a red
  // banner would make the press look like a second, different problem, so this
  // says only what the press adds: nothing left the browser.
  WRONG_PROVIDER:
    'Nothing was sent — the key above was issued by a different service than {provider}. See the note under the key field.',
  UNAUTHORIZED:
    '{provider} rejected this key. Copy it again from {keys} — a half-pasted or revoked key looks exactly like a good one in this field.',
  RATE_LIMITED: '{provider} is rate-limiting this key. Wait a few seconds, then check again.',
  TIMEOUT: '{provider} did not answer within 15 s. Try again in a moment.',
  NETWORK_ERROR: 'Could not reach {provider}. Check your connection, then check again.',
};

/**
 * Check-context copy plus the provider's own words. Falls back to the worker's
 * message, which already ends in the detail, so the evidence is never lost.
 */
function checkMessage(
  kind: ApiErrorKind,
  message: string,
  provider: { inSentence: string; keysUrl: string },
  detail?: string,
): string {
  const base = CHECK_COPY[kind];
  if (!base) return message;
  const copy = base
    .replace(/\{provider\}/g, provider.inSentence)
    .replace(/\{keys\}/g, provider.keysUrl || 'your provider’s dashboard');
  return detail ? `${copy} ${provider.inSentence} said: ${detail}` : copy;
}

/**
 * Shown when the worker never answers: an older build without the handler, or a
 * service worker that failed to start. Both are fixed the same way, and neither
 * says anything about the key — so it must not be reported as a key problem.
 */
const NO_WORKER =
  'JobFill’s background worker did not answer. Reload the extension on chrome://extensions, then check again.';

/** Longest a key ever shown in the UI; the head identifies it, the tail confirms it. */
const KEY_TAIL = 4;

/**
 * `gsk_abc…9f2c` — enough to tell two keys apart, not enough to use one.
 *
 * The check reports *which* key it accepted, because "I pasted a key and nothing
 * works" is usually a key that was never saved: seeing a tail that does not match
 * the clipboard is the fastest way to find that out.
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= KEY_TAIL * 2) return '•'.repeat(trimmed.length);
  return `${trimmed.slice(0, KEY_TAIL)}…${trimmed.slice(-KEY_TAIL)}`;
}

/**
 * Ask the worker to check a key and a model. Never throws: every outcome, the
 * missing worker included, comes back as a `GroqCheckResult`.
 */
export function checkGroqConnection(
  apiKey: string,
  model: string,
  provider: ProviderId = 'groq',
  baseUrl = '',
): Promise<GroqCheckResult> {
  const info = providerOf(provider);

  if (typeof chrome?.runtime?.sendMessage !== 'function') {
    return Promise.resolve({ ok: false, kind: 'NETWORK_ERROR', message: NO_WORKER });
  }

  const message: CheckGroqMessage = { type: 'CHECK_GROQ', apiKey, model, provider, baseUrl };

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply: GroqCheckResponse | undefined) => {
        // Reading `lastError` marks it handled; a worker with no handler for this
        // message closes the channel and would otherwise log on every press.
        void chrome.runtime.lastError;
        if (reply?.type === 'GROQ_CHECK_RESULT') resolve({ ok: true, report: reply.report });
        else if (reply?.type === 'GROQ_CHECK_ERROR') {
          resolve({
            ok: false,
            kind: reply.kind,
            message: checkMessage(reply.kind, reply.message, info, reply.detail),
          });
        } else resolve({ ok: false, kind: 'NETWORK_ERROR', message: NO_WORKER });
      });
    } catch {
      resolve({ ok: false, kind: 'NETWORK_ERROR', message: NO_WORKER });
    }
  });
}
