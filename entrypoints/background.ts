import { defineBackground } from 'wxt/utils/define-background';
import {
  generateMotivation,
  classifyFields,
  answerOpenQuestions,
  GroqApiError,
} from '../shared/api/groq';
import { logToNotion, inspectNotionDatabase, clearNotionSchemaCache } from '../shared/api/notion';
import { logToSheets } from '../shared/api/sheets';
import { RemoteLogError, toRemoteLogError } from '../shared/api/remoteLog';
import {
  getGroqApiKey,
  getGroqModel,
  getNotionCredentials,
  getSheetsEndpoint,
  appendLogEntry,
  updateLogEntrySync,
} from '../shared/storage/local';
import {
  enqueueRetry,
  getDueTasks,
  getNextDueAt,
  removeRetry,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  type RemoteLogTask,
  type RetryBackend,
} from '../shared/storage/retryQueue';
import { getSettings, getProfiles } from '../shared/storage/sync';
import {
  API_ERROR_MESSAGES,
  REMOTE_LOG_ERROR_MESSAGES,
  type ApiErrorKind,
  type BackgroundResponse,
  type FromBackgroundMessage,
  type OpenQuestion,
  type ToBackgroundMessage,
} from '../shared/messages';
import { createApplicationEntry } from '../shared/types';
import type { ApplicationEntry, FillSummary, JobInfo, NewApplicationInput } from '../shared/types';
import { fillAllFrames, fillFailureMessage } from './ui/frames';

const RETRY_ALARM = 'jobfill:remote-log-retry';

/** Manifest command id — keep in sync with `commands` in wxt.config.ts. */
const FILL_COMMAND = 'fill-form';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: ToBackgroundMessage, _sender, sendResponse) => {
    // The listener signature is untyped in the platform API; this is the single
    // place where the typed contract is re-attached.
    const respond = sendResponse as (response: FromBackgroundMessage) => void;

    switch (message.type) {
      case 'GENERATE_COVER':
        run(handleGenerateCover(message.jobInfo, message.profileId), respond, apiFailure);
        return true;

      case 'ANSWER_QUESTIONS':
        run(
          handleAnswerQuestions(message.questions, message.profileId, message.jobInfo),
          respond,
          apiFailure,
        );
        return true;

      case 'CLASSIFY_FIELDS':
        run(handleClassifyFields(message.fingerprints), respond, () => ({
          type: 'CLASSIFY_RESULT',
          classifications: {},
        }));
        return true;

      case 'INSPECT_NOTION':
        run(handleInspectNotion(message.token, message.databaseId), respond, () => ({
          type: 'NOTION_SCHEMA_ERROR',
          kind: 'NETWORK_ERROR',
          message: REMOTE_LOG_ERROR_MESSAGES.NETWORK_ERROR,
        }));
        return true;

      case 'LOG_APPLICATION':
        run(
          handleLogApplication({
            jobInfo: message.jobInfo,
            profileId: message.profileId,
            url: message.url,
          }),
          respond,
          logFailure,
        );
        return true;

      default:
        return false;
    }
  });

  // FR-2.4 — the Alt+Shift+F shortcut declared in the manifest. Without this
  // listener the entry in chrome://extensions/shortcuts did nothing at all,
  // which is a Web Store review finding on its own.
  chrome.commands?.onCommand.addListener((command) => {
    if (command === FILL_COMMAND) void handleFillCommand();
  });

  // Durable retry driver (FR-6.3 + NFR-5). `chrome.alarms` is the only timer that
  // outlives service-worker eviction; without the `alarms` permission the object
  // is undefined and we fall back to a best-effort in-session timer.
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) void drainRetryQueue();
  });

  chrome.runtime.onStartup?.addListener(() => void drainRetryQueue());
  chrome.runtime.onInstalled.addListener(() => void drainRetryQueue());
});

// ─── Response plumbing ────────────────────────────────────────────────────────

/** Await a handler, always answer with a well-formed `FromBackgroundMessage`. */
function run(
  work: Promise<FromBackgroundMessage>,
  respond: (response: FromBackgroundMessage) => void,
  onUnexpected: (err: unknown) => FromBackgroundMessage,
): void {
  work.then(respond).catch((err: unknown) => {
    console.error('[JobFill] background handler failed', err);
    respond(onUnexpected(err));
  });
}

function apiError(kind: ApiErrorKind, message = API_ERROR_MESSAGES[kind]): BackgroundResponse<'API_ERROR'> {
  return { type: 'API_ERROR', kind, message };
}

const apiFailure = () => apiError('NETWORK_ERROR');

function logFailure(): BackgroundResponse<'LOG_RESULT'> {
  return {
    type: 'LOG_RESULT',
    success: false,
    entry: createApplicationEntry({ profileId: '', url: '' }, { remoteSync: 'failed' }),
    remoteSync: 'failed',
    message: 'The application could not be saved.',
  };
}

