import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  showInlineButton,
  hideInlineButton,
  repositionButton,
  showToast,
  destroyInlineUi,
  isInlineButtonTarget,
} from '../shared/filler/inlineButton';

const HOST_TAG = 'jobfill-ui';

/**
 * The UI lives in a **closed** shadow root, so there is deliberately no public
 * way into it — that is the property under test (NFR-4). To assert on the
 * button and the toast we intercept `attachShadow` and keep the root the
 * production code creates, passing its `init` through untouched so the root
 * really is closed for everybody else.
 */
let shadow: ShadowRoot | null = null;

const realAttachShadow = Element.prototype.attachShadow;

/**
 * happy-dom has no layout: rects are all-zero and `offsetWidth`/`offsetHeight`
 * are always 0. Anchor geometry is therefore stubbed per test.
 */
const ANCHOR_RECT = { x: 100, y: 200, width: 180, height: 32, top: 200, left: 100, right: 280, bottom: 232 };

function stubRect(rect: Partial<typeof ANCHOR_RECT> = {}): void {
  const full = { ...ANCHOR_RECT, ...rect };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...full, toJSON: () => full }) as DOMRect,
  );
}

function host(): HTMLElement | null {
  return document.querySelector(HOST_TAG);
}

function button(): HTMLButtonElement | null {
  return shadow?.querySelector('button.btn') ?? null;
}

function toast(): HTMLElement | null {
  return shadow?.querySelector('.toast') ?? null;
}

function anchor(): HTMLInputElement {
  const el = document.createElement('input');
  el.name = 'first_name';
  document.body.appendChild(el);
  return el;
}

/**
 * The press debounce compares `Date.now()` against module-level state that
 * outlives a single test. Fake timers freeze the clock, so without this every
 * test after the first press would be swallowed by the debounce. Each test
 * therefore starts a full minute after the previous one.
 */
let clock = Date.UTC(2026, 0, 1);

beforeEach(() => {
  clock += 60_000;
  vi.useFakeTimers();
  vi.setSystemTime(clock);
  shadow = null;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = realAttachShadow.call(this, init);
    shadow = root;
    return root;
  });
  stubRect();
});

afterEach(() => {
  destroyInlineUi();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.querySelectorAll(HOST_TAG).forEach((el) => el.remove());
});

// ─── NFR-4: page isolation ───────────────────────────────────────────────────

describe('page isolation (NFR-4)', () => {
  it('puts nothing in the page until the UI is actually needed', () => {
    expect(host()).toBeNull();
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });

  it('mounts a single host element on <html>, not <body>', () => {
    showInlineButton(anchor(), () => {});
    expect(host()).not.toBeNull();
    expect(host()!.parentElement).toBe(document.documentElement);
    expect(document.querySelectorAll(HOST_TAG)).toHaveLength(1);
  });

  it('the shadow root is closed — the page cannot reach our UI', () => {
    showInlineButton(anchor(), () => {});
    expect(host()!.shadowRoot).toBeNull();
    expect(shadow).not.toBeNull();
    expect(button()).not.toBeNull();
  });

  it('never injects a stylesheet into the page', () => {
    showInlineButton(anchor(), () => {});
    showToast('done');
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
    expect(document.body.querySelectorAll('style')).toHaveLength(0);
    // …the CSS lives inside the shadow root instead
    expect(shadow!.querySelector('style')!.textContent).toContain('.btn');
  });

  it('marks the host and makes it non-interactive', () => {
    showInlineButton(anchor(), () => {});
    expect(host()!.getAttribute('data-jobfill')).toBe('ui');
    expect(host()!.style.pointerEvents).toBe('none');
    expect(host()!.style.position).toBe('fixed');
    expect(host()!.style.width).toBe('0px');
    expect(host()!.style.height).toBe('0px');
  });

  it('reuses the host across mounts instead of stacking hosts', () => {
    showInlineButton(anchor(), () => {});
    const first = host();
    showToast('hello');
    showInlineButton(anchor(), () => {});
    expect(host()).toBe(first);
    expect(document.querySelectorAll(HOST_TAG)).toHaveLength(1);
  });

  it('gives up quietly when the document has no root element to mount on', () => {
    const el = anchor();
    const html = document.documentElement;
    html.remove();
    try {
      expect(document.documentElement).toBeNull();
      expect(document.body).toBeNull();
      expect(() => showInlineButton(el, () => {})).not.toThrow();
      expect(() => showToast('hi')).not.toThrow();
      expect(shadow).toBeNull();
    } finally {
      document.appendChild(html);
    }
    expect(host()).toBeNull();
  });

  it('re-mounts after the page rips the host out of the DOM', () => {
    showInlineButton(anchor(), () => {});
    const first = host()!;
    first.remove();
    showInlineButton(anchor(), () => {});
    expect(host()).not.toBeNull();
    expect(host()).not.toBe(first);
  });
});

