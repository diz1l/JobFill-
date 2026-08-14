/**
 * Where does generated cover-letter text go? (P1-12)
 *
 * Opening the popup takes focus away from the page, so by the time
 * `FILL_COVER_TEXT` arrives `document.activeElement` is useless — and falling
 * back to "the first `<textarea>` on the page" happily drops a motivation
 * letter into a site-search or chat box.
 *
 * Instead we keep two weak hints, recorded while the page still had focus:
 *   - the last field the user actually focused, and
 *   - the field `fillPage()` recognised as the cover-letter field.
 *
 * If neither is usable we re-run the matcher over the page's textareas, and if
 * that also yields nothing we insert *nowhere* and report an error. Guessing is
 * worse than doing nothing here: the text ends up in a form the user submits.
 */

import { buildFingerprint } from '../field-matcher/fingerprint';
import { scoreField } from '../field-matcher/scorer';
import { isFillableControl, isInsideAuthForm } from './fillable';

export type CoverTarget = HTMLTextAreaElement | HTMLInputElement;

/** Highlight classes applied to fields the matcher liked, in priority order. */
const HIGHLIGHTED_TEXTAREAS =
  'textarea.__jobfill-ai,textarea.__jobfill-high,textarea.__jobfill-medium';

let lastFocused: WeakRef<CoverTarget> | null = null;
let lastRecognized: WeakRef<CoverTarget> | null = null;

function usable(ref: WeakRef<CoverTarget> | null): CoverTarget | null {
  const el = ref?.deref();
  if (!el || !el.isConnected) return null;
  return isFillableControl(el) ? el : null;
}

/** Called from the content script's `focusin` handler, while the page still has focus. */
export function rememberFocusedField(el: Element): void {
  if (el instanceof HTMLTextAreaElement) lastFocused = new WeakRef(el);
}

/** Called by `fillPage()` when the matcher identifies the cover-letter field. */
export function rememberRecognizedCoverField(el: Element): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    lastRecognized = new WeakRef(el);
  }
}

export function forgetCoverTargets(): void {
  lastFocused = null;
  lastRecognized = null;
}

/**
 * Best cover-letter target in this frame, or `null` when there is no reliable
 * one. Callers must treat `null` as "do not insert anything".
 */
export function resolveCoverTarget(doc: Document = document): CoverTarget | null {
  // 1. The field the user last put the caret in — the strongest signal there is.
  const focused = usable(lastFocused);
  if (focused) return focused;

  // 2. The field the matcher recognised during the last fill.
  const recognized = usable(lastRecognized);
  if (recognized) return recognized;

  // 3. Still highlighted from the last fill (AI / high / medium).
  for (const el of doc.querySelectorAll<HTMLTextAreaElement>(HIGHLIGHTED_TEXTAREAS)) {
    if (isFillableControl(el) && !isInsideAuthForm(el)) return el;
  }

  // 4. No memory at all (popup used before "Fill Form") — ask the matcher.
  for (const el of doc.querySelectorAll('textarea')) {
    if (!isFillableControl(el) || isInsideAuthForm(el)) continue;
    const match = scoreField(buildFingerprint(el));
    if (!match || match.confidence === 'low' || match.confidence === 'none') continue;
    if (match.fieldType === 'coverLetter' || match.fieldType === 'openQuestion') return el;
  }

  return null;
}