/** Groq errors already carry FR-5.4 copy; anything else is a network failure. */
function toApiError(err: unknown): BackgroundResponse<'API_ERROR'> {
  if (err instanceof GroqApiError) return apiError(err.kind, err.message);
  return apiError('NETWORK_ERROR');
}

// ─── Keyboard shortcut (FR-2.4) ───────────────────────────────────────────────

/** How long the result stays on the toolbar icon. */
const BADGE_MS = 8000;
/** Light-theme `--color-success` / `--color-danger` — legible on both toolbars. */
const BADGE_OK = '#15803d';
const BADGE_ERROR = '#c22626';
/** Pages that never host a content script. */
const WEB_PAGE = /^https?:/i;

/**
 * Alt+Shift+F. The shortcut goes through the same broadcast-and-collect path as
 * the popup (P0-5), because the form is just as likely to live in an iframe.
 *
 * Feedback is the hard part: a shortcut does not open the popup, so there is no
 * surface to render the summary on. Two channels answer it:
 *   1. the page itself — every filled field is highlighted for
 *      `highlightDurationMs` by `fillPage`, so a successful fill is visible
 *      where the user is already looking;
 *   2. the toolbar icon — a per-tab badge with the number of filled fields and
 *      a tooltip with the breakdown, which is the only thing that can also say
 *      "nothing matched" or "no profile".
 *
 * The content script's on-page toast is deliberately *not* used: it is wired to
 * the inline button inside `content.ts` and is not reachable from the worker
 * without a new message type on that side.
 */
async function handleFillCommand(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (tab.url && !WEB_PAGE.test(tab.url)) {
    flashBadge(tab.id, '!', BADGE_ERROR, 'JobFill only works on regular web pages');
    return;
  }

  const outcome = await fillAllFrames(tab.id, '__active__');

  if (outcome.answered === 0) {
    flashBadge(tab.id, '!', BADGE_ERROR, `JobFill — ${fillFailureMessage(outcome)}`);
    return;
  }

  const filled = outcome.summary.high + outcome.summary.medium;
  flashBadge(tab.id, String(filled), filled > 0 ? BADGE_OK : BADGE_ERROR, fillTitle(outcome.summary));
}

/** Same breakdown the inline button shows in its toast, as an icon tooltip. */
function fillTitle(summary: FillSummary): string {
  const filled = summary.high + summary.medium;
  const parts = [`Filled ${filled} field${filled === 1 ? '' : 's'}`];
  if (summary.medium > 0) parts.push(`${summary.medium} need review`);
  if (summary.fileInputs > 0) {
    parts.push(`${summary.fileInputs} file${summary.fileInputs === 1 ? '' : 's'} to attach manually`);
  }
  if (summary.aiQuestions > 0) {
    parts.push(
      `${summary.aiQuestions} open question${summary.aiQuestions === 1 ? '' : 's'} — open JobFill to answer`,
    );
  }
  return `JobFill — ${parts.join(' · ')}`;
}

function flashBadge(tabId: number, text: string, color: string, title: string): void {
  // MV2 (Firefox) exposes `browserAction`; there the shortcut still fills, it
  // just reports through the page highlights only.
  const action = chrome.action;
  if (!action?.setBadgeText) return;

  const ignore = () => undefined;
  action.setTitle({ tabId, title }).catch(ignore);
  action.setBadgeBackgroundColor({ tabId, color }).catch(ignore);
  action.setBadgeTextColor?.({ tabId, color: '#ffffff' }).catch(ignore);
  action.setBadgeText({ tabId, text }).catch(ignore);

  // Best effort: an evicted worker never clears the badge, but it is per-tab and
  // the next fill overwrites it, so the worst case is a stale count on one tab.
  setTimeout(() => {
    action.setBadgeText({ tabId, text: '' }).catch(ignore);
    action.setTitle({ tabId, title: 'JobFill' }).catch(ignore);
  }, BADGE_MS);
}

// ─── Groq handlers ────────────────────────────────────────────────────────────

async function handleGenerateCover(
  jobInfo: JobInfo,
  profileId: string,
): Promise<FromBackgroundMessage> {
  const apiKey = await getGroqApiKey();
  if (!apiKey) return apiError('MISSING_KEY');

  const profile = (await getProfiles()).find((p) => p.id === profileId);
  if (!profile) {
    return apiError('NETWORK_ERROR', 'Profile not found. Re-open the popup and pick a profile.');
  }

  try {
    const text = await generateMotivation(jobInfo, profile, apiKey, await getGroqModel());
    return { type: 'GENERATION_RESULT', text };
  } catch (err) {
    return toApiError(err);
  }
}

