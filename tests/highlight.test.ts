import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  highlightField,
  removeAllHighlights,
  removeStyles,
  activeHighlightCount,
} from '../shared/filler/highlight';

const STYLE_ID = '__jobfill-styles';
const DISMISS_ATTR = 'data-jobfill-dismiss';

function styleEl(): HTMLElement | null {
  return document.getElementById(STYLE_ID);
}

function input(id = 'f'): HTMLInputElement {
  const el = document.createElement('input');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  removeAllHighlights();
  vi.useRealTimers();
  document.body.innerHTML = '';
  styleEl()?.remove();
});

describe('stylesheet lifecycle', () => {
  it('injects nothing until the first highlight', () => {
    expect(styleEl()).toBeNull();
  });

  it('injects a single <style> into the head on the first highlight', () => {
    highlightField(input(), 'high', 1000);
    expect(styleEl()).not.toBeNull();
    expect(styleEl()!.parentElement).toBe(document.head);
    expect(styleEl()!.textContent).toContain('__jobfill-high');
  });

  it('does not inject a second <style> for a second highlight', () => {
    highlightField(input('a'), 'high', 1000);
    highlightField(input('b'), 'medium', 1000);
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
  });

  it('removes the stylesheet as soon as the last highlight is dismissed', () => {
    highlightField(input('a'), 'high', 1000);
    highlightField(input('b'), 'medium', 1000);
    vi.advanceTimersByTime(1000);
    expect(activeHighlightCount()).toBe(0);
    expect(styleEl()).toBeNull();
  });

  it('keeps the stylesheet while at least one highlight survives', () => {
    highlightField(input('a'), 'high', 500);
    highlightField(input('b'), 'medium', 5000);
    vi.advanceTimersByTime(500);
    expect(activeHighlightCount()).toBe(1);
    expect(styleEl()).not.toBeNull();
  });

  it('removeStyles() takes the <style> out of the page (NFR-4)', () => {
    highlightField(input(), 'high', 1000);
    expect(styleEl()).not.toBeNull();
    removeStyles();
    expect(styleEl()).toBeNull();
  });

  it('removeStyles() is safe when nothing was ever injected', () => {
    expect(() => removeStyles()).not.toThrow();
    expect(styleEl()).toBeNull();
  });

  it('skips the injection entirely when there is nowhere to put it', () => {
    const el = input();
    const html = document.documentElement;
    html.remove();
    try {
      expect(document.head).toBeNull();
      expect(document.documentElement).toBeNull();
      expect(() => highlightField(el, 'high', 1000)).not.toThrow();
      // The class is still applied — only the stylesheet is skipped.
      expect(el.classList.contains('__jobfill-high')).toBe(true);
    } finally {
      document.appendChild(html);
    }
    expect(styleEl()).toBeNull();
  });

  it('falls back to <html> when the document has no <head>', () => {
    const head = document.head;
    head.remove();
    expect(document.head).toBeNull();
    try {
      highlightField(input(), 'high', 1000);
      expect(styleEl()!.parentElement).toBe(document.documentElement);
    } finally {
      styleEl()?.remove();
      document.documentElement.insertBefore(head, document.documentElement.firstChild);
    }
  });
});

