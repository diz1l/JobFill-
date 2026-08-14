/**
 * Frame-addressed tab messaging — the caller half of PROJECT_AUDIT §3 P0-5.
 *
 * `chrome.tabs.sendMessage(tabId, msg)` without a `frameId` reaches *every*
 * frame of the tab, but the sender only ever sees the **first** `sendResponse`.
 * On LinkedIn Easy Apply / Greenhouse / Workable embeds the form lives in an
 * iframe while the top frame answers "nothing here" first, so the popup reported
 * "0 filled" for a form it had just filled.
 *
 * The first fix enumerated the frames with `webNavigation.getAllFrames` and
 * asked each one separately. It worked, but `webNavigation` makes Chrome show
 * "Read your browsing history" at install time — a disproportionate price for an
 * autofiller, and a direct contradiction of NFR-2.
 *
 * This module inverts the direction instead, which needs no permission at all:
 *
 *   1. one **broadcast** `tabs.sendMessage` carrying a unique `requestId`;
 *   2. every frame that has something to say does the work and answers with
 *      `chrome.runtime.sendMessage` — *not* `sendResponse`, so no answer can
 *      shadow another;
 *   3. this side listens on `chrome.runtime.onMessage`, keeps the replies whose
 *      `requestId` matches, and aggregates when the collection window closes.
 *
 * The reply's own frame arrives in `sender.frameId`, so a frame never has to
 * know (or claim) its id, and the caller can address follow-ups (`FILL_ANSWERS`,
 * `FILL_COVER_TEXT`) straight back at it. This is strictly more information than
 * the old path had: *all* frames report now, not just the fastest one.
 *
 * Question ids (`oq_0`, `oq_1`, …) are only unique *within* a frame, so they are
 * namespaced with the frame id on the way out and un-namespaced on the way back
 * (see {@link qualify} / {@link splitAnswersByFrame}). Answers can therefore
 * never land in the wrong frame's textarea.
 *
 * It sits next to the UI rather than in `shared/` because both extension pages
 * and the background worker import it; it stays free of React and of any DOM
 * assumption so the service worker can use it as-is.
 */

import {
  FRAME_REPLY,
  type FrameReplyMessage,
  type FrameRequest,
  type OpenQuestion,
  type PopupToContentMessage,
} from '../../shared/messages';
import type { FillSummary, JobInfo } from '../../shared/types';

/** "Every frame of the tab" — the absence of a `frameId` in `tabs.sendMessage`. */
const BROADCAST = -1;

/** Separator between the frame id and the frame-local question id. */
const ID_SEPARATOR = '::';

/**
 * How long replies are collected after a broadcast.
 *
 * A frame answers after `chrome.storage` reads (single-digit ms warm, tens of ms
 * cold) plus one synchronous `fillPage` pass — tens of ms on a large form. 400 ms
 * leaves roughly an order of magnitude of headroom for a busy main thread while
 * staying inside the ~500 ms that still reads as "instant" for a click.
 *
 * Waiting costs nothing the user can see: the page highlights every filled field
 * the moment its frame is done, so the window only delays the *summary* in the
 * popup. It is also the only way to know a slow frame exists at all — without
 * `webNavigation` there is no frame count to wait for, so the deadline is the
 * termination condition. The window is cut short when Chrome tells us there is
 * no listener in the tab at all (see {@link ask}), so the unreachable case stays
 * instant.
 */
export const COLLECT_WINDOW_MS = 400;

/**
 * Shown when every frame stayed silent. This is *not* the same as "cannot
 * connect": with the content script's "nothing to contribute → don't answer"
 * rule, silence is the normal outcome on a page without a form.
 */
export const NO_FIELDS_MESSAGE = 'No form fields found on this page.';

/**
 * Shown when the broadcast found no listener whatsoever — the content script is
 * not in this tab (excluded origin, sign-in page, PDF viewer, or a tab that was
 * open before the extension was installed / updated).
 */
export const UNREACHABLE_MESSAGE = 'Could not reach this page. Reload the tab, then try again.';

const EMPTY_SUMMARY: FillSummary = {
  total: 0,
  high: 0,
  medium: 0,
  unrecognized: 0,
  fileInputs: 0,
  aiQuestions: 0,
};

// ─── Content-script reply shapes ──────────────────────────────────────────────

type FillReply =
  | { type: 'FILL_RESULT'; summary: FillSummary; openQuestions?: OpenQuestion[] }
  | { error: string };

interface JobInfoReply {
  type: 'JOB_INFO';
  jobInfo: JobInfo;
}

interface CoverReply {
  success: boolean;
  error?: string;
}

interface AnswersReply {
  filled: number;
}