async function handleAnswerQuestions(
  questions: OpenQuestion[],
  profileId: string,
  jobInfo: JobInfo,
): Promise<FromBackgroundMessage> {
  const apiKey = await getGroqApiKey();
  if (!apiKey) return apiError('MISSING_KEY');

  const profile = (await getProfiles()).find((p) => p.id === profileId);
  if (!profile) {
    return apiError('NETWORK_ERROR', 'Profile not found. Re-open the popup and pick a profile.');
  }

  try {
    const answerTexts = await answerOpenQuestions(
      questions.map((q) => q.text),
      profile,
      jobInfo,
      apiKey,
      await getGroqModel(),
    );

    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.id] = answerTexts[i] ?? '';
    });

    return { type: 'ANSWERS_RESULT', answers };
  } catch (err) {
    return toApiError(err);
  }
}

const NO_CLASSIFICATIONS: BackgroundResponse<'CLASSIFY_RESULT'> = {
  type: 'CLASSIFY_RESULT',
  classifications: {},
};

/**
 * FR-5.3 — optional LLM classification of low-confidence fields.
 *
 * The opt-in is re-checked *here*, not only in the content script that asked:
 * this is the context that owns the API key and makes the request, so it is the
 * only place where "off means no egress" can actually be guaranteed.
 *
 * Failures are intentionally silent — no key, feature off, transport error,
 * unparseable answer all return an empty map, and the caller keeps its
 * heuristic result. FR-5.4's "no silent failures" governs the paths the user
 * explicitly asked for (generate, answer); this one is an unattended background
 * pass over fields nothing was written into, and an error toast for it would be
 * noise about a feature the user never invoked.
 */
async function handleClassifyFields(fingerprints: string[]): Promise<FromBackgroundMessage> {
  const { llmFieldClassification } = await getSettings();
  if (!llmFieldClassification || fingerprints.length === 0) return NO_CLASSIFICATIONS;

  const apiKey = await getGroqApiKey();
  if (!apiKey) return NO_CLASSIFICATIONS;

  try {
    const classifications = await classifyFields(fingerprints, apiKey, await getGroqModel());
    return { type: 'CLASSIFY_RESULT', classifications };
  } catch {
    return NO_CLASSIFICATIONS;
  }
}

// ─── Notion setup check (P1-13) ───────────────────────────────────────────────

/**
 * Read a Notion database's schema on behalf of the options page.
 *
 * The cache is cleared first, and that is not optional: `inspectNotionDatabase`
 * memoises a report for 10 minutes, so a user who fixed their database and
 * pressed "Check connection" again would be shown the stale failure and
 * conclude the button is broken.
 */
async function handleInspectNotion(
  token: string,
  databaseId: string,
): Promise<FromBackgroundMessage> {
  clearNotionSchemaCache(databaseId);
  try {
    return { type: 'NOTION_SCHEMA_RESULT', report: await inspectNotionDatabase(token, databaseId) };
  } catch (err) {
    // `RemoteLogError.message` is already user-facing and specific to what went
    // wrong; it is forwarded verbatim rather than flattened to a generic string.
    const { kind, message } = toRemoteLogError(err, 'Notion');
    return { type: 'NOTION_SCHEMA_ERROR', kind, message };
  }
}

// ─── Application logging (FR-6.1 … FR-6.3) ────────────────────────────────────

/**
 * Which backend is configured. `null` means "logging is off" — a valid,
 * non-error state. Throws {@link RemoteLogError} when a backend is selected but
 * its credentials are incomplete.
 */
async function resolveBackend(): Promise<RetryBackend | null> {
  const { logBackend } = await getSettings();
  if (logBackend === 'off') return null;

  if (logBackend === 'notion') {
    const { notionToken, notionDatabaseId } = await getNotionCredentials();
    if (!notionToken || !notionDatabaseId) {
      throw new RemoteLogError(
        'NOT_CONFIGURED',
        'Notion logging is enabled but the token or database ID is missing. Finish setup in Settings.',
      );
    }
    return 'notion';
  }

  const endpoint = await getSheetsEndpoint();
  if (!endpoint) {
    throw new RemoteLogError(
      'NOT_CONFIGURED',
      'Google Sheets logging is enabled but no Web App URL is set. Finish setup in Settings.',
    );
  }
  return 'sheets';
}

/**
 * Credentials are re-read on every attempt on purpose: a retry may run in a
 * fresh service worker, minutes after the user fixed a wrong token.
 */
async function sendToBackend(backend: RetryBackend, entry: ApplicationEntry): Promise<void> {
  if (backend === 'notion') {
    const { notionToken, notionDatabaseId } = await getNotionCredentials();
    if (!notionToken || !notionDatabaseId) {
      throw new RemoteLogError('NOT_CONFIGURED', REMOTE_LOG_ERROR_MESSAGES.NOT_CONFIGURED);
    }
    await logToNotion(entry, notionToken, notionDatabaseId);
    return;
  }

  const endpoint = await getSheetsEndpoint();
  if (!endpoint) {
    throw new RemoteLogError('NOT_CONFIGURED', REMOTE_LOG_ERROR_MESSAGES.NOT_CONFIGURED);
  }
  await logToSheets(entry, endpoint);
}

