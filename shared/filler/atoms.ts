/**
 * Derived atoms — the same facts the profile already holds, in the other shapes
 * forms ask for them in. The profile stores one canonical spelling per fact (a
 * phone in E.164, a LinkedIn address as a URL); forms ask for whichever spelling
 * their backend validates. Every entry here is a *re-spelling* of something the
 * profile already contains.
 *
 * The line this module may not cross: a derived atom is empty whenever its
 * source is. Nothing here guesses, defaults or completes a missing fact —
 * `phoneNational` of an empty phone is `''`, not a plausible number. That is the
 * difference between composing and inventing, and it is what makes the template
 * layer safe to point at a form an employer reads.
 *
 * ── What is deliberately *not* derived ───────────────────────────────────────
 * Most profile entries have exactly one spelling, and inventing a second is the
 * failure mode this module exists to avoid:
 *
 *   `preferredName`  is not `firstName`. An empty "goes by" is not evidence that
 *                    the given name is the preferred one — and filling it from
 *                    the given name is the exact guess that put a surname in a
 *                    "Preferred Name" box during the first live run.
 *   `education`      has no re-spelling. "Master's degree" → "MSc" → "VŠ" are
 *                    claims about equivalence between education systems, not
 *                    about typography; the settings page offers one closed
 *                    ladder so the stored string is already the canonical one.
 *   `nationality`,   are single facts with no second form: "Czech" is not
 *   `state`,         "Czechia", a `kraj` has no code, and abbreviating a licence
 *   `drivingLicence` category or a language would be a translation, not a
 *   `preferredLanguage`  spelling.
 */

/** The profile fields the derivations are computed from. */
export interface SourceAtoms {
  firstName: string;
  middleName: string;
  lastName: string;
  phone: string;
  city: string;
  postalCode: string;
  country: string;
  linkedin: string;
  github: string;
  website: string;
  salary: string;
  dateOfBirth: string;
  yearsOfExperience: string;
}

/**
 * Placeholder names that are computed rather than stored. Kept separate from
 * `PROFILE_VALUE_KEYS` on purpose: that list is what the LLM prompt offers the
 * model, and it should stay a description of the *profile*. These are
 * refinements the deterministic variant table reaches for.
 */
export const DERIVED_VALUE_KEYS = [
  /** Given name — split out of a single "Dias Nurgaliyev" box when needed. */
  'givenName',
  /** Surname — likewise. */
  'familyName',
  'firstInitial',
  'lastInitial',
  /** `M` — for the "Middle initial" box, which is usually `maxlength="1"`. */
  'middleInitial',
  /** `+420` — for forms with a separate dial-code field. */
  'phoneCountryCode',
  /** `123456789` — the subscriber number, no country code. */
  'phoneNational',
  /** `420123456789` — every digit, no `+` (numeric inputs reject one). */
  'phoneDigits',
  /** `+420 123 456 789` — grouped, for forms whose placeholder shows groups. */
  'phoneSpaced',
  'linkedinUrl',
  /** `dias-nur` — the handle many ATS ask for instead of the URL. */
  'linkedinUser',
  'githubUrl',
  'githubUser',
  'websiteUrl',
  /** `dias.dev` — no scheme, no `www.` */
  'websiteHost',
  /** `Praha` out of a stored "Praha, Czechia". */
  'cityName',
  /** `16000` out of "160 00" — a postcode box that validates rejects the space. */
  'postalCodeCompact',
  /** `Czechia` — the full name, however the country was written down. */
  'countryName',
  /** `CZ` — ISO-3166 alpha-2, for a country box that wants the code. */
  'countryCode',
  /** `1990-03-15` — the canonical spelling `<input type="date">` insists on. */
  'dobIso',
  /** `15.03.1990` — how a Czech form writes the same date. */
  'dobDotted',
  /** `15` / `03` / `1990` — for the forms that ask in three boxes. */
  'dobDay',
  'dobMonth',
  'dobYear',
  /** `5` out of "5+ years" — for `<input type="number">`. */
  'experienceYears',
  /** `80000` out of "80 000 Kč" — for `<input type="number">`. */
  'salaryNumber',
] as const;

export type DerivedValueKey = (typeof DERIVED_VALUE_KEYS)[number];

// ─── Names ───────────────────────────────────────────────────────────────────

