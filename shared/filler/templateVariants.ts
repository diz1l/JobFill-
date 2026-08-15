/**
 * The variant table: one field type, several shapes it may legitimately be
 * answered in, and the signal that picks between them.
 *
 * The field type gives the default (`DEFAULT_TEMPLATES`). A variant overrides it
 * only when the field *asks* for something else, on evidence the page states out
 * loud, in this order of authority:
 *
 *   attribute constraints  `type`, `pattern`, `inputmode` — what the page tells
 *                          the browser it will accept. A `pattern="[0-9]{9}"` is
 *                          not a preference, so these are checked first.
 *   wording                "Příjmení a jméno", "Country code" — the field naming
 *                          the shape it wants.
 *   placeholder            a demonstration of the format ("+420 123 456 789").
 *                          Weakest: decoration, so it only decides when nothing
 *                          stricter has.
 *   maxlength              handled last and separately in `selectTemplate` — it
 *                          says nothing about *which* shape is wanted, only that
 *                          the chosen one does not fit.
 *
 * Guard order inside each list is priority order: the first `when` that holds
 * wins. Guards are pure predicates over `FieldShape` data, so every rule can be
 * tested with an object literal and the whole table works with no API key
 * configured — composition is the normal case, not the AI case.
 */

import { isNumericControl, patternDigitLimit, says, type FieldShape } from './fieldShape';

