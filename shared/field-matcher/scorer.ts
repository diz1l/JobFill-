import type { FieldConfidence } from '../types';
import type { FieldFingerprint } from './fingerprint';
import { FIELD_RULES, type FieldRule, type FieldType } from './dictionary';

export const HIGH_THRESHOLD = 70;
export const MEDIUM_THRESHOLD = 35;

/**
 * Minimum lead the winner must have over the runner-up.
 *
 * 15 is the weight of the weakest *independent lexical* source (placeholder) and
 * is strictly greater than the two soft sources combined (heading 10 +
 * description 5). A rule that wins by less owes its victory to a single fuzzy
 * signal — or, at a difference of 0, to its position in `FIELD_RULES`. Either
 * way the field is genuinely ambiguous, so the match is reported `low` and never
 * auto-filled.
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
 * A weak token never earns {@link DEDICATED_BONUS}: "Lokalita" being the entire
 * label does not make the word any less ambiguous. `WEAK_ONLY_CEILING` then
 * guarantees weak signals cannot carry a field on their own, however many
 * sources repeat them.
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

/**
 * Extra weight for a *dedicated* prose source — one whose entire text is the
 * rule's own name, give or take grammar ("Přiložte motivační dopis", "Your
 * city").
 *
 * On Czech job boards (Jobs.cz / Prace.cz, the primary market) the `<label>` is
 * routinely the *only* readable signal a control has; `name` and `id` are
 * generated hashes. Such a field scored label(20) alone, stayed `low` and was
 * never filled — the engine was blind on exactly the forms it was built for.
 *
 * A bonus rather than a bigger `STRONG.label`, because raising the flat weight
 * promotes *any* label that merely mentions a rule token, so "What is your
 * availability to travel?" would start filling in a start date. Dedication
 * separates a label that **names** the field from one that **mentions** the
 * word. Being equal for every prose source, it also leaves the ladder's relative
 * ordering — and every `MIN_MARGIN` comparison — untouched.
 *
 * Calibration: `STRONG.label + DEDICATED_BONUS === MEDIUM_THRESHOLD`. A label
 * that names the field is exactly, and only just, enough to fill it.
 */
export const DEDICATED_BONUS = MEDIUM_THRESHOLD - STRONG.label;

/**
 * A rule that matched nothing but `weak` tokens can never reach the fill
 * threshold, whatever the number of sources. Without this the seven weak
 * weights sum to 43, and a control repeating "Location" / "Lokalita" across
 * name + id + aria + label + placeholder would cross it on ambiguity alone.
 */
const WEAK_ONLY_CEILING = MEDIUM_THRESHOLD - 1;

/** Longest text that can still be a field's *name* rather than a sentence */
const MAX_DEDICATED_LENGTH = 60;

/**
 * Words that decorate a label without changing which field it names: articles,
 * pronouns, prepositions, imperatives ("please enter", "přiložte"), question
 * words, requiredness markers, counters, and the generic noun a link or address
 * token hangs off ("LinkedIn profil", "Portfolio URL").
 *
 * Everything here is grammar, not identity. A text made of one rule match plus
 * these words names that one field and nothing else — which is why it is
 * allowed to reach the fill threshold on its own. Nothing that could be the
 * *subject* of a question ("travel", "project", "experience") may be added.
 */
const FILLER_WORD = new RegExp(
  '^(?:' +
    [
      // English glue, auxiliaries, question words
      'a|an|the|and|or|of|for|to|in|into|on|at|with|from|until|till|since|by|is|are|be|do|does|did|can|could|would|will|if|any|here|below|above',
      'i|me|my|we|us|our|you|your|yours',
      'what|whats|when|where|which|who|whom|why|how',
      // English imperatives that introduce a field
      'please|kindly|enter|type|write|provide|give|add|upload|attach|fill|select|choose|specify|share|tell|state|indicate|describe|list',
      // requiredness markers and abbreviations that ride along inside labels
      'required|mandatory|optional|field|max|min|approx|etc|eg|ex|e|g|example|format|characters|chars|char',
      // the generic noun a link / address token hangs off
      'url|urls|link|links|profile|profiles|address|addresses',
      // "Phone number", "Tel. č.", "E-mail address" — a counter word, not an identity
      'number|numbers|num|no|nr|c|cislo|cisla|cislu',
      // Czech prepositions, conjunctions, pronouns, auxiliaries
      'v|ve|na|do|s|se|k|ke|o|u|z|ze|od|po|pri|pro|az|si|to|te|ta|ten|tu|nebo|anebo|ci|zde|sem|tady',
      'ja|mi|sve|svuj|ty|vy|vam|vas|vase|vasi|vaseho|vasem|vasich|vasa|tvuj|tve|tvoje|tvoji',
      'je|jsou|jste|jsem|byt|mate|muzete|muzes|mohl|mohla|mohli|bys|byste|chcete|budete|mozete|mozes|viete',
      'schopen|schopna|schopni|ochoten|ochotna|ochotni',
      // Czech / Slovak imperatives and politeness that introduce a field
      'prosim|prosime|prosime|dekujeme|zadejte|zadej|zadat|zadajte|vyplnte|vypln|vyplnit|vyplnte',
      'uvedte|uved|uvest|uvedte|napiste|napis|napsat|vepiste|zapiste|sdelte|sdel|sdelit|popiste|popis',
      'priloz|prilozte|prilozit|nahrajte|nahrat|vlozte|vlozit|vyberte|zvolte|doplnte|doplnit|upresnete|specifikujte',
      // Czech question words and requiredness
      'kdy|kde|kam|jak|jaka|jake|jaky|jakou|jakem|jakym|jakych|co|cim|kdo|ktery|ktera|ktere|kterou|kterym|proc|kolik',
      'nepovinne|nepovinny|nepovinna|povinne|povinny|povinna|povinny|volitelne|volitelny|pole|napr|napriklad|priklad',
      'odkaz|odkazu|profil|profilu|adresa|adresu|adresy|udaj|udaje|udaju|kontaktni|kontaktniho|kontaktnim|znaku|znaky',
      // required stars, "(0/6000)", "Line 1"
      '\\d+',
    ].join('|') +
    ')$',
);

