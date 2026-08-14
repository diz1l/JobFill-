import type { Profile } from '../types';
import { deriveAtoms, DERIVED_VALUE_KEYS, type DerivedValueKey } from './atoms';
import { VARIANTS, type TemplateVariant } from './templateVariants';
import type { FieldShape } from './fieldShape';

/**
 * How a form field's value is *described* rather than computed.
 *
 * A form asks for whatever shape it likes: "Full name", "Jméno a příjmení",
 * "Surname, first name". The profile stores atoms, and the naive bridge — a
 * `fieldType → profile property` lookup — cannot express "join two atoms", which
 * is exactly the case the first field report was about. So a match resolves to a
 * *template* instead of a value:
 *
 *     "{firstName} {lastName}"   →  "Dias Nurgaliyev"
 *     "{lastName}, {firstName}"  →  "Nurgaliyev, Dias"
 *
 * The indirection buys privacy, not elegance: it is what lets the LLM pass
 * answer with the *names* of the atoms to join instead of being shown the
 * profile (see `shared/api/fieldTemplates.ts`). Substitution happens here, in
 * the page, against data that never left it.
 *
 * ── The three moving parts ───────────────────────────────────────────────────
 *   `atoms.ts`             re-spellings of what the profile holds: the phone
 *                          without its country code, the LinkedIn handle without
 *                          the URL around it, a surname split out of a box that
 *                          holds the whole name.
 *   `fieldShape.ts`        what the field states about the answer it will accept
 *                          (`pattern`, `type`, `maxlength`, its own wording).
 *   `templateVariants.ts`  which spelling that adds up to.
 *
 * All three are deterministic. Composition is not an AI feature: with no API key
 * configured, "Příjmení a jméno" is still filled correctly, and a phone box with
 * `pattern="[0-9]{9}"` still gets nine digits.
 */

/**
 * Placeholder names a template may reference.
 *
 * This is also the vocabulary the LLM prompt offers the model, so it is
 * deliberately a description of the *profile* — one name per thing a user typed
 * into settings — and not of everything a template can say. The computed
 * spellings live in {@link DERIVED_VALUE_KEYS}; a template may use either.
 */
export const PROFILE_VALUE_KEYS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'city',
  'linkedin',
  'github',
  'website',
  'salary',
  'availability',
  'workPermit',
  'about',
  /** Not a profile property — the resolved cover-letter text for this posting. */
  'coverLetter',
] as const;

export type ProfileValueKey = (typeof PROFILE_VALUE_KEYS)[number];

/** Every name a template may reference: stored atoms plus computed spellings. */
export const TEMPLATE_VALUE_KEYS = [...PROFILE_VALUE_KEYS, ...DERIVED_VALUE_KEYS] as const;

export type TemplateValueKey = ProfileValueKey | DerivedValueKey;

/** A string of literal text and `{placeholder}` references. */
export type ValueTemplate = string;

export interface ValueContext {
  profile: Profile;
  /** Template body with {company}/{position}/{source} already substituted. */
  coverLetter?: string;
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** The atoms a template can draw on, flattened out of the context. */
function atoms(ctx: ValueContext): Record<TemplateValueKey, string> {
  const p = ctx.profile;
  const stored = {
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phone: p.phone,
    city: p.city,
    linkedin: p.linkedin,
    github: p.github,
    website: p.website,
    salary: p.salaryExpectation,
    availability: p.availability,
    workPermit: p.workPermit,
    about: p.about,
    coverLetter: ctx.coverLetter ?? '',
  };
  return { ...stored, ...deriveAtoms(stored) };
}

export function isProfileValueKey(name: string): name is ProfileValueKey {
  return (PROFILE_VALUE_KEYS as readonly string[]).includes(name);
}

/** Is this a name `resolveTemplate` knows how to substitute? */
export function isTemplateValueKey(name: string): name is TemplateValueKey {
  return isProfileValueKey(name) || (DERIVED_VALUE_KEYS as readonly string[]).includes(name);
}

/**
 * Substitute a template against the profile.
 *
 * Returns `''` — meaning "write nothing" — when the template names a key that
 * does not exist, or when nothing survives substitution. A template whose atoms
 * are only *partly* filled resolves to the part that exists: a profile with a
 * first name and no surname should still answer "Full name" with the first
 * name, which beats leaving the field blank and beats writing a dangling
 * separator. Leftover separators are cleaned up rather than emitted.
 */
export function resolveTemplate(template: ValueTemplate, ctx: ValueContext): string {
  if (!template) return '';

  const values = atoms(ctx);
  let sawUnknownKey = false;
  let droppedAtom = false;
  let placeholders = 0;
  let filledAtoms = 0;

  const substituted = template.replace(PLACEHOLDER, (_match, name: string) => {
    placeholders++;
    if (!isTemplateValueKey(name)) {
      sawUnknownKey = true;
      return '';
    }
    // Total by construction: `values` is a Record over every key the guard
    // admits, so a name that passed it always has an entry.
    const value = values[name];
    if (value) {
      filledAtoms++;
    } else {
      droppedAtom = true;
    }
    return value;
  });

  // An unknown key means the template was authored against a profile shape that
  // does not exist — most likely a model inventing a field. Writing the rest of
  // it would silently answer a different question than the one asked.
  if (sawUnknownKey) return '';

  // Every atom the template asked for is missing, so whatever is left is the
  // template's own punctuation and connecting words: "+420 " for a profile with
  // no phone, "Praha, " for one with no city. That is a stub, not an answer, and
  // an employer reading it cannot tell it from a typo.
  if (placeholders > 0 && filledAtoms === 0) return '';

  // Repair only when substitution actually lost something. Otherwise the result
  // is returned byte for byte: a cover letter is a template too, and collapsing
  // its blank lines or trimming the comma after "Dobrý den," would be this
  // function quietly rewriting prose it was only asked to substitute into.
  return droppedAtom ? repairGaps(substituted) : substituted;
}

/**
 * Close the hole a dropped atom leaves behind.
 * `"Nurgaliyev, "` → `"Nurgaliyev"`, `" / dias@example.com"` → `"dias@example.com"`.
 *
 * Line structure is preserved: a gap is repaired within its own line, because a
 * multi-line value that lost one atom is still multi-line.
 */
function repairGaps(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[^\S\n]+/g, ' ')
        .replace(/(^|\s)[,;/|·—–-]+(?=\s|$)/g, '$1')
        .replace(/\s*[,;/|·—–-]+\s*$/, '')
        .replace(/^\s*[,;/|·—–-]+\s*/, '')
        .replace(/[^\S\n]+/g, ' ')
        .trim(),
    )
    .join('\n')
    .trim();
}

