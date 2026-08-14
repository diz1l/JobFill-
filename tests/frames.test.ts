import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  COLLECT_WINDOW_MS,
  NO_FIELDS_MESSAGE,
  UNREACHABLE_MESSAGE,
  fillAllFrames,
  fillFailureMessage,
  insertCoverText,
  readJobInfo,
  sendAnswers,
  splitAnswersByFrame,
} from '../entrypoints/ui/frames';
import { FRAME_REPLY, type FrameRequest } from '../shared/messages';
import type { FillSummary } from '../shared/types';

/**
 * P0-5 without `webNavigation`: the caller broadcasts one message to the whole
 * tab and collects the answers frames push back over `chrome.runtime.onMessage`.
 *
 * The fake below is the other half of that contract — a tab made of frames that
 * behave exactly like `entrypoints/content.ts`: a frame with nothing to say
 * stays silent, a frame with something to say answers on the runtime bus with
 * the `requestId` it was given, and the only thing that ever reaches the caller
 * through `tabs.sendMessage` is a `lastError`.
 */

const TAB = 7;

/** "Nothing to contribute" — the frame does not answer at all. */
const SILENT = Symbol('silent');

interface FakeFrame {
  frameId: number;
  /** Payload for a request, or {@link SILENT}. */
  answer: (message: FrameRequest) => unknown | typeof SILENT;
  /** How long this frame takes to produce it. */
  delayMs?: number;
}

interface Delivery {
  frameId: number | 'broadcast';
  message: FrameRequest;
}

/** Chrome's two distinguishable outcomes of a `tabs.sendMessage`. */
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const PORT_CLOSED = 'The message port closed before a response was received.';

let frames: FakeFrame[] = [];
let deliveries: Delivery[] = [];
let runtimeListeners: ((message: unknown, sender: chrome.runtime.MessageSender) => void)[] = [];

function dispatchToRuntime(message: unknown, sender: chrome.runtime.MessageSender): void {
  for (const listener of [...runtimeListeners]) listener(message, sender);
}

function installFakeChrome(): void {
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    onMessage: {
      addListener(fn: (m: unknown, s: chrome.runtime.MessageSender) => void) {
        runtimeListeners.push(fn);
      },
      removeListener(fn: (m: unknown, s: chrome.runtime.MessageSender) => void) {
        runtimeListeners = runtimeListeners.filter((l) => l !== fn);
      },
    },
  };

  const tabs = {
    sendMessage(
      tabId: number,
      message: FrameRequest,
      optionsOrCallback?: { frameId?: number } | (() => void),
      maybeCallback?: () => void,
    ) {
      const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      const callback =
        typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;

      const targets =
        options?.frameId === undefined
          ? frames
          : frames.filter((f) => f.frameId === options.frameId);

      deliveries.push({ frameId: options?.frameId ?? 'broadcast', message });

      for (const frame of targets) {
        setTimeout(() => {
          const payload = frame.answer(message);
          if (payload === SILENT) return;
          // This is `chrome.runtime.sendMessage` from the content script: the
          // frame never names itself, the browser attaches `sender.frameId`.
          dispatchToRuntime(
            { type: FRAME_REPLY, requestId: message.requestId, payload },
            { tab: { id: tabId }, frameId: frame.frameId } as chrome.runtime.MessageSender,
          );
        }, frame.delayMs ?? 0);
      }

      // The sender never gets a response: content frames answer on the runtime
      // bus and always return `false`. Only the failure mode differs.
      setTimeout(() => {
        if (!callback) return;
        runtime.lastError = { message: targets.length === 0 ? NO_RECEIVER : PORT_CLOSED };
        callback();
        runtime.lastError = undefined;
      }, 0);
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = { runtime, tabs };
}

/** Run out the collection window (plus slack for reply timers). */
async function settleWindow(extraMs = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS + extraMs);
}

function summary(over: Partial<FillSummary> = {}): FillSummary {
  return { total: 0, high: 0, medium: 0, unrecognized: 0, fileInputs: 0, aiQuestions: 0, ...over };
}

