/**
 * Asking the model to pick one of a dropdown's own options.
 *
 * ── Why this exists next to `fieldTemplates.ts` rather than inside it ────────
 * That contract answers "which of the applicant's stored values belongs here?"
 * and is enough for a text box. It cannot fill a `<select>` whose answer is not
 * in the profile at all — the live Workday run left every list on "Please
 * Select", and `Phone Type` (Mobile / Home / Work) is the shape of the problem:
 * the profile holds a number, and the form wants a category.
 *
 * ── What the model may say ───────────────────────────────────────────────────
 * An **index into the options it was shown**. Not text. This is the same
 * containment principle as the template contract, applied to a different
 * control: there the model may reference the user's values but never author
 * text, here it may point at a choice the page already offers but never invent
 * one. Whatever goes wrong — a hallucinated index, a made-up label, a reply
 * about a field that was never sent — the worst case is that nothing is
 * selected. A string answer is accepted too, because small models answer with
 * the label however the prompt is worded, but it is resolved back to an index
 * and dropped if it matches no option exactly.
 *
 * ── What the model is never asked ────────────────────────────────────────────
 * See `shared/filler/questionPolicy.ts`. Protected questions and yes/no lists
 * are filtered out before the request is built, filtered again here on the way
 * back, and refused a third time in the page. The prompt states the rule as
 * well, because a model that understands it answers better — but the prompt is
 * not what makes it true.
 */

import type { SelectQuestion } from '../messages';
import { normalizeOption } from '../filler/optionSynonyms';
import { isBinaryChoice, protectedTopic } from '../filler/questionPolicy';

/** Answers that mean "I have nothing for this dropdown". All are accepted. */
const DECLINED = new Set(['', 'unknown', 'none', 'null', 'skip', 'n/a', 'na', '-', '?']);

/**
 * Resolve one answer to an index into `options`, or `null`.
 *
 * Numbers are taken as indices, strings as labels — with one exception: a string
 * that is *only* digits is an index the model quoted, which is a formatting
 * habit rather than a different answer.
 */
export function toOptionIndex(answer: unknown, options: readonly string[]): number | null {
  if (typeof answer === 'number') return inRange(answer, options.length) ? answer : null;
  if (typeof answer !== 'string') return null;

  const trimmed = answer.trim();
  if (DECLINED.has(trimmed.toLowerCase())) return null;
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed);
    return inRange(index, options.length) ? index : null;
  }

  const wanted = normalizeOption(trimmed);
  // An empty normalization ("???") would otherwise match an option that
  // normalizes to nothing, which is not a match but two absences agreeing.
  if (wanted === '') return null;
  const index = options.findIndex((label) => normalizeOption(label) === wanted);
  return index === -1 ? null : index;
}

function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/**
 * Validate a whole model response against the batch it answers.
 *
 * Keys must address a select that was sent; values must resolve to one of that
 * select's own options; and the select must still be one the model was allowed
 * to answer. That last check is not redundant with the filter that built the
 * batch: it is the same predicate applied on the other side of the network, so a
 * batch assembled by a caller that skipped it — or an answer aimed at an index
 * that has since changed meaning — cannot produce a written value.
 */
export function validateOptionChoices(
  raw: unknown,
  selects: readonly SelectQuestion[],
): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const which = Number(key);
    if (!Number.isInteger(which) || which < 0 || which >= selects.length) continue;

    const select = selects[which];
    if (protectedTopic(select.fingerprint) !== null) continue;
    if (isBinaryChoice(select.options)) continue;

    const index = toOptionIndex(value, select.options);
    if (index === null) continue;
    out[String(which)] = index;
  }
  return out;
}

// ─── The prompt ──────────────────────────────────────────────────────────────

/**
 * The rules, in the model's working order: what it is looking at, what it may
 * answer with, and — at length — when it must answer nothing.
 *
 * The refusal list is stated here as well as enforced in
 * {@link validateOptionChoices} for the reason given in `fieldTemplates.ts`: the
 * validator makes a bad answer harmless, the prompt makes a good answer likelier
 * and stops the model spending its output on questions that would be discarded.
 */
export const OPTION_CHOICE_SYSTEM_PROMPT = `You are a JSON API that picks one entry from a form dropdown's own list of options.

You are told nothing whatsoever about the applicant — not their name, their address, their history, nor anything they have typed. You are given how a dropdown identifies itself and the choices it offers, and you answer with the INDEX of one of those choices. You cannot write text into the form; an index is the only thing you can say.

Answer "" — choose nothing — whenever picking an option would state something about the applicant that you do not know. In particular you must NEVER answer a field about:
  - age, date of birth, being 18 or older, or being of legal drinking age;
  - the right to work, work permits, citizenship, nationality, visas or sponsorship;
  - a criminal record, convictions or background checks;
  - military, veteran or national service;
  - disability, health or any medical condition;
  - race, ethnicity, gender, sexual orientation, religion, marital status or any other protected characteristic;
  - consent, agreement, opting in, marketing, or being contacted about other positions;
  - confirming that something is true, accurate, complete, or included in a CV;
  - level of education, degrees, certifications or licences.
Never answer a yes/no question. Those are statements the applicant signs; they are not yours to make. "" is always a correct answer — an unanswered dropdown costs the applicant a few seconds, a wrong one costs them the application.

What is left is the neutral, self-evident kind of choice: the category a field's own label already implies. Answer only when the field itself tells you the answer, and answer "" whenever it does not.

Respond with a JSON object only: field index (as a string) to option index (a number), or "" to decline. Include every field index.`;

/**
 * The user half: the batch itself, kept apart from the rules so that what leaves
 * the browser per request is visibly just this — the dropdowns' identities and
 * their own option labels.
 */
export function buildOptionChoicePrompt(selects: readonly SelectQuestion[]): string {
  const blocks = selects.map((select, i) => {
    const options = select.options.map((label, n) => `    ${n}: "${label}"`).join('\n');
    return `${i}: field "${select.fingerprint}"\n${options}`;
  });

  return `Each block is one dropdown: its index, how it identifies itself (autocomplete|name|id|semantic-name|aria-label|label|placeholder|nearby-heading|description), then its options with their indices.

${blocks.join('\n\n')}

Answer with {"0": <option index or "">, …} for fields 0-${selects.length - 1}.`;
}
