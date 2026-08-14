import type { FieldConfidence } from '../types';
import type { FieldFingerprint } from './fingerprint';
import { FIELD_RULES, type FieldRule, type FieldType } from './dictionary';

export const HIGH_THRESHOLD = 70;
export const MEDIUM_THRESHOLD = 35;

/**
 * P1-3: minimum lead the winner must have over the runner-up.
 *
 * 15 is the weight of the weakest *independent lexical* source (placeholder)
 * and is strictly greater than the two soft sources combined
 * (heading 10 + description 5). A rule that wins by less than that owes its
 * victory to a single fuzzy signal — or, when the difference is 0, to its
 * position in `FIELD_RULES`. In both cases the field is genuinely ambiguous,
 * so the match is reported with `low` confidence and never auto-filled.
 */
export const MIN_MARGIN = 15;

/** Weight ladder, highest → lowest */
const STRONG = {
  autocomplete: 70,
  nameId: 30,
  semantic: 25,
  aria: 20,
  label: 20,
  placeholder: 15,
  heading: 10,
  description: 5,
} as const;

/**
 * Weights for `weak` patterns — ambiguous tokens such as "location".
 * Their sum (43) stays under `MEDIUM_THRESHOLD + placeholder`, so a weak token
 * can only reach the fill threshold with help from a real signal.
 */
const WEAK = {
  nameId: 10,
  semantic: 9,
  aria: 7,
  label: 7,
  placeholder: 5,
  heading: 3,
  description: 2,
} as const;

/** Test a pattern against the raw string AND its diacritics-stripped form */
function test(pattern: RegExp, value: string): boolean {
  if (!value) return false;
  if (pattern.test(value)) return true;
  const stripped = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return stripped !== value && pattern.test(stripped);
}

export type ExtendedFieldType = FieldType | 'openQuestion';

export interface ScoredMatch {
  fieldType: ExtendedFieldType;
  score: number;
  confidence: FieldConfidence;
}

/**
 * Open-ended questions (P1-6). ATS rarely put the question in a <label>; it is
 * usually a sibling <div>, an aria-label or the placeholder, so every text
 * source is considered — not just the label.
 */
const QUESTION_PREFIXES =
  /^(?:what|which|who|when|where|why|how|can you|could you|do you|did you|have you|are you|tell (?:us|me)|describe|share|explain|please|briefly|provide|give us|list|in (?:your|a few)|pro[cč]|jak\w*|co|kde|kdy|popi[sš]te|[rř]ekn[eě]te|uve[dď]te|m[uů][zž]ete|napi[sš]te)(?![a-z])/i;

/** Shortest text we accept as a question — "Why us?" is 7 characters */
const MIN_QUESTION_LENGTH = 7;
/** A prefix without a question mark needs more substance to count */
const MIN_STATEMENT_QUESTION_LENGTH = 20;

const OPEN_QUESTION_SCORE = 30;