/**
 * Given name and surname, whatever boxes they were typed into. Normally a
 * pass-through, since settings has two fields — but people type "Dias
 * Nurgaliyev" into the first and leave the second empty, and a form asking for a
 * surname would then get nothing while the answer sat one field away. When
 * exactly one box holds a value of more than one word, the last word is read as
 * the surname.
 *
 * A single word is never split: "Dias" is a given name in the given-name box and
 * a surname in the surname box, and inventing the other half is exactly what
 * this layer must not do.
 */
function splitName(first: string, last: string): [string, string] {
  const given = first.trim();
  const family = last.trim();
  if (given && family) return [given, family];

  const combined = given || family;
  const words = combined.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [given, family];

  return [words.slice(0, -1).join(' '), words[words.length - 1]];
}

function initialOf(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

// ─── Phone ───────────────────────────────────────────────────────────────────

/**
 * ITU country calling codes, longest match first.
 *
 * E.164 does not mark where the country code ends, so splitting `+420123456789`
 * needs the list. Calling codes are a prefix-free set — no code is the start of
 * another — which is what makes "try three digits, then two, then one" correct
 * as long as every entry really is a code.
 *
 * The list is not exhaustive (there are ~240). It covers Europe, where the
 * extension is used, plus the large markets. An unlisted code simply means no
 * split happens: the number is still filled in E.164, which is what the field
 * would have received before.
 */
const DIAL_CODES = new Set(
  (
    '1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 54 55 56 57 58 60 61 62 63 ' +
    '64 65 66 81 82 84 86 90 91 92 93 94 95 98 212 213 216 218 233 234 351 352 353 354 355 356 ' +
    '357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 421 423 ' +
    '852 853 855 856 880 886 962 964 965 966 968 971 972 973 974 977 992 993 994 995 996 998'
  ).split(' '),
);

interface PhoneParts {
  countryCode: string;
  national: string;
  digits: string;
  spaced: string;
}

/** `123456789` → `123 456 789`. Only regular groupings; never a ragged tail. */
function group(digits: string): string {
  for (const size of [3, 4]) {
    if (digits.length > size && digits.length % size === 0) {
      const chunks: string[] = [];
      for (let i = 0; i < digits.length; i += size) chunks.push(digits.slice(i, i + size));
      return chunks.join(' ');
    }
  }
  return digits;
}

function splitPhone(phone: string): PhoneParts {
  const raw = phone.trim();
  const allDigits = raw.replace(/\D/g, '');
  if (!allDigits) return { countryCode: '', national: '', digits: '', spaced: '' };

  // Only an internationally written number can be split. `123456789` on its own
  // has no country code to remove, and guessing one would invent a fact.
  const international = raw.startsWith('+') || raw.startsWith('00');
  const body = raw.startsWith('00') ? allDigits.slice(2) : allDigits;

  let countryCode = '';
  let national = body;
  if (international) {
    for (const size of [3, 2, 1]) {
      const candidate = body.slice(0, size);
      if (body.length > size && DIAL_CODES.has(candidate)) {
        countryCode = `+${candidate}`;
        national = body.slice(size);
        break;
      }
    }
  }

  const grouped = group(national);
  return {
    countryCode,
    national,
    digits: body,
    spaced: countryCode ? `${countryCode} ${grouped}` : grouped,
  };
}

// ─── Links ───────────────────────────────────────────────────────────────────

const SCHEME = /^https?:\/\//i;
/** `linkedin.com/in/x`, `ada.dev` — a hostname, with or without a path. */
const HOSTISH = /^[\w-]+(?:\.[\w-]+)+(?:[/?#]|$)/;

/**
 * The value as an absolute URL, or `''` when it cannot be one.
 *
 * `base` is the profile prefix a bare handle belongs to
 * (`https://www.linkedin.com/in/`). Expanding `dias-nur` with it is a
 * re-spelling, not a guess: the value came out of the LinkedIn box, so what it
 * identifies is already known. A value with no base and no hostname
 * ("my portfolio") yields `''` — better an empty field than a broken URL in one
 * that validates them.
 */
function toUrl(value: string, base: string): string {
  const v = value.trim();
  if (!v) return '';
  if (SCHEME.test(v)) return v;
  if (HOSTISH.test(v)) return `https://${v}`;
  return base ? base + v.replace(/^@/, '') : '';
}

/** Last path segment: `https://linkedin.com/in/dias-nur/` → `dias-nur`. */
function userOf(value: string): string {
  const path = value
    .trim()
    .replace(SCHEME, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1).replace(/^@/, '');
}

/** `https://www.dias.dev/cv` → `dias.dev`. */
function hostOf(value: string): string {
  return value
    .trim()
    .replace(SCHEME, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '');
}

// ─── Country ─────────────────────────────────────────────────────────────────

/**
 * ISO-3166 alpha-2 for the countries this extension is realistically used from
 * and applied to, with the aliases people actually type.
 *
 * `CODE:Canonical name:alias:alias|…` — an alias is another *spelling of the
 * same country*, never a country that merely overlaps one, which is why
 * "England" is absent and "Great Britain" is present.
 *
 * Not the full 249 entries, for the same reason `DIAL_CODES` is not: an
 * unlisted country simply derives no code, and `{country}` still fills in
 * whatever the user wrote. Expanding `CZ` into `Czechia` is a re-spelling of a
 * fact the profile already states; producing `KZ` from a name that is not in
 * this table would be a guess, and this module does not guess.
 */
const COUNTRY_TABLE =
  'CZ:Czechia:czech republic:cesko:ceska republika|SK:Slovakia:slovensko|' +
  'AT:Austria:osterreich|DE:Germany:deutschland:nemecko|PL:Poland:polska|' +
  'HU:Hungary:magyarorszag|SI:Slovenia|HR:Croatia|RO:Romania|BG:Bulgaria|' +
  'GR:Greece|IT:Italy:italia|ES:Spain:espana|PT:Portugal|FR:France|' +
  'BE:Belgium|NL:Netherlands:the netherlands:holland|LU:Luxembourg|' +
  'IE:Ireland|GB:United Kingdom:uk:great britain:britain|' +
  'DK:Denmark|SE:Sweden:sverige|NO:Norway|FI:Finland|IS:Iceland|' +
  'EE:Estonia|LV:Latvia|LT:Lithuania|CH:Switzerland|LI:Liechtenstein|' +
  'MT:Malta|CY:Cyprus|UA:Ukraine|MD:Moldova|BY:Belarus|RS:Serbia|' +
  'BA:Bosnia and Herzegovina|ME:Montenegro|MK:North Macedonia|AL:Albania|' +
  'TR:Turkey:turkiye|RU:Russia|GE:Georgia|AM:Armenia|AZ:Azerbaijan|' +
  'KZ:Kazakhstan|UZ:Uzbekistan|KG:Kyrgyzstan|' +
  'US:United States:usa:united states of america|CA:Canada|MX:Mexico|' +
  'BR:Brazil|AR:Argentina|AU:Australia|NZ:New Zealand|' +
  'IN:India|CN:China|JP:Japan|KR:South Korea|SG:Singapore|MY:Malaysia|' +
  'ID:Indonesia|TH:Thailand|VN:Vietnam|PH:Philippines|PK:Pakistan|' +
  'BD:Bangladesh|LK:Sri Lanka|NP:Nepal|IL:Israel|AE:United Arab Emirates:uae|' +
  'SA:Saudi Arabia|EG:Egypt|ZA:South Africa|NG:Nigeria|KE:Kenya|MA:Morocco';

interface CountryParts {
  name: string;
  code: string;
}

/** Every written form of a country — its code, its name, its aliases — keyed. */
const COUNTRIES = new Map<string, CountryParts>();

for (const row of COUNTRY_TABLE.split('|')) {
  const [code, name, ...aliases] = row.split(':');
  for (const written of [code, name, ...aliases]) COUNTRIES.set(foldCase(written), { name, code });
}

/** Lower case, no diacritics, single spaces — how a written country is keyed. */
function foldCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * The country as a full name and as a code.
 *
 * A written form that is not in the table is *not* an error: the name comes back
 * as typed (it is already a name), and the code comes back empty rather than
 * abbreviated by guesswork. A bare two-letter token is read as a code — that is
 * what it is, in a box labelled "Country" — and is upper-cased rather than
 * expanded when the table does not know it.
 */
function splitCountry(country: string): CountryParts {
  const raw = country.trim().replace(/\s+/g, ' ');
  if (!raw) return { name: '', code: '' };

  const folded = foldCase(raw);
  const known = COUNTRIES.get(folded);
  if (known) return known;

  // Two letters in a box labelled "Country" are a code, whether or not the
  // table has heard of it — but they are not a name we can write out.
  if (/^[a-z]{2}$/.test(folded)) return { name: '', code: folded.toUpperCase() };

  return { name: raw, code: '' };
}

// ─── Date of birth ───────────────────────────────────────────────────────────

/** `1990-03-15` — what `<input type="date">` in settings stores. */
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
/** `15.03.1990`, `15/03/1990` — what an imported or hand-edited profile may hold. */
const WRITTEN_DATE = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/;

interface DateParts {
  iso: string;
  dotted: string;
  day: string;
  month: string;
  year: string;
}

const NO_DATE: DateParts = { iso: '', dotted: '', day: '', month: '', year: '' };

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A date of birth in the spellings forms ask for, or nothing at all.
 *
 * Nothing at all is the answer for anything that is not unambiguously a date:
 * a half-typed value, a two-digit year, `03/15/1990` written the American way
 * round. Reading `03/15` as the fifteenth of March is only *probably* right, and
 * a date of birth that is probably right is a wrong date of birth on an
 * application form. Day and month are zero-padded, so the three-box spelling
 * matches the two full ones and satisfies a `pattern="[0-9]{2}"`.
 */
function splitDate(value: string): DateParts {
  const raw = value.trim();
  if (!raw) return NO_DATE;

  const iso = ISO_DATE.exec(raw);
  const written = WRITTEN_DATE.exec(raw);
  let y: string, m: string, d: string;
  if (iso) [, y, m, d] = iso;
  else if (written) [, d, m, y] = written;
  else return NO_DATE;

  const day = Number(d);
  const month = Number(m);
  const year = Number(y);
  // A day the calendar does not have is a typo, not a fact to re-spell.
  if (month < 1 || month > 12) return NO_DATE;
  if (day < 1 || day > new Date(year, month, 0).getDate()) return NO_DATE;

  return {
    iso: `${y}-${pad(month)}-${pad(day)}`,
    dotted: `${pad(day)}.${pad(month)}.${y}`,
    day: pad(day),
    month: pad(month),
    year: y,
  };
}

// ─── Money ───────────────────────────────────────────────────────────────────

/**
 * The number out of a written amount: `80 000 Kč` → `80000`, `3,500 EUR` → `3500`.
 *
 * `\s` covers the non-breaking space Czech amounts are typed with. Separators
 * are removed only where they group thousands (three digits behind
 * them); a decimal comma or point survives as a point, because `1500.50` is a
 * different amount from `150050`.
 */
function numberOf(text: string): string {
  const found = /\d[\d\s.,']*\d|\d/.exec(text);
  if (!found) return '';
  return found[0]
    .replace(/[\s']/g, '')
    .replace(/[.,](?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
}

// ─── ─────────────────────────────────────────────────────────────────────────

const LINKEDIN_BASE = 'https://www.linkedin.com/in/';
const GITHUB_BASE = 'https://github.com/';

/** Every derived atom, computed from what the profile holds. */
export function deriveAtoms(src: SourceAtoms): Record<DerivedValueKey, string> {
  const [givenName, familyName] = splitName(src.firstName, src.lastName);
  const phone = splitPhone(src.phone);
  const city = src.city.trim();
  const comma = city.indexOf(',');
  const country = splitCountry(src.country);
  const dob = splitDate(src.dateOfBirth);

  return {
    givenName,
    familyName,
    firstInitial: initialOf(givenName),
    lastInitial: initialOf(familyName),
    middleInitial: initialOf(src.middleName.trim()),
    phoneCountryCode: phone.countryCode,
    phoneNational: phone.national,
    phoneDigits: phone.digits,
    phoneSpaced: phone.spaced,
    linkedinUrl: toUrl(src.linkedin, LINKEDIN_BASE),
    linkedinUser: userOf(src.linkedin),
    githubUrl: toUrl(src.github, GITHUB_BASE),
    githubUser: userOf(src.github),
    websiteUrl: toUrl(src.website, ''),
    websiteHost: hostOf(src.website),
    cityName: comma === -1 ? city : city.slice(0, comma).trim(),
    postalCodeCompact: src.postalCode.replace(/\s+/g, ''),
    countryName: country.name,
    countryCode: country.code,
    dobIso: dob.iso,
    dobDotted: dob.dotted,
    dobDay: dob.day,
    dobMonth: dob.month,
    dobYear: dob.year,
    experienceYears: numberOf(src.yearsOfExperience),
    salaryNumber: numberOf(src.salary),
  };
}