function fillResult(over: Partial<FillSummary>, openQuestions: { id: string; text: string }[] = []) {
  return { type: 'FILL_RESULT', summary: summary(over), openQuestions };
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  deliveries = [];
  runtimeListeners = [];
  installFakeChrome();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

// ─── Broadcast + aggregation ──────────────────────────────────────────────────

describe('fillAllFrames — aggregation across frames', () => {
  it('sums the counters of every frame that answers', async () => {
    frames = [
      { frameId: 0, answer: () => fillResult({ total: 3, high: 2, medium: 1 }) },
      {
        frameId: 12,
        answer: () => fillResult({ total: 5, high: 3, medium: 1, unrecognized: 1, fileInputs: 2, aiQuestions: 1 }),
      },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    const outcome = await promise;

    expect(outcome.answered).toBe(2);
    expect(outcome.summary).toEqual(
      summary({ total: 8, high: 5, medium: 2, unrecognized: 1, fileInputs: 2, aiQuestions: 1 }),
    );
    expect(outcome.reachable).toBe(true);
  });

  it('never addresses a single frame — one broadcast reaches the whole tab', async () => {
    frames = [
      { frameId: 0, answer: () => fillResult({ total: 1, high: 1 }) },
      { frameId: 9, answer: () => fillResult({ total: 2, high: 2 }) },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    await promise;

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].frameId).toBe('broadcast');
    expect(deliveries[0].message.type).toBe('FILL_FORM');
  });

  it('collects a frame that answers late, but still inside the window', async () => {
    frames = [
      { frameId: 0, answer: () => fillResult({ total: 1, high: 1 }) },
      { frameId: 4, answer: () => fillResult({ total: 6, high: 6 }), delayMs: COLLECT_WINDOW_MS - 50 },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    const outcome = await promise;

    expect(outcome.answered).toBe(2);
    expect(outcome.summary.high).toBe(7);
    expect(outcome.primaryFrameId).toBe(4);
  });

  it('drops the frame that has nothing to contribute instead of letting it win', async () => {
    // The bug P0-5 describes: the top frame is fastest and empty, the form is in
    // an iframe. With `sendResponse` the popup saw the top frame's answer only.
    frames = [
      { frameId: 0, answer: () => SILENT },
      { frameId: 3, answer: () => fillResult({ total: 4, high: 4 }), delayMs: 30 },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    const outcome = await promise;

    expect(outcome.answered).toBe(1);
    expect(outcome.summary.high).toBe(4);
    expect(outcome.primaryFrameId).toBe(3);
  });

  it('picks the frame with the largest total as the follow-up target', async () => {
    frames = [
      { frameId: 0, answer: () => fillResult({ total: 2, high: 2 }) },
      { frameId: 11, answer: () => fillResult({ total: 9, high: 9 }) },
      { frameId: 12, answer: () => fillResult({ total: 1, high: 1 }) },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();

    expect((await promise).primaryFrameId).toBe(11);
  });
});

// ─── Question id namespacing ──────────────────────────────────────────────────

describe('fillAllFrames — question ids', () => {
  it('namespaces identical ids from two frames so answers cannot cross over', async () => {
    frames = [
      {
        frameId: 0,
        answer: () => fillResult({ total: 1, aiQuestions: 1 }, [{ id: 'oq_0', text: 'Why us?' }]),
      },
      {
        frameId: 8,
        answer: () => fillResult({ total: 1, aiQuestions: 1 }, [{ id: 'oq_0', text: 'Notice period?' }]),
      },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    const outcome = await promise;

    expect(outcome.openQuestions).toEqual([
      { id: '0::oq_0', text: 'Why us?' },
      { id: '8::oq_0', text: 'Notice period?' },
    ]);
  });

  it('splits a flat answer map back into frame-local ids', () => {
    const byFrame = splitAnswersByFrame({
      '0::oq_0': 'a',
      '8::oq_0': 'b',
      '8::oq_1': 'c',
      oq_9: 'legacy',
    });

    expect(byFrame.get(0)).toEqual({ oq_0: 'a' });
    expect(byFrame.get(8)).toEqual({ oq_0: 'b', oq_1: 'c' });
    // An id without a frame prefix can only be broadcast.
    expect(byFrame.get(-1)).toEqual({ oq_9: 'legacy' });
  });

  it('routes each frame its own answers and sums what was written', async () => {
    const seen: Record<number, unknown> = {};
    frames = [
      {
        frameId: 0,
        answer: (m) => {
          if (m.type !== 'FILL_ANSWERS') return SILENT;
          seen[0] = m.answers;
          return { filled: 1 };
        },
      },
      {
        frameId: 8,
        answer: (m) => {
          if (m.type !== 'FILL_ANSWERS') return SILENT;
          seen[8] = m.answers;
          return { filled: 2 };
        },
      },
    ];

    const promise = sendAnswers(TAB, { '0::oq_0': 'a', '8::oq_0': 'b', '8::oq_1': 'c' });
    await settleWindow();

    expect(await promise).toBe(3);
    expect(seen[0]).toEqual({ oq_0: 'a' });
    expect(seen[8]).toEqual({ oq_0: 'b', oq_1: 'c' });
    // Addressed, not broadcast: a sibling frame never sees another's answers.
    expect(deliveries.map((d) => d.frameId).sort()).toEqual([0, 8]);
  });
});

// ─── Request correlation ──────────────────────────────────────────────────────

describe('request correlation', () => {
  it('ignores a reply that echoes a foreign requestId', async () => {
    frames = [
      {
        frameId: 0,
        answer: () => fillResult({ total: 3, high: 3 }),
      },
    ];
    // A frame from someone else's broadcast shouting on the same bus.
    const noise = setTimeout(() => {
      dispatchToRuntime(
        { type: FRAME_REPLY, requestId: 'someone-else', payload: fillResult({ total: 99, high: 99 }) },
        { tab: { id: TAB }, frameId: 5 } as chrome.runtime.MessageSender,
      );
    }, 10);

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    clearTimeout(noise);

    const outcome = await promise;
    expect(outcome.answered).toBe(1);
    expect(outcome.summary.high).toBe(3);
  });

  it('does not let a late reply from the previous click land in the next one', async () => {
    // First click: the frame takes longer than the window.
    frames = [
      { frameId: 0, answer: () => fillResult({ total: 7, high: 7 }), delayMs: COLLECT_WINDOW_MS + 100 },
    ];
    const first = fillAllFrames(TAB, 'p1');
    await settleWindow();
    expect((await first).answered).toBe(0);

    // Second click, while the first frame's answer is still in flight.
    frames = [{ frameId: 0, answer: () => fillResult({ total: 2, high: 2 }) }];
    const second = fillAllFrames(TAB, 'p1');
    await settleWindow();

    const outcome = await second;
    expect(outcome.answered).toBe(1);
    expect(outcome.summary.high).toBe(2); // not 9
  });

  it('ignores a reply that comes from another tab', async () => {
    frames = [{ frameId: 0, answer: () => fillResult({ total: 3, high: 3 }) }];
    const promise = fillAllFrames(TAB, 'p1');
    // Same requestId shape, wrong tab — cannot be an answer to this broadcast.
    runtimeListeners.forEach((l) =>
      l(
        { type: FRAME_REPLY, requestId: 'jf-anything', payload: fillResult({ total: 50, high: 50 }) },
        { tab: { id: TAB + 1 }, frameId: 0 } as chrome.runtime.MessageSender,
      ),
    );
    await settleWindow();

    expect((await promise).summary.high).toBe(3);
  });

  it('unsubscribes from the runtime bus once the window closes', async () => {
    frames = [{ frameId: 0, answer: () => fillResult({ total: 1, high: 1 }) }];
    const promise = fillAllFrames(TAB, 'p1');
    expect(runtimeListeners.length).toBe(1);
    await settleWindow();
    await promise;
    expect(runtimeListeners.length).toBe(0);
  });
});

// ─── The three distinct failure modes ─────────────────────────────────────────

describe('failure modes', () => {
  it('reports "no fields" when every frame stays silent', async () => {
    frames = [
      { frameId: 0, answer: () => SILENT },
      { frameId: 2, answer: () => SILENT },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    const outcome = await promise;

    expect(outcome.answered).toBe(0);
    expect(outcome.reachable).toBe(true);
    expect(outcome.summary).toEqual(summary());
    expect(fillFailureMessage(outcome)).toBe(NO_FIELDS_MESSAGE);
  });

  it('reports "not active on this page" when nothing in the tab listens', async () => {
    frames = [];

    const promise = fillAllFrames(TAB, 'p1');
    // No window to wait out: the delivery error already says nobody is there.
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await promise;

    expect(outcome.reachable).toBe(false);
    expect(fillFailureMessage(outcome)).toBe(UNREACHABLE_MESSAGE);
    expect(fillFailureMessage(outcome)).not.toBe(NO_FIELDS_MESSAGE);
  });

  it('surfaces a frame error verbatim instead of "no fields"', async () => {
    frames = [
      { frameId: 0, answer: () => ({ error: 'Profile not found.' }) },
      { frameId: 2, answer: () => SILENT },
    ];

    const promise = fillAllFrames(TAB, 'p1');
    await settleWindow();
    const outcome = await promise;

    expect(outcome.answered).toBe(0);
    expect(outcome.error).toBe('Profile not found.');
    expect(fillFailureMessage(outcome)).toBe('Profile not found.');
  });
});

// ─── Job info ─────────────────────────────────────────────────────────────────

describe('readJobInfo', () => {
  it('keeps the richest answer, not the fastest', async () => {
    frames = [
      { frameId: 0, answer: () => ({ type: 'JOB_INFO', jobInfo: { description: 'Some page' } }) },
      {
        frameId: 6,
        answer: () => ({
          type: 'JOB_INFO',
          jobInfo: { company: 'Acme', position: 'Frontend Engineer' },
        }),
        delayMs: 120,
      },
    ];

    const promise = readJobInfo(TAB);
    await settleWindow();

    expect(await promise).toEqual({ company: 'Acme', position: 'Frontend Engineer' });
  });

  it('returns null when no frame found anything worth having', async () => {
    frames = [{ frameId: 0, answer: () => ({ type: 'JOB_INFO', jobInfo: {} }) }];

    const promise = readJobInfo(TAB);
    await settleWindow();

    expect(await promise).toBeNull();
  });
});

// ─── Cover letter ─────────────────────────────────────────────────────────────

describe('insertCoverText', () => {
  it('addresses the frame that owned the form and resolves as soon as it answers', async () => {
    frames = [
      { frameId: 0, answer: () => SILENT },
      { frameId: 4, answer: () => ({ success: true }), delayMs: 20 },
    ];

    const promise = insertCoverText(TAB, 'Dear team', 4);
    // Well inside the collection window: an addressed request has one answer.
    await vi.advanceTimersByTimeAsync(30);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(deliveries).toEqual([
      { frameId: 4, message: expect.objectContaining({ type: 'FILL_COVER_TEXT' }) },
    ]);
  });

  it('falls back to a broadcast when the addressed frame has no field', async () => {
    frames = [
      { frameId: 9, answer: () => ({ success: true }) },
      { frameId: 4, answer: () => SILENT },
    ];

    const promise = insertCoverText(TAB, 'Dear team', 4);
    await settleWindow(); // addressed attempt times out
    await settleWindow(); // broadcast
    const result = await promise;

    expect(result.success).toBe(true);
    expect(deliveries.map((d) => d.frameId)).toEqual([4, 'broadcast']);
  });

  it('explains itself when no frame has a field it can justify', async () => {
    frames = [{ frameId: 0, answer: () => SILENT }];

    const promise = insertCoverText(TAB, 'Dear team', null);
    await settleWindow();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No cover letter field found/);
  });
});
