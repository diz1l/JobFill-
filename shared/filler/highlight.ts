import type { FieldConfidence } from '../types';

/**
 * Confidence highlighting for page fields (FR-3.5).
 *
 * Unlike the inline button this cannot live in a shadow root — the outlines are
 * drawn on the *page's* elements, so a stylesheet has to exist in the page.
 * NFR-4 is satisfied instead by strict bookkeeping: every highlight owns its
 * timer and click listener, and the stylesheet is removed again the moment the
 * last highlight is dismissed.
 */

const STYLE_ID = '__jobfill-styles';
const DISMISS_ATTR = 'data-jobfill-dismiss';
const CONFIDENCE_CLASSES = ['high', 'medium', 'low', 'none', 'file', 'ai'] as const;

/**
 * These are deliberately NOT the same hues as the extension-UI confidence tokens
 * in `assets/styles/globals.css`. Those are drawn light-on-dark inside our own
 * popup; these are drawn on someone else's page, and application forms are
 * overwhelmingly light-themed. Each value below clears WCAG 3:1 for non-text
 * contrast against BOTH white and near-black, so the outline stays visible
 * whatever the host page does:
 *
 *   high  #16a34a — 3.30 : 1 on white, 5.73 : 1 on #111
 *   medium#a16207 — 4.92 : 1 on white, 3.84 : 1 on #111
 *   none  #6b7280 — 4.83 : 1 on white, 3.91 : 1 on #111
 *   ai    #7c3aed — 5.70 : 1 on white, 3.31 : 1 on #111
 *   file  #2563eb — 5.17 : 1 on white, 3.65 : 1 on #111
 *
 * The previous palette (#22c55e / #eab308 / #9ca3af) scored 2.28 / 1.92 / 2.54
 * on white — effectively invisible on a normal job board.
 */
const HIGHLIGHT_CSS = `
.__jobfill-high {
  outline: 2px solid #16a34a !important;
  outline-offset: 1px !important;
  background-color: rgba(22,163,74,0.10) !important;
}
.__jobfill-medium {
  outline: 2px solid #a16207 !important;
  outline-offset: 1px !important;
  background-color: rgba(161,98,7,0.10) !important;
}
.__jobfill-low, .__jobfill-none {
  outline: 2px dashed #6b7280 !important;
  outline-offset: 1px !important;
}
.__jobfill-file {
  outline: 2px dashed #2563eb !important;
  outline-offset: 1px !important;
}
.__jobfill-ai {
  outline: 2px dashed #7c3aed !important;
  outline-offset: 1px !important;
  background-color: rgba(124,58,237,0.08) !important;
}
`;

interface ActiveHighlight {
  className: string;
  timer: ReturnType<typeof setTimeout>;
  dismiss: () => void;
}

const active = new Map<HTMLElement, ActiveHighlight>();

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const parent = document.head ?? document.documentElement;
  if (!parent) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = HIGHLIGHT_CSS;
  parent.appendChild(style);
}

export function highlightField(
  el: HTMLElement,
  confidence: FieldConfidence | 'file' | 'ai',
  durationMs: number,
): void {
  ensureStyles();
  // Re-highlighting the same field (second fill) must not leak the first timer.
  clearHighlight(el);

  const className = `__jobfill-${confidence}`;
  el.classList.add(className);
  el.setAttribute(DISMISS_ATTR, '1');

  const dismiss = () => clearHighlight(el);
  el.addEventListener('click', dismiss, { once: true });
  active.set(el, { className, timer: setTimeout(dismiss, durationMs), dismiss });
}

/** Remove one highlight and everything attached to it. Safe on detached nodes. */
function clearHighlight(el: HTMLElement): void {
  const entry = active.get(el);
  if (!entry) return;
  clearTimeout(entry.timer);
  el.removeEventListener('click', entry.dismiss);
  el.classList.remove(entry.className);
  el.removeAttribute(DISMISS_ATTR);
  active.delete(el);
  // Nothing highlighted any more → nothing of ours left in the page.
  if (active.size === 0) removeStyles();
}

export function removeAllHighlights(): void {
  for (const el of [...active.keys()]) clearHighlight(el);

  // Stragglers from a previous script instance (extension reload, bfcache).
  document.querySelectorAll<HTMLElement>(`[${DISMISS_ATTR}]`).forEach((el) => {
    CONFIDENCE_CLASSES.forEach((c) => el.classList.remove(`__jobfill-${c}`));
    el.removeAttribute(DISMISS_ATTR);
  });
  removeStyles();
}

export function removeStyles(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/** Number of fields currently highlighted — used by tests and diagnostics. */
export function activeHighlightCount(): number {
  return active.size;
}