function confidenceFor(score: number): FieldConfidence {
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/** Full weight when `pattern` matches, reduced weight when only `weak` matches */
function signal(rule: FieldRule, value: string, strong: number, weak: number): number {
  if (!value) return 0;
  if (test(rule.pattern, value)) return strong;
  if (rule.weak && test(rule.weak, value)) return weak;
  return 0;
}

/** Every text source a rule may be matched against */
function sourcesOf(fp: FieldFingerprint): string[] {
  return [
    fp.name,
    fp.id,
    fp.semanticName,
    fp.ariaLabel,
    fp.labelText,
    fp.placeholder,
    fp.contextHeading,
    fp.description,
  ];
}

function scoreRule(rule: FieldRule, fp: FieldFingerprint): number {
  // A negative context disqualifies the rule outright: writing the candidate's
  // name into "Company name" is far worse than leaving the field empty.
  if (rule.negative && sourcesOf(fp).some((value) => test(rule.negative!, value))) return 0;

  let score = 0;

  // 1. autocomplete exact match — highest signal, sufficient for 'high' alone
  if (rule.autocomplete.length > 0 && fp.autocomplete && rule.autocomplete.includes(fp.autocomplete)) {
    score += STRONG.autocomplete;
  }

  // 2. name / id (awarded once — they usually carry the same token)
  score += Math.max(
    signal(rule, fp.name, STRONG.nameId, WEAK.nameId),
    signal(rule, fp.id, STRONG.nameId, WEAK.nameId),
  );

  // 3. semantic name (de-obfuscated, e.g. "_systemfield_name" → "name")
  score += signal(rule, fp.semanticName, STRONG.semantic, WEAK.semantic);
  // 4-8. remaining text sources
  score += signal(rule, fp.ariaLabel, STRONG.aria, WEAK.aria);
  score += signal(rule, fp.labelText, STRONG.label, WEAK.label);
  score += signal(rule, fp.placeholder, STRONG.placeholder, WEAK.placeholder);
  score += signal(rule, fp.contextHeading, STRONG.heading, WEAK.heading);
  score += signal(rule, fp.description, STRONG.description, WEAK.description);

  return score;
}

/** Text sources that may carry an open-ended question, most reliable first */
function questionText(fp: FieldFingerprint): string {
  const isTextarea = fp.element.tagName.toLowerCase() === 'textarea';

  for (const raw of [fp.labelText, fp.ariaLabel, fp.contextHeading, fp.placeholder]) {
    const text = raw.trim();
    if (text.length < MIN_QUESTION_LENGTH || !/\s/.test(text)) continue;
    // A question mark is proof enough on any control…
    if (text.includes('?')) return text;
    // …otherwise only a long, prompt-shaped textarea label counts
    if (
      isTextarea &&
      text.length > MIN_STATEMENT_QUESTION_LENGTH &&
      QUESTION_PREFIXES.test(text)
    ) {
      return text;
    }
  }
  return '';
}

/**
 * Score a single field fingerprint against all rules.
 * Returns the best match or null if nothing matched.
 *
 * Weight ladder (highest → lowest):
 *   autocomplete exact match  → +70  (sufficient alone for 'high')
 *   name / id match           → +30
 *   semantic name match       → +25  (extracted from obfuscated attr)
 *   aria-label match          → +20
 *   label text match          → +20
 *   placeholder match         → +15
 *   context heading match     → +10
 *   aria-describedby match    → +5
 */
export function scoreField(fp: FieldFingerprint): ScoredMatch | null {
  // Search boxes and filters are never application fields (P1-2)
  if (fp.isSearchContext) return null;

  const ranked: { fieldType: ExtendedFieldType; score: number }[] = [];
  for (const rule of FIELD_RULES) {
    const score = scoreRule(rule, fp);
    if (score > 0) ranked.push({ fieldType: rule.type, score });
  }
  ranked.sort((a, b) => b.score - a.score);

  let best: ScoredMatch | null = null;
  if (ranked.length > 0) {
    const [top, runnerUp] = ranked;
    let confidence = confidenceFor(top.score);
    // P1-3: a photo-finish means the winner was decided by rule order, not by
    // evidence. Downgrade so the field is highlighted but not filled.
    if (runnerUp && top.score - runnerUp.score < MIN_MARGIN) confidence = 'low';
    best = { fieldType: top.fieldType, score: top.score, confidence };
  }

  // Open-ended question — only when no rule is confident enough to fill anyway
  if (!best || best.confidence === 'low') {
    const tag = fp.element.tagName.toLowerCase();
    const type = (fp.element.getAttribute('type') ?? 'text').toLowerCase();
    const canHoldProse = tag === 'textarea' || (tag === 'input' && (type === 'text' || type === ''));
    if (canHoldProse && questionText(fp)) {
      return { fieldType: 'openQuestion', score: OPEN_QUESTION_SCORE, confidence: 'medium' };
    }
  }

  return best;
}
