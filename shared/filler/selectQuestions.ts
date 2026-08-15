/**
 * Which dropdowns on this page may be put to the model, and how the answer gets
 * back to the right one.
 *
 * The DOM half of the option-choice pass. Everything policy-shaped —
 * "is this question protected?", "is this a yes/no list?", "how much may leave
 * the page?" — lives in `questionPolicy.ts` and is shared with the worker; what
 * is here is the part that needs a live document: which selects are still
 * unanswered, what their options currently say, and which element an index in
 * the reply refers to.
 *
 * The order of the two questions matters and is not an implementation detail:
 * **a select is only ever asked about after the profile has failed to fill it.**
 * `fillPage` runs first and fills what the heuristics recognise, then the
 * value-template pass gets a turn, and only what is still sitting on its
 * placeholder after both reaches this module. Country, language and education
 * therefore never get here on a profile that has them filled in — they are
 * answered from stored data, deterministically, with no API key involved.
 */

import type { FieldFingerprint } from '../field-matcher/fingerprint';
import { serializeFingerprint } from '../field-matcher/fingerprint';
import type { SelectQuestion } from '../messages';
import { askableSelects } from './questionPolicy';
import { readableOptions } from './selectStrategy';
import { isInsideAuthForm, isSensitiveControl } from './fillable';

/** A dropdown that was asked about, and the element the answer belongs to. */
export interface AskedSelect {
  element: HTMLSelectElement;
  question: SelectQuestion;
}

/**
 * A select still showing its placeholder. `selectedIndex <= 0` covers both the
 * untouched state and a list whose first entry is the prompt; an empty value
 * covers the same thing on a list that has no placeholder at all.
 */
export function isUnanswered(el: HTMLSelectElement): boolean {
  return el.selectedIndex <= 0 || el.value === '';
}

/**
 * The batch, in page order.
 *
 * Filtering happens twice on purpose. Here: everything that needs the DOM — the
 * control is still connected, still unanswered, not a credential field, not part
 * of a sign-in form, and its option list is readable. Then {@link askableSelects},
 * which is the same function the worker runs at the egress point, so no
 * dropdown can be sent that policy would have refused.
 */
export function buildSelectBatch(candidates: readonly FieldFingerprint[]): AskedSelect[] {
  const asked: AskedSelect[] = [];

  for (const field of candidates) {
    const el = field.element;
    if (!(el instanceof HTMLSelectElement)) continue;
    if (!el.isConnected || !isUnanswered(el)) continue;
    if (isSensitiveControl(el) || isInsideAuthForm(el)) continue;

    const options = readableOptions(el);
    if (options.length === 0) continue;
    asked.push({ element: el, question: { fingerprint: serializeFingerprint(field), options } });
  }

  const allowed = askableSelects(asked.map((entry) => entry.question));
  // `askableSelects` keeps its input's order and never rewrites an entry, so the
  // surviving questions can be matched back by identity rather than by index.
  return asked.filter((entry) => allowed.includes(entry.question));
}