describe('highlightField', () => {
  const confidences = ['high', 'medium', 'low', 'none', 'file', 'ai'] as const;
  for (const confidence of confidences) {
    it(`applies the __jobfill-${confidence} class`, () => {
      const el = input();
      highlightField(el, confidence, 1000);
      expect(el.classList.contains(`__jobfill-${confidence}`)).toBe(true);
      expect(el.getAttribute(DISMISS_ATTR)).toBe('1');
      expect(activeHighlightCount()).toBe(1);
    });
  }

  it('tracks several fields at once', () => {
    highlightField(input('a'), 'high', 1000);
    highlightField(input('b'), 'medium', 1000);
    highlightField(input('c'), 'ai', 1000);
    expect(activeHighlightCount()).toBe(3);
  });

  it('clears the highlight when the timer expires', () => {
    const el = input();
    highlightField(el, 'high', 3000);
    vi.advanceTimersByTime(2999);
    expect(el.classList.contains('__jobfill-high')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains('__jobfill-high')).toBe(false);
    expect(el.hasAttribute(DISMISS_ATTR)).toBe(false);
    expect(activeHighlightCount()).toBe(0);
  });

  it('clears the highlight when the user clicks the field', () => {
    const el = input();
    highlightField(el, 'medium', 10_000);
    el.click();
    expect(el.classList.contains('__jobfill-medium')).toBe(false);
    expect(activeHighlightCount()).toBe(0);
    expect(styleEl()).toBeNull();
  });

  it('cancels the timer when the highlight is dismissed by a click', () => {
    const el = input();
    highlightField(el, 'medium', 1000);
    el.click();
    // A leaked timer would fire here and try to clear an already-clean element.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(activeHighlightCount()).toBe(0);
  });

  it('a second click after dismissal is a no-op', () => {
    const el = input();
    highlightField(el, 'medium', 1000);
    el.click();
    el.click();
    expect(activeHighlightCount()).toBe(0);
  });

  it('re-highlighting the same field does not leak the first timer', () => {
    const el = input();
    highlightField(el, 'high', 1000);
    highlightField(el, 'medium', 5000);

    expect(activeHighlightCount()).toBe(1);
    expect(el.classList.contains('__jobfill-high')).toBe(false);
    expect(el.classList.contains('__jobfill-medium')).toBe(true);

    // The first (1 s) timer must be gone — the field stays lit until 5 s.
    vi.advanceTimersByTime(1000);
    expect(el.classList.contains('__jobfill-medium')).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(el.classList.contains('__jobfill-medium')).toBe(false);
  });

  it('survives the element being detached before its timer fires', () => {
    const el = input();
    highlightField(el, 'high', 1000);
    el.remove();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(activeHighlightCount()).toBe(0);
  });
});

describe('removeAllHighlights', () => {
  it('clears every tracked highlight and the stylesheet', () => {
    highlightField(input('a'), 'high', 60_000);
    highlightField(input('b'), 'medium', 60_000);
    highlightField(input('c'), 'file', 60_000);

    removeAllHighlights();

    expect(activeHighlightCount()).toBe(0);
    expect(styleEl()).toBeNull();
    for (const id of ['a', 'b', 'c']) {
      const el = document.getElementById(id)!;
      expect(el.className).toBe('');
      expect(el.hasAttribute(DISMISS_ATTR)).toBe(false);
    }
  });

  it('cancels the pending timers as well', () => {
    highlightField(input('a'), 'high', 1000);
    removeAllHighlights();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(activeHighlightCount()).toBe(0);
  });

  it('cleans up stragglers left by a previous script instance', () => {
    // Extension reload / bfcache: the classes are in the DOM but the registry
    // of the current module instance knows nothing about them.
    const orphan = input('orphan');
    orphan.classList.add('__jobfill-high', '__jobfill-ai', 'site-class');
    orphan.setAttribute(DISMISS_ATTR, '1');
    expect(activeHighlightCount()).toBe(0);

    removeAllHighlights();

    expect(orphan.classList.contains('__jobfill-high')).toBe(false);
    expect(orphan.classList.contains('__jobfill-ai')).toBe(false);
    expect(orphan.hasAttribute(DISMISS_ATTR)).toBe(false);
    expect(orphan.classList.contains('site-class')).toBe(true);
  });

  it('is idempotent', () => {
    highlightField(input(), 'high', 1000);
    removeAllHighlights();
    expect(() => removeAllHighlights()).not.toThrow();
    expect(activeHighlightCount()).toBe(0);
  });

  it('is safe on a page that was never highlighted', () => {
    expect(() => removeAllHighlights()).not.toThrow();
  });
});