/**
 * Default template per dictionary field type — the answer when the field says
 * nothing about the shape it wants.
 *
 * The name types read `{givenName}` / `{familyName}` rather than the raw profile
 * properties. Normally those are the same thing; they differ when the user typed
 * their whole name into one settings box, and a form asking for the two halves
 * separately still gets them. `{firstName}` / `{lastName}` remain valid — a
 * template may always name the stored atom directly.
 */
export const DEFAULT_TEMPLATES: Record<string, ValueTemplate> = {
  firstName: '{givenName}',
  lastName: '{familyName}',
  fullName: '{givenName} {familyName}',
  email: '{email}',
  phone: '{phone}',
  linkedin: '{linkedin}',
  github: '{github}',
  website: '{website}',
  salary: '{salary}',
  city: '{cityName}',
  coverLetter: '{coverLetter}',
  availability: '{availability}',
  workPermit: '{workPermit}',
  about: '{about}',
};

/**
 * The template a field type resolves to, refined by what the field asks for.
 *
 *  1. **What was asked.** The first variant whose guard holds wins; with none
 *     holding (or no shape at all) the type's default stands.
 *  2. **What fits.** `maxlength` says nothing about shape, only about length, so
 *     it never *selects* a variant — only rejects one. If the chosen spelling is
 *     too long the longest other spelling that fits is used: `maxlength="9"` on
 *     a phone gets the nine national digits, not a truncated E.164 number.
 *
 * Nothing is ever cut to length. A truncated value is a wrong value that looks
 * right — "Dias Nurgaliy" is not a surname, and 12 digits of a 13-digit number
 * is somebody else's phone. When no spelling fits, the chosen one is returned
 * as-is and the field is highlighted for review like any other.
 */
export function selectTemplate(
  fieldType: string,
  ctx: ValueContext,
  shape?: FieldShape,
): ValueTemplate {
  const fallback = DEFAULT_TEMPLATES[fieldType] ?? '';
  const variants = VARIANTS[fieldType];
  if (!shape || !variants) return fallback;

  const chosen = variants.find((variant) => variant.when?.(shape) === true)?.template ?? fallback;
  if (shape.maxLength === 0) return chosen;
  if (resolveTemplate(chosen, ctx).length <= shape.maxLength) return chosen;

  return longestThatFits(variants, fallback, ctx, shape.maxLength) ?? chosen;
}

/**
 * The fullest spelling that still fits, or `undefined` when none does.
 *
 * Fragments never take part: a field too short for a phone number is not asking
 * for the dial code on its own.
 */
function longestThatFits(
  variants: readonly TemplateVariant[],
  fallback: ValueTemplate,
  ctx: ValueContext,
  maxLength: number,
): ValueTemplate | undefined {
  let best: { template: ValueTemplate; length: number } | undefined;

  for (const candidate of [
    fallback,
    ...variants.filter((v) => !v.fragment).map((v) => v.template),
  ]) {
    const length = resolveTemplate(candidate, ctx).length;
    if (length === 0 || length > maxLength) continue;
    if (!best || length > best.length) best = { template: candidate, length };
  }

  return best?.template;
}

/** Resolve a dictionary field type straight to a value. */
export function resolveFieldType(fieldType: string, ctx: ValueContext, shape?: FieldShape): string {
  return resolveTemplate(selectTemplate(fieldType, ctx, shape), ctx);
}

const IS_TEMPLATE = /\{[a-zA-Z]+\}/;

/**
 * Resolve whatever the classifier answered with — a template or a bare field
 * type. Both are accepted because a smaller model regresses to answering with a
 * type name however the prompt is worded (see `LEGACY_TYPE_TEMPLATES`), and a
 * correct answer should not be thrown away over its formatting. Either way it is
 * resolved the same way a built-in template is: locally, against data that never
 * left the page.
 */
export function resolveAnswer(answer: string, ctx: ValueContext, shape?: FieldShape): string {
  return IS_TEMPLATE.test(answer)
    ? resolveTemplate(answer, ctx)
    : resolveFieldType(answer, ctx, shape);
}
