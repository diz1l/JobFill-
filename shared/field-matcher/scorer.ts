import type { FieldConfidence } from '../types';
import type { FieldFingerprint } from './fingerprint';
import { FIELD_RULES, type FieldType } from './dictionary';

export const HIGH_THRESHOLD = 70;
export const MEDIUM_THRESHOLD = 35;

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

/** Question-type fields: open-ended prompts that need AI to answer */
const QUESTION_PREFIXES =
  /^(what|can you|could you|do you|why|how|tell (us|me)|describe|share|explain|please|briefly|provide|give us)/i;

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
 */
export function scoreField(fp: FieldFingerprint): ScoredMatch | null {
  let best: ScoredMatch | null = null;

  for (const rule of FIELD_RULES) {
    let score = 0;

    // 1. autocomplete exact match — highest signal, sufficient for 'high' alone
    if (rule.autocomplete.length > 0 && fp.autocomplete) {
      if (rule.autocomplete.includes(fp.autocomplete)) score += 70;
    }

    // 2. name / id
    if (test(rule.pattern, fp.name) || test(rule.pattern, fp.id)) score += 30;

    // 3. semantic name (de-obfuscated, e.g. "_systemfield_name" → "name")
    if (fp.semanticName && test(rule.pattern, fp.semanticName)) score += 25;

    // 4. aria-label
    if (test(rule.pattern, fp.ariaLabel)) score += 20;

    // 5. label text
    if (test(rule.pattern, fp.labelText)) score += 20;

    // 6. placeholder
    if (test(rule.pattern, fp.placeholder)) score += 15;

    // 7. context heading
    if (test(rule.pattern, fp.contextHeading)) score += 10;

    if (score > 0 && (!best || score > best.score)) {
      const confidence: FieldConfidence =
        score >= HIGH_THRESHOLD ? 'high' : score >= MEDIUM_THRESHOLD ? 'medium' : 'low';
      best = { fieldType: rule.type, score, confidence };
    }
  }

  // Open-ended question detection — textareas with long question-type labels
  if (
    fp.element.tagName.toLowerCase() === 'textarea' &&
    fp.labelText.length > 20 &&
    QUESTION_PREFIXES.test(fp.labelText.trim()) &&
    (!best || best.score < MEDIUM_THRESHOLD)
  ) {
    return { fieldType: 'openQuestion', score: 30, confidence: 'medium' };
  }

  return best;
}
