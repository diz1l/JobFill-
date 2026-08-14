/**
 * What the language model is asked for, and what it is allowed to answer.
 *
 * ── Why this is not a classifier ────────────────────────────────────────────
 * The old contract was `fingerprint → field type`, one name out of a fixed list.
 * That list cannot express the case the first field report was about: "Jméno a
 * příjmení" is one box wanting two profile atoms, so no single type name is the
 * right answer and the field stayed empty however well the model understood it.
 *
 * The contract is now `fingerprint → value template`: a string of `{placeholder}`
 * references to profile atoms, resolved *in the page* by
 * `shared/filler/valueTemplate.ts`. Two consequences:
 *
 *   • The model is shown the *names* of the atoms (`firstName`), never their
 *     values (`Dias`). Composition happens after the answer comes back, against
 *     data that never left the browser; the prompt holds atom names, syntax and
 *     fingerprints and nothing else.
 *   • The vocabulary is no longer a list of supported fields — a field the
 *     dictionary has no rule for can still be answered, provided the profile
 *     holds something that fits it.
 *
 * ── The model is not trusted ────────────────────────────────────────────────
 * Everything below the prompt is validation. The prompt states the rules because
 * a model that understands them answers better; {@link validateFieldTemplates}
 * enforces them because a prompt is not an enforcement mechanism. A template may
 * only *reference* atoms, never introduce text of its own, so model-authored
 * prose has no path into a form.
 */

import { isProfileValueKey, PROFILE_VALUE_KEYS, type ValueTemplate } from '../filler/valueTemplate';

/** Same shape `resolveTemplate` substitutes, so the two can never disagree. */
const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/**
 * How many atoms one field may be built from. Real compositions are two ("first
 * + last", "city, country") and three is already unusual; a template naming five
 * is a model emptying the profile into one box, which no form ever asked for.
 */
const MAX_PLACEHOLDERS = 3;

/**
 * Characters allowed *between* placeholders, and how many of them. This is the
 * rule that makes "the model cannot write into your form" true rather than
 * aspirational: literal text is restricted to separators, so
 * `"{lastName}, {firstName}"` passes while `"I confirm that I have read the
 * terms"` and `"1990-01-01"` cannot be expressed at all. Digits and letters are
 * absent from the set on purpose.
 */
const SAFE_LITERAL = /^[\s,;:/|·—–\-().]*$/;
const MAX_LITERAL_CHARS = 12;

/** Answers that mean "I have nothing for this field". All are accepted. */
const DECLINED = new Set(['', 'unknown', 'none', 'null', 'skip', 'n/a', 'na', '-', '?']);

/**
 * The pre-template contract, kept alive on purpose. Models regress to the shape
 * the input suggests, and a list of form-field fingerprints suggests
 * classification very strongly — a smaller model answers `"email"` however the
 * prompt is worded, and rejecting that would throw away a *correct* answer over
 * its formatting.
 *
 * Accepting both is safe because the formats cannot be confused: a bare
 * identifier is never a valid template, so "no braces" unambiguously means "type
 * name" and is normalised into the single-atom template it stood for. Everything
 * downstream sees one format.
 *
 * Derived from {@link PROFILE_VALUE_KEYS} rather than `DEFAULT_TEMPLATES`, which
 * is not part of the frozen `valueTemplate` contract.
 */
const LEGACY_TYPE_TEMPLATES: Readonly<Record<string, ValueTemplate>> = {
  ...Object.fromEntries(PROFILE_VALUE_KEYS.map((key) => [key, `{${key}}`])),
  fullName: '{firstName} {lastName}',
  name: '{firstName} {lastName}',
};

// ─── Fields the model is not allowed to answer ───────────────────────────────

/**
 * Why a field is out of bounds for the LLM pass. These are the places where a
 * wrong value costs more than an empty box does. A refusal is free — the field
 * stays as the heuristics left it — so the categories are drawn generously and
 * the false-positive risk is accepted deliberately.
 */
export type RefusalReason =
  /** Consent, agreement, opt-in — which the extension never fills anywhere. */
  | 'consent'
  /** About the employer / posting / recruiter, not about the applicant. */
  | 'employer'
  /** About a third party: reference, emergency contact, guardian, spouse. */
  | 'thirdParty'
  /** Date of birth, age, identity documents, national ID numbers. */
  | 'identity'
  /** Bank, card, tax and insurance details. */
  | 'financial';

interface RefusalRule {
  reason: RefusalReason;
  pattern: RegExp;
}