export interface FillOutcome {
  /** Sum over every frame that answered. */
  summary: FillSummary;
  /** Questions from all answering frames, ids namespaced by frame. */
  openQuestions: OpenQuestion[];
  /** Frame to address for follow-ups; `null` when nobody answered. */
  primaryFrameId: number | null;
  /** How many frames produced a `FILL_RESULT`. */
  answered: number;
  /** `false` when the tab has no content script at all — never "no fields". */
  reachable: boolean;
  /** First error a frame reported (e.g. "Profile not found."). */
  error?: string;
}

// ─── Request/response plumbing ────────────────────────────────────────────────

/**
 * `lastError` messages that mean "nothing in this tab is listening", as opposed
 * to "a listener declined to answer" ("The message port closed before a response
 * was received"), which is the normal case here — content frames answer over the
 * runtime bus and never call `sendResponse`.
 */
const UNREACHABLE_ERROR = /receiving end does not exist|could not establish connection|no tab with id/i;

let requestCounter = 0;

/**
 * Unique per broadcast. The counter alone would collide across contexts — the
 * popup and the background worker can both be filling the same tab — so the
 * random suffix is what actually separates them; the counter keeps ids unique
 * inside one context even within the same millisecond.
 */
function nextRequestId(): string {
  requestCounter += 1;
  return `jf-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface FrameReply<T> {
  frameId: number;
  value: T;
}

interface AskResult<T> {
  replies: FrameReply<T>[];
  /** At least one frame of the tab received the message. */
  reachable: boolean;
}

function isFrameReply(value: unknown): value is FrameReplyMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FrameReplyMessage>;
  return candidate.type === FRAME_REPLY && typeof candidate.requestId === 'string';
}

/**
 * Hand the request to the tab. The callback exists only to read
 * `chrome.runtime.lastError` — that is what marks the error as handled, and a
 * broadcast that no frame answers *always* produces one by design.
 */
function deliver(
  tabId: number,
  request: FrameRequest,
  target: number,
  onDelivered: (unreachable: boolean) => void,
): void {
  const done = () => {
    const message = chrome.runtime.lastError?.message;
    onDelivered(message !== undefined && UNREACHABLE_ERROR.test(message));
  };
  try {
    if (target === BROADCAST) chrome.tabs.sendMessage(tabId, request, done);
    else chrome.tabs.sendMessage(tabId, request, { frameId: target }, done);
  } catch {
    // Tab closed between the query and the send.
    onDelivered(true);
  }
}

/**
 * Ask a tab and collect what comes back over the runtime bus.
 *
 * `target` is a frame id for an addressed request (which has exactly one
 * possible answer, so it resolves as soon as that answer lands) or `BROADCAST`,
 * where the collection window is the only termination condition.
 *
 * Never rejects: silence resolves to an empty list, which callers read as "no
 * frame had anything to contribute".
 */
function ask<T>(
  tabId: number,
  message: PopupToContentMessage,
  target: number = BROADCAST,
): Promise<AskResult<T>> {
  const requestId = nextRequestId();
  const request: FrameRequest = { ...message, requestId };
  const replies: FrameReply<T>[] = [];

  return new Promise((resolve) => {
    let settled = false;
    let reachable = true;

    const onReply = (raw: unknown, sender: chrome.runtime.MessageSender): void => {
      // Someone else's broadcast, or a stale one from the previous click.
      if (!isFrameReply(raw) || raw.requestId !== requestId) return;
      // A content frame always has a tab; anything else is not an answer to this.
      if (sender.tab?.id !== tabId) return;

      replies.push({ frameId: sender.frameId ?? BROADCAST, value: raw.payload as T });
      if (target !== BROADCAST) settle();
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onReply);
      resolve({ replies, reachable });
    };

    chrome.runtime.onMessage.addListener(onReply);
    const timer = setTimeout(settle, COLLECT_WINDOW_MS);

    deliver(tabId, request, target, (unreachable) => {
      if (!unreachable) return;
      // Nothing in the tab can ever answer — do not sit out the window.
      reachable = false;
      settle();
    });
  });
}

// ─── Question id namespacing ──────────────────────────────────────────────────

function qualify(frameId: number, questionId: string): string {
  return `${frameId}${ID_SEPARATOR}${questionId}`;
}

/**
 * Regroup a flat `{ questionId: answer }` map — the shape the background returns
 * — into one map per frame, with the frame-local ids restored.
 */
export function splitAnswersByFrame(
  answers: Record<string, string>,
): Map<number, Record<string, string>> {
  const byFrame = new Map<number, Record<string, string>>();

  for (const [qualifiedId, answer] of Object.entries(answers)) {
    const cut = qualifiedId.indexOf(ID_SEPARATOR);
    const frameId = cut === -1 ? BROADCAST : Number(qualifiedId.slice(0, cut));
    const localId = cut === -1 ? qualifiedId : qualifiedId.slice(cut + ID_SEPARATOR.length);
    const target = Number.isNaN(frameId) ? BROADCAST : frameId;

    const bucket = byFrame.get(target) ?? {};
    bucket[localId] = answer;
    byFrame.set(target, bucket);
  }

  return byFrame;
}

// ─── Public operations ────────────────────────────────────────────────────────

/**
 * FR-2.1 — fill the form wherever it lives in the tab.
 *
 * The counters of all answering frames are summed, and the frame with the
 * largest `summary.total` becomes the target for follow-up messages (a page can
 * legitimately have two form frames — the biggest one is the application).
 */
export async function fillAllFrames(tabId: number, profileId: string): Promise<FillOutcome> {
  const { replies, reachable } = await ask<FillReply>(tabId, { type: 'FILL_FORM', profileId });

  const summary: FillSummary = { ...EMPTY_SUMMARY };
  const openQuestions: OpenQuestion[] = [];
  let primaryFrameId: number | null = null;
  let primaryTotal = -1;
  let answered = 0;
  let error: string | undefined;

  for (const { frameId, value } of replies) {
    if ('error' in value) {
      // The frame is alive but could not fill (e.g. no profile). Keep the first
      // reason; it is more actionable than "nothing found".
      error ??= value.error;
      continue;
    }

    answered++;
    summary.total += value.summary.total;
    summary.high += value.summary.high;
    summary.medium += value.summary.medium;
    summary.unrecognized += value.summary.unrecognized;
    summary.fileInputs += value.summary.fileInputs;
    summary.aiQuestions += value.summary.aiQuestions;

    for (const question of value.openQuestions ?? []) {
      openQuestions.push({ id: qualify(frameId, question.id), text: question.text });
    }

    if (value.summary.total > primaryTotal) {
      primaryTotal = value.summary.total;
      primaryFrameId = frameId;
    }
  }

  return {
    summary,
    openQuestions,
    primaryFrameId,
    answered,
    reachable,
    ...(error ? { error } : {}),
  };
}

/** The reason to show when {@link fillAllFrames} produced no result at all. */
export function fillFailureMessage(outcome: FillOutcome): string {
  return outcome.error ?? (outcome.reachable ? NO_FIELDS_MESSAGE : UNREACHABLE_MESSAGE);
}

/**
 * FR-4.1 — job info for the cover-letter prompt and the journal entry.
 * Frames answer independently; the richest answer wins — never the fastest.
 */
export async function readJobInfo(tabId: number): Promise<JobInfo | null> {
  const { replies } = await ask<JobInfoReply>(tabId, { type: 'EXTRACT_JOB_INFO' });

  let best: JobInfo | null = null;
  let bestScore = 0;
  for (const { value } of replies) {
    const info = value?.jobInfo;
    if (!info) continue;
    const score = (info.company ? 2 : 0) + (info.position ? 2 : 0) + (info.description ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = info;
    }
  }
  return best;
}

/**
 * FR-5.2 — insert the generated letter. Addressed to the frame that owns the
 * form when we know it, so the text cannot land in a chat widget in a sibling
 * frame. Broadcasts when no fill has happened yet in this popup session.
 */
export async function insertCoverText(
  tabId: number,
  text: string,
  frameId: number | null,
): Promise<CoverReply> {
  const message: PopupToContentMessage = { type: 'FILL_COVER_TEXT', text };

  if (frameId !== null && frameId !== BROADCAST) {
    const addressed = await ask<CoverReply>(tabId, message, frameId);
    // An answer means that frame wrote the text.
    if (addressed.replies.length > 0) return addressed.replies[0].value;
    // Silence means it has no field it can justify writing into — and, crucially,
    // that it wrote nothing. Falling back to a broadcast can therefore not
    // double-insert, and it covers the case where the letter field sits outside
    // the frame that owns the rest of the form.
  }

  const { replies } = await ask<CoverReply>(tabId, message);
  // Every frame with a usable field answers; one success is enough to report.
  const written = replies.find(({ value }) => value?.success);
  if (written) return written.value;

  return {
    success: false,
    error: 'No cover letter field found. Click the field on the page, then insert again.',
  };
}

/**
 * FR-5.3 — deliver AI answers back to the exact frames the questions came from.
 * Returns how many textareas were written.
 */
export async function sendAnswers(
  tabId: number,
  answers: Record<string, string>,
): Promise<number> {
  const perFrame = [...splitAnswersByFrame(answers)];

  const results = await Promise.all(
    perFrame.map(([frameId, frameAnswers]) =>
      ask<AnswersReply>(tabId, { type: 'FILL_ANSWERS', answers: frameAnswers }, frameId),
    ),
  );

  return results.reduce(
    (sum, { replies }) =>
      sum + replies.reduce((frames, { value }) => frames + (value?.filled ?? 0), 0),
    0,
  );
}
