/**
 * Choosing an `<option>`.
 *
 * ── Why a dropdown is not a text box ─────────────────────────────────────────
 * Writing "Czechia" into a text field that wanted "Czech Republic" is a typo the
 * user can see and fix. Selecting the wrong entry in a dropdown is not: the form
 * then shows a complete, deliberate-looking answer that the applicant never gave
 * and has no reason to re-read. So the rule here is *stricter* than for text,
 * and refusing is cheap — an untouched select is highlighted like every other
 * field JobFill could not fill.
 *
 * ── The three layers, in order ───────────────────────────────────────────────
 *  1. **Placeholders are not answers.** `Please Select`, `— vyberte —`, a
 *     disabled first entry, an option with an empty `value`: none of them may
 *     ever be selected, whatever they score. This was the visible half of the
 *     Workday report — every list sat on "Please Select" — and it is the half a
 *     similarity score can make *worse*, since "Select" is a real word that
 *     really does resemble things.
 *  2. **Named things are compared by name, not by spelling**
 *     ({@link compareAliases}). `Czechia` and `Czech Republic` share no words;
 *     `Prague Czechia` and `Prague Slovakia` share half of them. Similarity gets
 *     both backwards, and the alias tables get both right — including the "no",
 *     which vetoes the option outright.
 *  3. **Similarity, with a decisive lead.** What is left is wording, scored the
 *     way it always was, with one addition: the winner has to be clearly ahead
 *     of every other option. On a real country list `Korea, Republic of` and
 *     `Korea, Democratic People's Republic of` score identically for "Korea",
 *     and that is precisely the moment to select nothing at all.
 *
 * `false` means nothing was selected and the control was not touched.
 */

import { compareAliases, normalizeOption } from './optionSynonyms';

/**
 * How much of the wording has to be shared before an option is a candidate.
 *
 * Kept at one half rather than raised, deliberately. Raising it is the obvious
 * reaction to "a wrong pick is worse than an empty box", and it is the wrong
 * one: it buys safety by throwing away the matches that carry this feature —
 * "Prague" for `Prague, Czech Republic`, "Yes" for `Yes, I am` — while leaving
 * the actual failure mode untouched, because the dangerous case is not a *weak*
 * winner but an *unclear* one. Two options that resemble the value equally well
 * are a coin toss at any threshold. Hence {@link DECISIVE_LEAD}, which is what
 * this module relies on, and layer 2 above, which removes most lists from the
 * fuzzy path altogether.
 */
const SIMILARITY_THRESHOLD = 0.5;

/**
 * How far ahead of the runner-up the winner must be.
 *
 * Sits just under the 0.2 between an exact match (1) and a containment match
 * (0.8) — the commonest real pair, `Yes` beside `Yes, with conditions` — so the
 * ordinary case still resolves, and with room to spare rather than on a
 * floating-point knife edge. Anything closer than this is two options making the
 * same claim on the value, and selecting nothing is the answer: on a real
 * country list `Korea, Republic of` and `Korea, Democratic People's Republic of`
 * score identically for "Korea", and no threshold can tell them apart because
 * the wording genuinely does not.
 */
const DECISIVE_LEAD = 0.15;

/** Score awarded when one string contains the other as a whole word sequence. */
const CONTAINMENT_SCORE = 0.8;

/**
 * Openings that mean "you have not answered yet". Tested against the normalized
 * label, so `-- Select --`, `Select…` and `Please  select` are one pattern, as
 * are the Czech and Slovak forms a jobs.cz template produces.
 */
const PLACEHOLDER_LABEL =
  /^(?:please\s+)?(?:select|choose|pick|none|no selection|not specified|nothing selected|vyberte|vybrat|zvolte|zvolit|neuvedeno|nevybrano|bitte|choisir|selectionner|seleccione)\b/;

interface OptionParts {
  /** Normalized visible label. */
  text: string;
  /** Normalized `value` attribute. */
  attr: string;
}

function partsOf(option: HTMLOptionElement): OptionParts {
  return { text: normalizeOption(option.text), attr: normalizeOption(option.value) };
}