/**
 * Matched against the *serialized fingerprint* — `autocomplete|name|id|
 * semanticName|aria-label|label|placeholder|heading|description` — so a field is
 * caught by its markup as well as by its visible label. Czech terms are included
 * because the target job boards are Czech.
 */
const REFUSAL_RULES: readonly RefusalRule[] = [
  {
    reason: 'consent',
    pattern:
      /consent|agree|agreement|accept the|opt[\s_-]?in|subscribe|newsletter|gdpr|privacy|\bterms\b|declaration|certif|souhlas|podmink|podmínk|zásad|prohlaš|prohlas/i,
  },
  {
    reason: 'employer',
    pattern:
      /\bemployer\b|\bcompany\b|\bcompanies\b|organi[sz]ation|\brecruiter\b|hiring manager|job title|position applied|vacancy|\bfirma\b|firmy|zaměstnavatel|zamestnavatel|společnost|spolecnost|nábor/i,
  },
  {
    reason: 'thirdParty',
    pattern:
      /referen[cs]e|referee|referral|\breferred by\b|emergency|next of kin|guardian|\bspouse\b|\bparent\b|kontaktní osoba|kontaktni osoba|doporuč|doporuc/i,
  },
  {
    reason: 'identity',
    pattern:
      /date of birth|birth\s?date|\bbirthday\b|\bdob\b|\bborn\b|\bage\b|passport|national insurance|\bssn\b|social security|identity (?:card|number)|\bid number\b|personal number|visa number|rodné číslo|rodne cislo|datum narození|datum narozeni|občansk|obcansk|\bvěk\b/i,
  },
  {
    reason: 'financial',
    pattern:
      /\biban\b|\bswift\b|\bbic\b|bank account|account number|sort code|card number|\bcvv\b|tax id|\btin\b|\bvat\b|insurance number|číslo účtu|cislo uctu|bankovn|daňov|danov|pojišt|pojist/i,
  },
];

/**
 * The first reason this field may not be filled by the model, or `null`.
 * Exported because it is a product rule, not an implementation detail: the same
 * predicate runs at the API boundary in the worker and again in the page before
 * anything is written.
 */
export function refusalReason(fingerprint: string): RefusalReason | null {
  for (const rule of REFUSAL_RULES) {
    if (rule.pattern.test(fingerprint)) return rule.reason;
  }
  return null;
}

/**
 * Fields that may be answered, but only with one specific atom — the middle
 * ground between "fill it" and "refuse it". A money field is not categorically
 * off-limits, since the profile holds a salary expectation the user wrote
 * themselves, but that string is the *only* thing that may go into it: a
 * composed value, or any other atom, is a model inventing a number. Likewise
 * "Preferred start date" is legitimately `{availability}` and nothing else
 * (a date of birth is refused outright above, before this rule is reached).
 */
const RESTRICTED_FIELDS: ReadonlyArray<{ atom: string; pattern: RegExp }> = [
  {
    atom: 'salary',
    pattern:
      /salary|wage|compensation|remuneration|\bpay\b|\brate\b|\bamount\b|\bsum\b|\bfee\b|budget|expected earnings|\bmzda\b|\bmzdu\b|\bplat\b|\bplatu\b|odměn|odmen|honorář|honorar/i,
  },
  {
    atom: 'availability',
    pattern:
      /\bdate\b|\bdates\b|start(?:ing)? (?:date|day)|available from|availability|notice period|when can you|earliest|\bdatum\b|nástup|nastup|termín|termin|výpovědní|vypovedni/i,
  },
];

/** The only atom this field may receive, or `null` when unrestricted. */
export function restrictedAtom(fingerprint: string): string | null {
  for (const rule of RESTRICTED_FIELDS) {
    if (rule.pattern.test(fingerprint)) return rule.atom;
  }
  return null;
}

// ─── Template validation ─────────────────────────────────────────────────────

/** The atoms a template references, in order of appearance. */
export function templateAtoms(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER), (m) => m[1]);
}

/**
 * One model answer → a template we are willing to resolve, or `null`.
 *
 * `null` covers every rejection: a decline, an unknown legacy type name, a
 * reference to a non-existent atom, invented literal text, a malformed
 * placeholder. `resolveTemplate` would already return `''` for an unknown atom,
 * but relying on that would let a bad answer travel all the way to the DOM
 * before being dropped, and says nothing about the other failure modes.
 */