/** Diacritics-stripped form used whenever a Czech rule is written ASCII-only */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Test a pattern against the raw string AND its diacritics-stripped form */
function test(pattern: RegExp, value: string): boolean {
  if (!value) return false;
  if (pattern.test(value)) return true;
  const stripped = fold(value);
  return stripped !== value && pattern.test(stripped);
}

/** Does `pattern`'s match leave nothing but grammar behind in `text`? */
function consumesAll(pattern: RegExp, text: string): boolean {
  const found = pattern.exec(text);
  if (!found) return false;
  const rest = text.slice(0, found.index) + ' ' + text.slice(found.index + found[0].length);
  const leftovers = fold(rest).toLowerCase().match(/[a-z0-9]+/g);
  return leftovers === null || leftovers.every((word) => FILLER_WORD.test(word));
}

/**
 * True when `pattern` consumes everything in `value` that carries meaning \u2014
 * i.e. the text *is* the field's name rather than a sentence that happens to
 * contain the token.
 *
 * "P\u0159ilo\u017ete motiva\u010dn\u00ed dopis" \u2192 match "motiva\u010dn\u00ed dopis", leftover "p\u0159ilo\u017ete" is
 *   an imperative \u2192 dedicated.
 * "What is your availability to travel?" \u2192 leftover "travel" is a real word \u2192
 *   not dedicated; the label only mentions availability.
 *
 * Both spellings are tried, and either may be the one that fits. `\w` is ASCII
 * in JavaScript, so a stem written `trval\w*` stops dead on the "\u00e9" of
 * "Trval\u00e9" and the engine falls back to a shorter alternative
 * ("bydli\u0161t\u011b") that leaves "Trval\u00e9" stranded \u2014 while the folded
 * "Trvale bydliste" matches end to end.
 */
function isDedicated(pattern: RegExp, value: string): boolean {
  if (value.length > MAX_DEDICATED_LENGTH) return false;
  if (consumesAll(pattern, value)) return true;
  const folded = fold(value);
  return folded !== value && consumesAll(pattern, folded);
}

export type ExtendedFieldType = FieldType | 'openQuestion';

export interface ScoredMatch {
  fieldType: ExtendedFieldType;
  score: number;
  confidence: FieldConfidence;
}

/**
 * Open-ended questions. ATS rarely put the question in a <label>; it is usually
 * a sibling <div>, an aria-label or the placeholder, so every text source is
 * considered — not just the label.
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
  /** Did anything but an ambiguous `weak` token contribute? */
  let strongEvidence = false;

  /**
   * Full weight when `pattern` matches, reduced weight when only `weak` does.
   * `bonus` is 0 for attributes: `name="city"` is an identity by construction,
   * which is why it already outweighs prose. Only prose can be *dedicated*.
   */
  const signal = (value: string, strong: number, weak: number, bonus = 0): number => {
    if (!value) return 0;
    if (test(rule.pattern, value)) {
      strongEvidence = true;
      return strong + (bonus > 0 && isDedicated(rule.pattern, value) ? bonus : 0);
    }
    if (rule.weak && test(rule.weak, value)) return weak;
    return 0;
  };

  // 1. autocomplete exact match — highest signal, sufficient for 'high' alone
  if (rule.autocomplete.length > 0 && fp.autocomplete && rule.autocomplete.includes(fp.autocomplete)) {
    score += STRONG.autocomplete;
    strongEvidence = true;
  }

  // 2. name / id (awarded once — they usually carry the same token)
  score += Math.max(
    signal(fp.name, STRONG.nameId, WEAK.nameId),
    signal(fp.id, STRONG.nameId, WEAK.nameId),
  );

  // 3. semantic name (de-obfuscated, e.g. "_systemfield_name" → "name")
  score += signal(fp.semanticName, STRONG.semantic, WEAK.semantic);
  // 4-7. prose sources — eligible for the dedicated-label bonus
  score += signal(fp.ariaLabel, STRONG.aria, WEAK.aria, DEDICATED_BONUS);
  score += signal(fp.labelText, STRONG.label, WEAK.label, DEDICATED_BONUS);
  score += signal(fp.placeholder, STRONG.placeholder, WEAK.placeholder, DEDICATED_BONUS);
  score += signal(fp.contextHeading, STRONG.heading, WEAK.heading, DEDICATED_BONUS);
  // 8. help text: a hint about the field, never its name
  score += signal(fp.description, STRONG.description, WEAK.description);

  return strongEvidence ? score : Math.min(score, WEAK_ONLY_CEILING);
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
 * Score a single field fingerprint against every rule; the best match, or `null`
 * when nothing matched. Weights are the `STRONG` / `WEAK` ladders above.
 *
 * The open-question fallback runs *last*, and only when no dictionary rule is
 * confident enough to fill. A specific rule therefore always beats the heuristic
 * when its match is certain — "Kdy můžete nastoupit?" is a start date, not an
 * essay prompt, because the label names the `availability` rule.
 */
export function scoreField(fp: FieldFingerprint): ScoredMatch | null {
  // Search boxes and filters are never application fields.
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
    // A photo-finish means the winner was decided by rule order, not by
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