/**
 * An entry that cannot be an answer: disabled, blank, blank-valued, or one of
 * the "choose something" prompts every ATS puts first.
 */
function isPlaceholder(option: HTMLOptionElement, parts: OptionParts): boolean {
  if (option.disabled) return true;
  if (parts.text === '' || parts.attr === '') return true;
  return PLACEHOLDER_LABEL.test(parts.text);
}

/** Does `haystack` contain `needle` as a whole sequence of words? */
function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Word-boundary aware, unlike the substring test this replaces: `no` is a
 * substring of `nothing` and `Norway`, and on a yes/no list that is the
 * difference between an answer and a fabricated one.
 */
function similarity(option: string, value: string): number {
  if (option === '' || value === '') return 0;
  if (option === value) return 1;
  if (containsWords(option, value) || containsWords(value, option)) return CONTAINMENT_SCORE;

  const optionWords = new Set(option.split(' '));
  const valueWords = value.split(' ');
  const shared = valueWords.filter((word) => optionWords.has(word)).length;
  return shared / Math.max(optionWords.size, valueWords.length);
}

/**
 * How well one option answers `value`, in [0, 1].
 *
 * The label is asked first and the `value` attribute only when the label names
 * nothing the tables know. That order matters: `<option value="NO">Norway</option>`
 * says "Norway" to a reader and "no" to a naive matcher, and a profile answer of
 * "No" must not select a country.
 */
function scoreOption(parts: OptionParts, value: string): number {
  const verdict = compareAliases(parts.text, value) ?? compareAliases(parts.attr, value);
  if (verdict === 'same') return 1;
  // Two different named things. No wording similarity can outrank that.
  if (verdict === 'different') return 0;
  return Math.max(similarity(parts.text, value), similarity(parts.attr, value));
}

interface Candidate {
  index: number;
  /** Identity of the *answer*, so that a duplicated option is not a rival. */
  key: string;
  score: number;
}

/**
 * Fill a native `<select>` with the profile datum, or leave it alone.
 */
export function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const wanted = normalizeOption(value);
  const scored: Candidate[] = [];

  for (let i = 0; i < el.options.length; i++) {
    const option = el.options[i];
    const parts = partsOf(option);
    if (isPlaceholder(option, parts)) continue;
    const score = scoreOption(parts, wanted);
    if (score > 0) scored.push({ index: i, key: `${parts.text}|${parts.attr}`, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < SIMILARITY_THRESHOLD) return false;

  // The best *other* answer, duplicates of the winner excluded.
  const rival = scored.find((candidate) => candidate.key !== best.key);
  if (rival && best.score - rival.score < DECISIVE_LEAD) return false;

  el.selectedIndex = best.index;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * The labels of the options that could actually be chosen, in page order.
 *
 * This is what the AI pass is allowed to be shown and what it answers with an
 * index into — so placeholders are absent here for the same reason they are
 * unselectable above: they are not answers, and offering them invites one.
 */
export function readableOptions(el: HTMLSelectElement): string[] {
  const labels: string[] = [];
  for (let i = 0; i < el.options.length; i++) {
    const option = el.options[i];
    const parts = partsOf(option);
    if (isPlaceholder(option, parts)) continue;
    labels.push(option.text.replace(/\s+/g, ' ').trim());
  }
  return labels;
}

/**
 * Select the option carrying exactly this label — the write half of the AI pass.
 *
 * Matching by label rather than by position is what makes a stale answer
 * harmless: the page may have re-rendered, re-ordered or replaced its options
 * between the request and the reply, and the only thing that can be selected is
 * an entry that still says what the model was told it says. Nothing fuzzy
 * happens here; an option the model invented matches nothing and is dropped.
 */
export function selectOptionByLabel(el: HTMLSelectElement, label: string): boolean {
  const wanted = normalizeOption(label);
  if (wanted === '') return false;

  for (let i = 0; i < el.options.length; i++) {
    const option = el.options[i];
    const parts = partsOf(option);
    if (isPlaceholder(option, parts) || parts.text !== wanted) continue;
    el.selectedIndex = i;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}