export interface TemplateVariant {
  /** Stable identity, used in tests and in the fill report. */
  id: string;
  template: string;
  /** The signal that selects this variant. Absent → reachable only by length. */
  when?: (shape: FieldShape) => boolean;
  /**
   * This variant is a *part* of the value, not another spelling of the whole
   * (a dial code without the number). It is filled only when something asked for
   * it by name, and never as a way of fitting `maxlength` — half a phone number
   * in a phone field is exactly the "stub" the composition rules forbid.
   */
  fragment?: boolean;
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────
//
// Soft boundaries `(?<![a-z])` … `(?![a-z])` rather than `\b`, because `_` is a
// word character: `\bname\b` matches `first_name`. Same convention as the field
// dictionary. Everything is tested against `FieldShape.text`, which is already
// lowercased and stripped of diacritics — so the Czech words are written ASCII.

const SURNAME =
  /(?<![a-z])(?:sur[\s._-]?name|last[\s._-]?name|family[\s._-]?name|lname|prijmeni\w*|nazwisko|apellido)(?![a-z])/;
const GIVEN =
  /(?<![a-z])(?:first[\s._-]?name|given[\s._-]?name|forename|fname|jmeno|krestni\w*|imie|nombre)(?![a-z])/;

const INITIALS = /(?<![a-z])(?:initials?|inicial\w*)(?![a-z])/;

/** A country box asking for the ISO code rather than the name. */
const COUNTRY_CODE_WORD =
  /(?<![a-z])(?:(?:country|iso)[\s._-]?code|kod[\s._-]?zeme|zkratka[\s._-]?zeme)(?![a-z])/;

/** One box of a split date. Ordered day/month/year so the tests read that way. */
const DAY_BOX = /(?<![a-z])(?:day|dd|den)(?![a-z])/;
const MONTH_BOX = /(?<![a-z])(?:month|mm|mesic)(?![a-z])/;
const YEAR_BOX = /(?<![a-z])(?:year|yyyy|yy|rok)(?![a-z])/;

/** `15.03.1990` — the Czech spelling, and never what `type="date"` wants. */
const DOTTED_DATE = /(?:dd|d)\s*\.\s*(?:mm|m)\s*\.\s*(?:yyyy|rrrr|yy)/;

/** A four-digit box is a year box whatever its label says. */
function isYearBox(shape: FieldShape): boolean {
  return shape.maxLength === 4 || patternDigitLimit(shape.pattern) === 4;
}

/**
 * The field shows what a *whole* date should look like — `dd.mm.rrrr` as a
 * placeholder, or a label spelling the format out. Such a field wants one value,
 * not one component, even though the demonstration contains the word `dd`.
 */
function demonstratesFullDate(shape: FieldShape): boolean {
  return DOTTED_DATE.test(shape.placeholder) || says(shape, DOTTED_DATE);
}

/**
 * One box of a split date — and only that. A format demonstration mentions every
 * component, so it can never select one of them.
 */
function isSplitBox(shape: FieldShape, part: RegExp): boolean {
  return !demonstratesFullDate(shape) && says(shape, part);
}

const COUNTRY_CODE =
  /(?<![a-z])(?:(?:country|dial|calling)[\s._-]?code|predvolb\w*|telefonni[\s._-]?predcisli\w*)(?![a-z])/;
const WITHOUT_COUNTRY_CODE =
  /(?<![a-z])(?:without[\s._-]?(?:the[\s._-]?)?(?:country|dial)[\s._-]?code|bez[\s._-]?predvolb\w*|national[\s._-]?(?:number|format)|local[\s._-]?number)(?![a-z])/;

/** A placeholder that demonstrates grouping: `+420 123 456 789`, `123 456 789`. */
const GROUPED_DIGITS = /\d\s\d/;

const USERNAME =
  /(?<![a-z])(?:user[\s._-]?names?|handles?|nick\w*|profile[\s._-]?ids?|uzivatelsk\w*[\s._-]?jmeno)(?![a-z])/;
const URL_WORD = /(?<![a-z])(?:urls?|links?|odkaz\w*)(?![a-z])/;
const DOMAIN_WORD = /(?<![a-z])(?:domains?|hosts?|hostnames?|domena\w*)(?![a-z])/;

/**
 * Words that widen a "city" field into a whole location. `location` is here for
 * the same reason it is a weak token in the matcher: on its own it means
 * anything, but next to a city rule it means "more than the town, please".
 */
const WIDER_THAN_CITY =
  /(?<![a-z])(?:countr\w*|state|province|region|kraj|zeme|stat|locations?|lokalit\w*|adress\w*|address(?:es)?)(?![a-z])/;

/** How many digits still fit in a subscriber number with no country code. */
const MAX_NATIONAL_DIGITS = 10;

// ─── Helpers shared by several guards ────────────────────────────────────────

/**
 * Where a field names both halves of a person's name, and in which order.
 *
 * Decided inside a *single* readable source rather than across the whole
 * fingerprint: "Příjmení a jméno" as a label is a statement about order, while
 * `name="jmeno"` next to a label reading "Příjmení" is two sources talking about
 * different things. The first source that mentions both wins.
 */
export function nameOrder(text: string): { surnameFirst: boolean; comma: boolean } {
  for (const source of text.split('|')) {
    const surname = SURNAME.exec(source);
    const given = GIVEN.exec(source);
    if (!surname || !given) continue;
    if (surname.index > given.index) return { surnameFirst: false, comma: false };
    const between = source.slice(surname.index + surname[0].length, given.index);
    return { surnameFirst: true, comma: between.includes(',') };
  }
  return { surnameFirst: false, comma: false };
}

/** A `pattern` that caps the number of digits below what E.164 needs. */
function capsDigitsAt(shape: FieldShape, limit: number): boolean {
  const cap = patternDigitLimit(shape.pattern);
  return cap > 0 && cap <= limit;
}

function demandsUrl(shape: FieldShape): boolean {
  return shape.controlType === 'url' || /https?/.test(shape.pattern) || says(shape, URL_WORD);
}

// ─── The table ───────────────────────────────────────────────────────────────

export const VARIANTS: Record<string, TemplateVariant[]> = {
  /**
   * The case this whole layer was built for: two atoms, one box, and no single
   * right order. Czech forms ask "Příjmení a jméno" as often as English ones ask
   * "Full name", and the difference is stated in the label.
   */
  fullName: [
    {
      id: 'fullName.initials',
      template: '{firstInitial}{lastInitial}',
      when: (s) => says(s, INITIALS),
    },
    {
      id: 'fullName.surnameFirstComma',
      template: '{familyName}, {givenName}',
      when: (s) => nameOrder(s.text).comma,
    },
    {
      id: 'fullName.surnameFirst',
      template: '{familyName} {givenName}',
      when: (s) => nameOrder(s.text).surnameFirst,
    },
    /** No signal selects this one — it exists for a box too short for the rest. */
    { id: 'fullName.shortForm', template: '{firstInitial}. {familyName}' },
  ],

  /**
   * The profile stores E.164 (`+420123456789`) because that is the one spelling
   * that is unambiguous. Forms disagree, loudly and in attributes.
   */
  phone: [
    {
      // "bez předvolby" names the country code in order to *exclude* it, and
      // says so with the same word — hence the second test.
      id: 'phone.countryCode',
      template: '{phoneCountryCode}',
      fragment: true,
      when: (s) => says(s, COUNTRY_CODE) && !says(s, WITHOUT_COUNTRY_CODE),
    },
    {
      // `pattern="[0-9]{12}"` — every digit, but the `+` would fail validation.
      id: 'phone.digits',
      template: '{phoneDigits}',
      when: (s) => isNumericControl(s) && !capsDigitsAt(s, MAX_NATIONAL_DIGITS),
    },
    {
      // `pattern="[0-9]{9}"`, `<input type="number">`, "bez předvolby".
      id: 'phone.national',
      template: '{phoneNational}',
      when: (s) => says(s, WITHOUT_COUNTRY_CODE) || capsDigitsAt(s, MAX_NATIONAL_DIGITS),
    },
    {
      id: 'phone.spaced',
      template: '{phoneSpaced}',
      when: (s) => GROUPED_DIGITS.test(s.placeholder),
    },
  ],

  /** ATS ask for the profile URL about as often as for the bare handle. */
  linkedin: [
    { id: 'linkedin.user', template: '{linkedinUser}', when: (s) => says(s, USERNAME) },
    { id: 'linkedin.url', template: '{linkedinUrl}', when: demandsUrl },
  ],
  github: [
    { id: 'github.user', template: '{githubUser}', when: (s) => says(s, USERNAME) },
    { id: 'github.url', template: '{githubUrl}', when: demandsUrl },
  ],
  website: [
    { id: 'website.host', template: '{websiteHost}', when: (s) => says(s, DOMAIN_WORD) },
    { id: 'website.url', template: '{websiteUrl}', when: demandsUrl },
  ],

  /**
   * "Praha, Czechia" in the profile answers "Location" as it stands and answers
   * "City" with its first part. The default is the narrow one — a city field is
   * the common case, and a stray ", Czechia" fails more validators than it
   * satisfies.
   */
  city: [{ id: 'city.full', template: '{city}', when: (s) => says(s, WIDER_THAN_CITY) }],

  /** `<input type="number">` discards "80 000 Kč" outright and stays empty. */
  salary: [{ id: 'salary.number', template: '{salaryNumber}', when: isNumericControl }],

  /**
   * A country box wants either the name or the two-letter code, and says which.
   * `atoms.ts` derives one from the other only for countries it knows: an
   * unlisted country keeps whatever the profile holds and gets no invented code,
   * so this variant resolves to nothing rather than to a guess.
   */
  country: [
    {
      id: 'country.code',
      template: '{countryCode}',
      when: (s) => says(s, COUNTRY_CODE_WORD) || (s.maxLength > 0 && s.maxLength <= 3),
    },
    { id: 'country.name', template: '{countryName}' },
  ],

  /**
   * The profile stores a date input's canonical `yyyy-mm-dd`. Forms ask in three
   * shapes, and only the split one needs a signal — a single box is served by
   * whichever spelling its own attributes describe.
   */
  dateOfBirth: [
    // Checked before the single-box spellings, because a box that demonstrates
    // `dd.mm.rrrr` contains the literal `dd` — and read as a day box it answered
    // a whole date field with "15".
    {
      id: 'dob.dotted',
      template: '{dobDotted}',
      // A Czech form writes 15.03.1990; `type="date"` never wants that spelling.
      when: (s) => s.controlType !== 'date' && demonstratesFullDate(s),
    },
    { id: 'dob.day', template: '{dobDay}', when: (s) => isSplitBox(s, DAY_BOX) },
    { id: 'dob.month', template: '{dobMonth}', when: (s) => isSplitBox(s, MONTH_BOX) },
    {
      id: 'dob.year',
      template: '{dobYear}',
      when: (s) => isSplitBox(s, YEAR_BOX) || (isYearBox(s) && !demonstratesFullDate(s)),
    },
    { id: 'dob.iso', template: '{dobIso}' },
  ],

  /** "5 years" is stored; a number box takes the 5 and drops the rest. */
  yearsOfExperience: [
    { id: 'experience.number', template: '{experienceYears}', when: isNumericControl },
  ],
};