// ─── The button itself ───────────────────────────────────────────────────────

describe('showInlineButton', () => {
  it('builds an accessible button with an icon and a label', () => {
    showInlineButton(anchor(), () => {});
    const btn = button()!;
    expect(btn.type).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Fill this form with JobFill');
    expect(btn.title).toBe('Fill this form with JobFill');
    expect(btn.querySelector('span')!.textContent).toBe('Fill');
  });

  it('draws the icon as SVG nodes, never through innerHTML', () => {
    showInlineButton(anchor(), () => {});
    const svg = button()!.querySelector('svg')!;
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('path')!.getAttribute('d')).toMatch(/^M13\.5 1\.2/);
  });

  it('reuses one button element across focus changes', () => {
    const a = anchor();
    const b = anchor();
    showInlineButton(a, () => {});
    const first = button();
    showInlineButton(b, () => {});
    expect(button()).toBe(first);
    expect(shadow!.querySelectorAll('button')).toHaveLength(1);
  });

  it('rebinds the callback on every show', () => {
    const first = vi.fn();
    const second = vi.fn();
    showInlineButton(anchor(), first);
    showInlineButton(anchor(), second);
    button()!.click();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

// ─── Pressing it ─────────────────────────────────────────────────────────────

describe('press handling', () => {
  function press(btn: HTMLButtonElement, type: 'pointerdown' | 'click'): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    btn.dispatchEvent(event);
    return event;
  }

  it('invokes the callback on click', () => {
    const onFill = vi.fn();
    showInlineButton(anchor(), onFill);
    button()!.click();
    expect(onFill).toHaveBeenCalledTimes(1);
  });

  it('invokes the callback on pointerdown', () => {
    const onFill = vi.fn();
    showInlineButton(anchor(), onFill);
    press(button()!, 'pointerdown');
    expect(onFill).toHaveBeenCalledTimes(1);
  });

  it('collapses the pointerdown + click pair of one physical press', () => {
    const onFill = vi.fn();
    showInlineButton(anchor(), onFill);
    press(button()!, 'pointerdown');
    press(button()!, 'click');
    expect(onFill).toHaveBeenCalledTimes(1);
  });

  it('accepts a second press once the debounce window has passed', () => {
    const onFill = vi.fn();
    showInlineButton(anchor(), onFill);
    press(button()!, 'pointerdown');
    vi.advanceTimersByTime(700);
    press(button()!, 'pointerdown');
    expect(onFill).toHaveBeenCalledTimes(2);
  });

  it('still refuses a second press just inside the debounce window', () => {
    const onFill = vi.fn();
    showInlineButton(anchor(), onFill);
    press(button()!, 'pointerdown');
    vi.advanceTimersByTime(699);
    press(button()!, 'pointerdown');
    expect(onFill).toHaveBeenCalledTimes(1);
  });

  it('swallows the event so the page never sees the press', () => {
    showInlineButton(anchor(), () => {});
    const event = press(button()!, 'pointerdown');
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not throw when the button is pressed after hide', () => {
    showInlineButton(anchor(), () => {});
    const btn = button()!;
    hideInlineButton();
    expect(() => btn.click()).not.toThrow();
  });
});

// ─── Positioning ─────────────────────────────────────────────────────────────

describe('placement', () => {
  /** Layout is stubbed, so read back the inline styles the code wrote. */
  function position(): { left: number; top: number } {
    const btn = button()!;
    return { left: parseInt(btn.style.left, 10), top: parseInt(btn.style.top, 10) };
  }

  it('sits just to the right of the anchor', () => {
    showInlineButton(anchor(), () => {});
    // right(280) + 6 gap
    expect(position().left).toBe(286);
  });

  it('is vertically centred on the anchor', () => {
    showInlineButton(anchor(), () => {});
    // top(200) + (height 32 - fallback button height 24) / 2
    expect(position().top).toBe(204);
  });

  it('flips to the left of the anchor when it would overflow the viewport', () => {
    stubRect({ left: 900, right: 1020, width: 120 });
    showInlineButton(anchor(), () => {});
    // window.innerWidth is 1024 → 1020 + 6 + 56 > 1018, so flip: 900 - 56 - 6
    expect(position().left).toBe(838);
  });

  it('clamps to the left edge when neither side fits', () => {
    stubRect({ left: 0, right: 1024, width: 1024 });
    showInlineButton(anchor(), () => {});
    expect(position().left).toBe(4);
  });

  it('clamps to the top edge for an anchor scrolled above the viewport', () => {
    stubRect({ top: -500, bottom: -468, height: 32 });
    showInlineButton(anchor(), () => {});
    expect(position().top).toBe(4);
  });

  it('clamps to the bottom edge for an anchor below the fold', () => {
    stubRect({ top: 5000, bottom: 5032, height: 32 });
    showInlineButton(anchor(), () => {});
    // window.innerHeight is 768 → 768 - 24 - 4
    expect(position().top).toBe(740);
  });

  it('uses the measured button size when the browser reports one', () => {
    showInlineButton(anchor(), () => {});
    Object.defineProperty(button()!, 'offsetWidth', { configurable: true, value: 80 });
    Object.defineProperty(button()!, 'offsetHeight', { configurable: true, value: 40 });
    stubRect({ left: 900, right: 1000, width: 100, top: 200, height: 32 });

    repositionButton(anchor());
    // flip: 900 - 80 - 6; centre: 200 + (32 - 40) / 2
    expect(position()).toEqual({ left: 814, top: 196 });
  });

  it('repositions an existing button', () => {
    showInlineButton(anchor(), () => {});
    expect(position().left).toBe(286);
    stubRect({ right: 500, left: 320 });
    repositionButton(anchor());
    expect(position().left).toBe(506);
  });

  it('repositioning without a visible button is a no-op', () => {
    expect(() => repositionButton(anchor())).not.toThrow();
    expect(host()).toBeNull();
  });

  it('repositioning after hide is a no-op', () => {
    showInlineButton(anchor(), () => {});
    hideInlineButton();
    expect(() => repositionButton(anchor())).not.toThrow();
  });
});

// ─── Hiding / unmounting ─────────────────────────────────────────────────────

describe('hideInlineButton', () => {
  it('removes the button and unmounts the host when nothing else is visible', () => {
    showInlineButton(anchor(), () => {});
    hideInlineButton();
    expect(host()).toBeNull();
  });

  it('keeps the host mounted while a toast is still on screen', () => {
    showToast('Filled 7 fields', 3000);
    showInlineButton(anchor(), () => {});
    hideInlineButton();
    expect(host()).not.toBeNull();
    expect(toast()).not.toBeNull();
  });

  it('is safe to call when nothing is mounted', () => {
    expect(() => hideInlineButton()).not.toThrow();
    expect(host()).toBeNull();
  });

  it('drops the callback reference so a stale press cannot fire it', () => {
    const onFill = vi.fn();
    showInlineButton(anchor(), onFill);
    const btn = button()!;
    hideInlineButton();
    btn.click();
    expect(onFill).not.toHaveBeenCalled();
  });
});

// ─── Toast ───────────────────────────────────────────────────────────────────

describe('showToast', () => {
  it('renders the message with role=status', () => {
    showToast('Filled 7 fields');
    expect(toast()!.textContent).toBe('Filled 7 fields');
    expect(toast()!.getAttribute('role')).toBe('status');
  });

  it('fades in on the second animation frame', () => {
    showToast('hi');
    expect(toast()!.classList.contains('visible')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(toast()!.classList.contains('visible')).toBe(true);
  });

  it('fades out after the given duration and then removes itself', () => {
    showToast('hi', 1000);
    vi.advanceTimersByTime(50);
    expect(toast()!.classList.contains('visible')).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(toast()!.classList.contains('visible')).toBe(false);
    expect(toast()).not.toBeNull();

    vi.advanceTimersByTime(220);
    expect(toast()).toBeNull();
    expect(host()).toBeNull();
  });

  it('uses a 3.5 s default duration', () => {
    showToast('hi');
    vi.advanceTimersByTime(3499);
    expect(toast()!.classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast()!.classList.contains('visible')).toBe(false);
  });

  it('reuses the element and restarts the timer when a second toast arrives', () => {
    showToast('first', 1000);
    vi.advanceTimersByTime(50);
    const first = toast();

    showToast('second', 1000);
    expect(toast()).toBe(first);
    expect(toast()!.textContent).toBe('second');
    expect(shadow!.querySelectorAll('.toast')).toHaveLength(1);

    // The first toast's 1 s timer must have been cancelled.
    vi.advanceTimersByTime(999);
    expect(toast()!.classList.contains('visible')).toBe(true);
  });

  it('keeps the host mounted while the button is still shown', () => {
    showInlineButton(anchor(), () => {});
    showToast('hi', 1000);
    vi.advanceTimersByTime(1000 + 220 + 50);
    expect(toast()).toBeNull();
    expect(host()).not.toBeNull();
    expect(button()).not.toBeNull();
  });

  it('re-creates the toast after it faded out', () => {
    showToast('first', 100);
    vi.advanceTimersByTime(100 + 220 + 50);
    expect(toast()).toBeNull();

    showToast('second', 100);
    expect(toast()!.textContent).toBe('second');
  });
});

// ─── isInlineButtonTarget ────────────────────────────────────────────────────

describe('isInlineButtonTarget', () => {
  it('is false before anything is mounted', () => {
    expect(isInlineButtonTarget(document.body)).toBe(false);
  });

  it('recognises the host element — what a closed shadow root retargets to', () => {
    showInlineButton(anchor(), () => {});
    expect(isInlineButtonTarget(host())).toBe(true);
  });

  it('does not claim ordinary page elements', () => {
    const el = anchor();
    showInlineButton(el, () => {});
    expect(isInlineButtonTarget(el)).toBe(false);
    expect(isInlineButtonTarget(document.body)).toBe(false);
  });

  it('is false for null and for non-Node targets', () => {
    showInlineButton(anchor(), () => {});
    expect(isInlineButtonTarget(null)).toBe(false);
    expect(isInlineButtonTarget(new EventTarget())).toBe(false);
  });

  it('goes back to false once the UI is torn down', () => {
    showInlineButton(anchor(), () => {});
    const h = host();
    hideInlineButton();
    expect(isInlineButtonTarget(h)).toBe(false);
  });
});

// ─── destroyInlineUi ─────────────────────────────────────────────────────────

describe('destroyInlineUi', () => {
  it('removes every trace of the extension from the page', () => {
    showInlineButton(anchor(), () => {});
    showToast('hi');
    destroyInlineUi();

    expect(host()).toBeNull();
    expect(document.querySelectorAll(HOST_TAG)).toHaveLength(0);
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });

  it('cancels the pending toast timers', () => {
    showToast('hi', 1000);
    destroyInlineUi();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(host()).toBeNull();
  });

  it('is safe to call twice, and on a page that never used the UI', () => {
    expect(() => destroyInlineUi()).not.toThrow();
    showInlineButton(anchor(), () => {});
    destroyInlineUi();
    expect(() => destroyInlineUi()).not.toThrow();
  });

  it('leaves the module usable afterwards', () => {
    showInlineButton(anchor(), () => {});
    destroyInlineUi();
    const onFill = vi.fn();
    showInlineButton(anchor(), onFill);
    expect(button()).not.toBeNull();
    button()!.click();
    expect(onFill).toHaveBeenCalledTimes(1);
  });
});