/**
 * FR-6.1 — create the journal entry; FR-6.3 — local copy first, then remote with
 * exactly one retry.
 *
 * The response is sent as soon as the *local* write and the first remote attempt
 * are done: a slow or failing backend never blocks the UI. When the first attempt
 * fails with a transport-level error the entry stays `pending` and the retry is
 * handed to the alarm-driven queue.
 */
async function handleLogApplication(input: NewApplicationInput): Promise<FromBackgroundMessage> {
  // Opportunistic: a worker woken by any message also drains overdue retries,
  // which keeps things moving even where alarms are unavailable.
  void drainRetryQueue();

  let backend: RetryBackend | null = null;
  let configError: RemoteLogError | null = null;
  try {
    backend = await resolveBackend();
  } catch (err) {
    configError = toRemoteLogError(err, 'Logging backend');
  }

  const entry = createApplicationEntry(input, {
    remoteSync: backend ? 'pending' : configError ? 'failed' : 'off',
  });

  // FR-6.3: the local copy is written regardless of backend availability.
  await appendLogEntry(entry);

  if (configError) {
    return logResult(entry, 'failed', configError.message);
  }
  if (!backend) {
    return logResult(entry, 'off');
  }

  try {
    await sendToBackend(backend, entry);
    await updateLogEntrySync(entry.id, 'ok');
    return logResult(entry, 'ok');
  } catch (err) {
    const error = toRemoteLogError(err, 'Logging backend');

    if (!error.retryable) {
      await updateLogEntrySync(entry.id, 'failed');
      console.warn('[JobFill] remote log failed permanently', error.kind, error.detail);
      return logResult(entry, 'failed', error.message);
    }

    await enqueueRetry({
      entryId: entry.id,
      entry,
      backend,
      attempts: 1,
      nextAttemptAt: Date.now() + RETRY_DELAY_MS,
      lastError: error.message,
    });
    await scheduleDrain(RETRY_DELAY_MS);

    return logResult(entry, 'pending', `${error.message} JobFill will retry once in the background.`);
  }
}

function logResult(
  entry: ApplicationEntry,
  remoteSync: ApplicationEntry['remoteSync'],
  message?: string,
): BackgroundResponse<'LOG_RESULT'> {
  return {
    type: 'LOG_RESULT',
    success: true, // the local copy exists — that is what FR-6.3 guarantees
    entry: { ...entry, remoteSync },
    remoteSync,
    ...(message ? { message } : {}),
  };
}

// ─── Retry driver ─────────────────────────────────────────────────────────────

function scheduleDrain(delayMs: number): void {
  if (chrome.alarms?.create) {
    chrome.alarms.create(RETRY_ALARM, { when: Date.now() + delayMs });
    return;
  }
  // No `alarms` permission: best effort only — the worker may be evicted first.
  // The queue is still durable, so the next background wake-up drains it.
  setTimeout(() => void drainRetryQueue(), delayMs);
}

let draining = false;

/** Run every due task once; a task that exhausts `MAX_ATTEMPTS` becomes `failed`. */
async function drainRetryQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const due = await getDueTasks();
    for (const task of due) {
      await runTask(task);
    }
    await rescheduleIfNeeded();
  } catch (err) {
    console.error('[JobFill] retry queue drain failed', err);
  } finally {
    draining = false;
  }
}

async function runTask(task: RemoteLogTask): Promise<void> {
  try {
    await sendToBackend(task.backend, task.entry);
    await updateLogEntrySync(task.entryId, 'ok');
    await removeRetry(task.entryId);
  } catch (err) {
    const error = toRemoteLogError(err, 'Logging backend');
    const attempts = task.attempts + 1;

    if (attempts >= MAX_ATTEMPTS || !error.retryable) {
      // FR-6.3: one retry, then surface non-blockingly via the entry status.
      await updateLogEntrySync(task.entryId, 'failed');
      await removeRetry(task.entryId);
      console.warn('[JobFill] remote log gave up after', attempts, 'attempts:', error.message);
      return;
    }

    await enqueueRetry({
      ...task,
      attempts,
      nextAttemptAt: Date.now() + RETRY_DELAY_MS,
      lastError: error.message,
    });
  }
}

/** Keep exactly one alarm alive while anything is still queued. */
async function rescheduleIfNeeded(): Promise<void> {
  const soonest = await getNextDueAt();
  if (soonest === null) {
    chrome.alarms?.clear(RETRY_ALARM);
    return;
  }
  scheduleDrain(Math.max(0, soonest - Date.now()));
}
