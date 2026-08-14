import type { ApplicationEntry } from '../types';

/**
 * Durable retry queue for remote application-log writes (FR-6.3, NFR-5).
 *
 * The MV3 service worker is evicted a few seconds after it goes idle, so a
 * pending retry cannot live in a module variable or a `setTimeout` closure. The
 * queue therefore lives in `chrome.storage.local` and is drained by an alarm —
 * the only timer that survives worker eviction.
 */

const QUEUE_KEY = 'remote_log_queue';

/** FR-6.3: the initial attempt plus exactly one retry. */
export const MAX_ATTEMPTS = 2;

/**
 * Chrome clamps alarms to a 30 s minimum (1 min on older builds), so anything
 * shorter would silently become this value anyway.
 */
export const RETRY_DELAY_MS = 60_000;

export type RetryBackend = 'notion' | 'sheets';

export interface RemoteLogTask {
  /** `ApplicationEntry.id` — links the task back to the local journal entry. */
  entryId: string;
  /** Full snapshot, so the retry works even if the journal was trimmed. */
  entry: ApplicationEntry;
  backend: RetryBackend;
  /** Attempts already made, including the initial one. */
  attempts: number;
  /** Epoch ms; the task is not eligible before this. */
  nextAttemptAt: number;
  /** Last user-facing error, surfaced when the task finally fails. */
  lastError?: string;
}

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op, op);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function readQueue(raw: unknown): RemoteLogTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is RemoteLogTask =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as RemoteLogTask).entryId === 'string' &&
      typeof (t as RemoteLogTask).attempts === 'number',
  );
}

export async function getRetryQueue(): Promise<RemoteLogTask[]> {
  const r = await chrome.storage.local.get(QUEUE_KEY);
  return readQueue(r[QUEUE_KEY]);
}

async function mutate(
  mutator: (queue: RemoteLogTask[]) => RemoteLogTask[],
): Promise<RemoteLogTask[]> {
  return enqueue(async () => {
    const r = await chrome.storage.local.get(QUEUE_KEY);
    const next = mutator(readQueue(r[QUEUE_KEY]));
    await chrome.storage.local.set({ [QUEUE_KEY]: next });
    return next;
  });
}

/** Add (or replace) the task for an entry. */
export async function enqueueRetry(task: RemoteLogTask): Promise<void> {
  await mutate((queue) => [...queue.filter((t) => t.entryId !== task.entryId), task]);
}

export async function removeRetry(entryId: string): Promise<void> {
  await mutate((queue) => queue.filter((t) => t.entryId !== entryId));
}

export async function clearRetryQueue(): Promise<void> {
  await mutate(() => []);
}

/** Tasks whose delay has elapsed and that still have an attempt left. */
export async function getDueTasks(now = Date.now()): Promise<RemoteLogTask[]> {
  const queue = await getRetryQueue();
  return queue.filter((t) => t.nextAttemptAt <= now && t.attempts < MAX_ATTEMPTS);
}

/** Earliest `nextAttemptAt` still in the queue, or `null` when it is empty. */
export async function getNextDueAt(): Promise<number | null> {
  const queue = await getRetryQueue();
  if (queue.length === 0) return null;
  return queue.reduce((min, t) => Math.min(min, t.nextAttemptAt), Number.POSITIVE_INFINITY);
}
