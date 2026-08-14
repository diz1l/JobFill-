/**
 * What a field says about the *shape* of the answer it wants.
 *
 * Field matching answers "what is this?" — a phone, a full name — which is not
 * enough to fill it: `pattern="[0-9]{9}"` means the country code is unwelcome,
 * `<input type="url">` will not accept `linkedin.com/in/ada` without a scheme,
 * `<input type="number">` silently discards a value containing `+` or a
 * currency, and `maxlength="5"` on a name field cannot be holding "Nurgaliyev".
 * Each is a fact the page states out loud. So the matcher's answer picks the
 * template and this DOM-derived description picks the variant.
 *
 * Deliberately a plain data object rather than a live element, which keeps the
 * variant table a set of pure predicates a test can call with a literal.
 */

export interface FieldShape {
  /**
   * Everything readable about the field — name, id, label, aria, placeholder,
   * heading, help text — lowercased, stripped of diacritics, joined by `|`.
   * Sources are separated so that a token from one is never read as adjacent to
   * a token from the next.
   */
  text: string;
  /** The placeholder on its own: it often *demonstrates* the wanted format. */
  placeholder: string;
  /** `maxlength`, or 0 when the field does not constrain length. */
  maxLength: number;
  /** The `pattern` attribute, verbatim. */
  pattern: string;
  /** `inputmode`, lowercased. */
  inputMode: string;
  /** `type`, lowercased. `''` for a textarea, a select, or a plain input. */
  controlType: string;
  /** True for a textarea — a box that expects prose, not a formatted token. */
  multiline: boolean;
}

/**
 * The subset of a field fingerprint this module reads. Structural rather than
 * imported, so `FieldFingerprint` satisfies it and so does an object literal in
 * a test — and the filler does not have to depend on the matcher's type.
 */
export interface FieldDescription {
  element?: Element | null;
  name?: string;
  id?: string;
  semanticName?: string;
  ariaLabel?: string;
  labelText?: string;
  placeholder?: string;
  contextHeading?: string;
  description?: string;
}

/** Lowercase, strip diacritics, collapse whitespace. `Příjmení` → `prijmeni`. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A field that says nothing about the shape it wants. */
export const ANY_SHAPE: FieldShape = {
  text: '',
  placeholder: '',
  maxLength: 0,
  pattern: '',
  inputMode: '',
  controlType: '',
  multiline: false,
};

export function describeField(desc: FieldDescription): FieldShape {
  const el = desc.element ?? null;
  const attr = (name: string): string => el?.getAttribute(name)?.trim() ?? '';

  const placeholder = desc.placeholder ?? attr('placeholder');
  const text = [
    desc.name,
    desc.id,
    desc.semanticName,
    desc.ariaLabel,
    desc.labelText,
    placeholder,
    desc.contextHeading,
    desc.description,
  ]
    .map((source) => normalizeText(source ?? ''))
    .filter(Boolean)
    .join(' | ');

  const maxLength = Number.parseInt(attr('maxlength'), 10);

  return {
    text,
    placeholder,
    // A negative or unparsable maxlength is no constraint at all.
    maxLength: maxLength > 0 ? maxLength : 0,
    pattern: attr('pattern'),
    inputMode: normalizeText(attr('inputmode')),
    controlType: normalizeText(attr('type')),
    multiline: (el?.tagName ?? '').toLowerCase() === 'textarea',
  };
}

// ─── Reading the constraints ─────────────────────────────────────────────────

/**
 * How many digits `pattern` will accept at most — 0 when it does not say.
 *
 * `[0-9]{9}` → 9, `\d{9,12}` → 12. The first quantified digit class decides:
 * that is the one that sizes the field on every real-world phone pattern.
 */
export function patternDigitLimit(pattern: string): number {
  const found = /(?:\[0-9\]|\[\\d\]|\\d)\{(\d+)(?:,(\d+))?\}/.exec(pattern);
  if (!found) return 0;
  return Number(found[2] ?? found[1]);
}

/** Does `pattern` admit a literal `+`? A bare `+` is a quantifier, not a plus. */
export function patternAllowsPlus(pattern: string): boolean {
  return /\\\+|\[[^\]]*\+[^\]]*\]/.test(pattern);
}

/**
 * True when the control can only hold digits.
 *
 * `<input type="number">` is the one that matters: assigning `+420123456789` to
 * it leaves the field **empty** — the value is not a valid floating-point
 * number, so the browser rejects it outright. The same box got "80 000 Kč"
 * assigned for a salary and stayed blank. An `inputmode` is a softer statement
 * (it only chooses a keyboard) but it is still the page saying "digits".
 */
export function isNumericControl(shape: FieldShape): boolean {
  return (
    shape.controlType === 'number' ||
    shape.inputMode === 'numeric' ||
    shape.inputMode === 'decimal' ||
    (shape.pattern !== '' &&
      patternDigitLimit(shape.pattern) > 0 &&
      !patternAllowsPlus(shape.pattern))
  );
}

/** Does any readable part of the field match? */
export function says(shape: FieldShape, pattern: RegExp): boolean {
  return pattern.test(shape.text);
}