export function toValueTemplate(answer: string): ValueTemplate | null {
  const trimmed = answer.trim();
  if (DECLINED.has(trimmed.toLowerCase())) return null;

  // No braces: this is the pre-template contract. Either a type name we can
  // translate, or a literal the model made up — and a literal is never accepted.
  if (!trimmed.includes('{')) return LEGACY_TYPE_TEMPLATES[trimmed] ?? null;

  const atoms = templateAtoms(trimmed);
  if (atoms.length === 0 || atoms.length > MAX_PLACEHOLDERS) return null;
  // A template referencing an atom that does not exist was authored against a
  // profile shape we do not have. It is dropped whole: filling the rest of it
  // would answer a different question than the one the field asked.
  if (!atoms.every(isProfileValueKey)) return null;

  const literal = trimmed.replace(PLACEHOLDER, '');
  // Unmatched braces end up here too — `{` is not in the safe set.
  if (literal.length > MAX_LITERAL_CHARS || !SAFE_LITERAL.test(literal)) return null;

  return trimmed;
}

/**
 * Validate a whole model response against the batch it answers.
 *
 * Keys must be indices of the submitted fingerprints; values must survive
 * {@link toValueTemplate}; and the field must be one the model is allowed to
 * fill. Everything else is dropped silently, entry by entry — a hallucinated
 * answer costs the fields it was about, never the batch.
 *
 * Takes the fingerprints rather than a count because the per-field rules need
 * them: "is this a consent box" is asked here, on the way *out* of the model,
 * not left to the prompt.
 */
export function validateFieldTemplates(
  raw: unknown,
  fingerprints: readonly string[],
): Record<string, ValueTemplate> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const out: Record<string, ValueTemplate> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= fingerprints.length) continue;
    if (typeof value !== 'string') continue;

    const template = toValueTemplate(value);
    if (!template) continue;

    const fingerprint = fingerprints[index];
    if (refusalReason(fingerprint)) continue;

    const only = restrictedAtom(fingerprint);
    if (only && !templateAtoms(template).every((atom) => atom === only)) continue;

    out[String(index)] = template;
  }
  return out;
}

// ─── The prompt ──────────────────────────────────────────────────────────────

/**
 * What one fingerprint is made of, restated for the model.
 * Mirrors `serializeFingerprint` in `shared/field-matcher/fingerprint.ts`.
 */
const FINGERPRINT_SHAPE =
  'autocomplete|name|id|semantic-name|aria-label|label|placeholder|nearby-heading|description';

/**
 * The rules, in the model's own working order: what it may say, how to say it,
 * and when to say nothing.
 *
 * The refusal list is stated here *as well as* enforced in
 * {@link validateFieldTemplates} because the two do different jobs — the
 * validator makes a bad answer harmless, the prompt makes a good answer more
 * likely and stops the model spending output budget on fields that would be
 * discarded anyway.
 */
export const FIELD_TEMPLATE_SYSTEM_PROMPT = `You are a JSON API that decides what belongs in a job-application form field.

You never see the applicant's data. You are given the NAMES of the values the extension holds, and you answer with a template naming the ones to use. The extension substitutes them locally.

Available values: ${PROFILE_VALUE_KEYS.join(', ')}.

Template syntax — a value name in braces, and nothing else:
  "{email}"                  one value
  "{firstName} {lastName}"   two values joined by a space, for a single "Full name" box
  "{lastName}, {firstName}"  surname first
At most ${MAX_PLACEHOLDERS} values per field. Between them you may use only spaces and simple punctuation ( , ; / | - . ). You must NEVER write words, sentences, numbers, dates, e-mail addresses or any other text of your own: every character a field receives comes from a value name or from a separator.

Answer "" — say nothing — when:
  - no available value fits the field, or you are not certain which one does;
  - the field is a consent, agreement, declaration or opt-in;
  - the field is about the employer, the job posting or the recruiter;
  - the field is about anyone other than the applicant: a reference, a referee, an emergency contact, a next of kin, a guardian, a spouse;
  - the field asks for money, bank, tax or insurance details;
  - the field asks for a date of birth, an age, a passport, a national ID or any other identity document.
"" is always a correct answer. A wrong value in an application form costs the applicant the application; an empty field costs them a few seconds.

Respond with a JSON object only: field index (as a string) to template. Include every index.`;

/**
 * The user half: the batch itself. Kept apart from the rules so that what leaves
 * the browser per request is visibly just this — fingerprints, nothing else.
 */
export function buildFieldTemplatePrompt(fingerprints: readonly string[]): string {
  return `Each line is one form field: index, then its fingerprint (${FINGERPRINT_SHAPE}).

${fingerprints.map((fp, i) => `${i}: "${fp}"`).join('\n')}

Answer with {"0": "<template or empty string>", …} for indices 0-${fingerprints.length - 1}.`;
}
