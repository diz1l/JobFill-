import { describe, it, expect, afterEach } from 'vitest';
import { deriveAtoms, DERIVED_VALUE_KEYS } from '../shared/filler/atoms';
import {
  ANY_SHAPE,
  describeField,
  isNumericControl,
  normalizeText,
  patternAllowsPlus,
  patternDigitLimit,
  says,
  type FieldShape,
} from '../shared/filler/fieldShape';
import { nameOrder, VARIANTS } from '../shared/filler/templateVariants';
import {
  DEFAULT_TEMPLATES,
  PROFILE_VALUE_KEYS,
  TEMPLATE_VALUE_KEYS,
  isProfileValueKey,
  isTemplateValueKey,
  resolveAnswer,
  resolveFieldType,
  resolveTemplate,
  selectTemplate,
  type ValueContext,
} from '../shared/filler/valueTemplate';
import { fillPage } from '../shared/filler/index';
import { removeAllHighlights } from '../shared/filler/highlight';
import { forgetCoverTargets } from '../shared/filler/coverTarget';
import { buildFingerprint } from '../shared/field-matcher/fingerprint';
import { createEmptyProfile, type Profile } from '../shared/types';

/**
 * The profile the whole file composes from: name atoms, a phone in E.164, a
 * LinkedIn URL, a salary with a currency in it, a date of birth in ISO — every
 * case below is the same set of facts, re-spelled for the form that is asking.
 *
 * Every entry is filled, which one test below depends on: "every name in the
 * vocabulary resolves to something" is what stops a placeholder being added to
 * the list the model is shown without anything behind it.
 */
const PROFILE: Profile = createEmptyProfile({
  firstName: 'Dias',
  middleName: 'Serik',
  lastName: 'Nurgaliyev',
  preferredName: 'Dee',
  nameSuffix: 'Jr.',
  email: 'dias@example.com',
  phone: '+420123456789',
  city: 'Praha, Czechia',
  linkedin: 'https://www.linkedin.com/in/dias-nur',
  github: 'github.com/diz1l',
  website: 'dias.dev',
  addressLine1: 'Vinohradská 1511/230',
  addressLine2: 'byt 4',
  state: 'Hlavní město Praha',
  postalCode: '100 00',
  country: 'Czechia',
  nationality: 'Kazakhstani',
  dateOfBirth: '1990-03-15',
  workPermit: 'EU citizen',
  education: "Master's degree",
  drivingLicence: 'B',
  preferredLanguage: 'English',
  currentTitle: 'Frontend Engineer',
  currentEmployer: 'Acme s.r.o.',
  yearsOfExperience: '5+',
  salaryExpectation: '80 000 Kč',
  availability: '1 September',
  about: 'I build things that work.',
});

function ctxOf(overrides: Partial<Profile> = {}, coverLetter?: string): ValueContext {
  return { profile: { ...PROFILE, ...overrides }, coverLetter };
}

function shape(overrides: Partial<FieldShape> = {}): FieldShape {
  return { ...ANY_SHAPE, ...overrides };
}

/** Render one control and describe it exactly the way `fillPage` does. */
function shapeOf(html: string): FieldShape {
  document.body.innerHTML = `<form>${html}</form>`;
  const el = document.querySelector('input,textarea,select') as HTMLInputElement;
  return describeField(buildFingerprint(el));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('derived atoms', () => {
  const derived = (overrides: Partial<Profile> = {}) => {
    const p = { ...PROFILE, ...overrides };
    return deriveAtoms({
      firstName: p.firstName,
      middleName: p.middleName,
      lastName: p.lastName,
      phone: p.phone,
      city: p.city,
      postalCode: p.postalCode,
      country: p.country,
      linkedin: p.linkedin,
      github: p.github,
      website: p.website,
      salary: p.salaryExpectation,
      dateOfBirth: p.dateOfBirth,
      yearsOfExperience: p.yearsOfExperience,
    });
  };

  it('passes the two name atoms through when both are filled', () => {
    expect(derived()).toMatchObject({
      givenName: 'Dias',
      familyName: 'Nurgaliyev',
      firstInitial: 'D',
      lastInitial: 'N',
    });
  });

  /**
   * The inverse of the composition case: the whole name typed into one settings
   * box, and a form that asks for the halves separately.
   */
  it('splits a whole name out of whichever single box holds it', () => {
    expect(derived({ firstName: 'Dias Nurgaliyev', lastName: '' })).toMatchObject({
      givenName: 'Dias',
      familyName: 'Nurgaliyev',
    });
    expect(derived({ firstName: '', lastName: 'Dias Nurgaliyev' })).toMatchObject({
      givenName: 'Dias',
      familyName: 'Nurgaliyev',
    });
  });

  it('keeps a multi-word given name together', () => {
    expect(derived({ firstName: 'Jean Paul Charles', lastName: '' })).toMatchObject({
      givenName: 'Jean Paul',
      familyName: 'Charles',
    });
  });

  it('never invents the half that is not there', () => {
    expect(derived({ firstName: 'Dias', lastName: '' })).toMatchObject({
      givenName: 'Dias',
      familyName: '',
      lastInitial: '',
    });
    expect(derived({ firstName: '', lastName: '' })).toMatchObject({
      givenName: '',
      familyName: '',
      firstInitial: '',
    });
  });

  it('splits an E.164 phone into country code and subscriber number', () => {
    expect(derived()).toMatchObject({
      phoneCountryCode: '+420',
      phoneNational: '123456789',
      phoneDigits: '420123456789',
      phoneSpaced: '+420 123 456 789',
    });
  });

  it('reads a two-digit and a one-digit country code', () => {
    expect(derived({ phone: '+442079460958' })).toMatchObject({
      phoneCountryCode: '+44',
      phoneNational: '2079460958',
    });
    expect(derived({ phone: '+14155550123' })).toMatchObject({
      phoneCountryCode: '+1',
      phoneNational: '4155550123',
      // 10 digits group neither by three nor by four — left alone rather than
      // grouped raggedly.
      phoneSpaced: '+1 4155550123',
    });
  });

  it('understands the 00 prefix as well as +', () => {
    expect(derived({ phone: '00420123456789' })).toMatchObject({
      phoneCountryCode: '+420',
      phoneNational: '123456789',
    });
  });

  it('leaves a national number alone — there is no country code to remove', () => {
    expect(derived({ phone: '123456789' })).toMatchObject({
      phoneCountryCode: '',
      phoneNational: '123456789',
      phoneDigits: '123456789',
    });
  });

  it('groups an eight-digit number in fours', () => {
    expect(derived({ phone: '12345678' })).toMatchObject({ phoneSpaced: '1234 5678' });
  });

  it('does not guess an unlisted country code', () => {
    expect(derived({ phone: '+999123456789' })).toMatchObject({
      phoneCountryCode: '',
      phoneDigits: '999123456789',
    });
  });

  it('a phone that is not there derives nothing', () => {
    expect(derived({ phone: '' })).toMatchObject({
      phoneCountryCode: '',
      phoneNational: '',
      phoneDigits: '',
      phoneSpaced: '',
    });
  });

  it('reads the handle out of a profile URL, and leaves a bare handle alone', () => {
    expect(derived().linkedinUser).toBe('dias-nur');
    expect(derived({ linkedin: 'https://linkedin.com/in/dias-nur/?trk=x' }).linkedinUser).toBe(
      'dias-nur',
    );
    expect(derived({ linkedin: '@dias-nur' }).linkedinUser).toBe('dias-nur');
    expect(derived({ github: 'diz1l' }).githubUser).toBe('diz1l');
  });

  it('expands a bare handle into the URL its own field implies', () => {
    expect(derived({ linkedin: 'dias-nur' }).linkedinUrl).toBe(
      'https://www.linkedin.com/in/dias-nur',
    );
    expect(derived({ github: '@diz1l' }).githubUrl).toBe('https://github.com/diz1l');
  });

  it('adds the scheme a hostname is missing', () => {
    expect(derived().githubUrl).toBe('https://github.com/diz1l');
    expect(derived().websiteUrl).toBe('https://dias.dev');
    expect(derived({ website: 'https://dias.dev' }).websiteUrl).toBe('https://dias.dev');
  });

  it('refuses to build a URL out of something that is not one', () => {
    expect(derived({ website: 'my portfolio' }).websiteUrl).toBe('');
    expect(derived({ website: '' }).websiteUrl).toBe('');
  });

  it('strips scheme, www and path down to the host', () => {
    expect(derived({ website: 'https://www.dias.dev/cv?lang=cs' }).websiteHost).toBe('dias.dev');
    expect(derived().websiteHost).toBe('dias.dev');
  });

  it('takes the city out of a stored "city, country"', () => {
    expect(derived().cityName).toBe('Praha');
    expect(derived({ city: 'Praha' }).cityName).toBe('Praha');
    expect(derived({ city: '' }).cityName).toBe('');
  });

  it('takes the initial of a middle name, and nothing from an empty one', () => {
    expect(derived().middleInitial).toBe('S');
    expect(derived({ middleName: '' }).middleInitial).toBe('');
    expect(derived({ middleName: '  serik ' }).middleInitial).toBe('S');
  });

  /**
   * The rule the "Preferred Name got the surname" incident is about, written as
   * a test: there is no derivation from the given name to the preferred one, in
   * either direction, and an unfilled entry stays unfilled.
   */
  it('never fills a preferred name from the given name', () => {
    expect(Object.keys(derived())).not.toContain('preferredName');
    expect(resolveTemplate('{preferredName}', ctxOf({ preferredName: '' }))).toBe('');
    expect(resolveTemplate('{preferredName}', ctxOf())).toBe('Dee');
  });

  it('closes up a postcode written with a space', () => {
    expect(derived().postalCodeCompact).toBe('10000');
    expect(derived({ postalCode: 'SW1A 1AA' }).postalCodeCompact).toBe('SW1A1AA');
    expect(derived({ postalCode: '' }).postalCodeCompact).toBe('');
  });

  it('reads a country as both a name and a code, whichever was written', () => {
    expect(derived()).toMatchObject({ countryName: 'Czechia', countryCode: 'CZ' });
    expect(derived({ country: 'CZ' })).toMatchObject({ countryName: 'Czechia', countryCode: 'CZ' });
    expect(derived({ country: 'cz' })).toMatchObject({ countryName: 'Czechia', countryCode: 'CZ' });
    // Aliases, diacritics and spacing are all the same country.
    expect(derived({ country: 'Czech Republic' }).countryCode).toBe('CZ');
    expect(derived({ country: 'Česká republika' }).countryCode).toBe('CZ');
    expect(derived({ country: '  united  kingdom ' })).toMatchObject({
      countryName: 'United Kingdom',
      countryCode: 'GB',
    });
    expect(derived({ country: 'USA' }).countryName).toBe('United States');
  });

  /** An unlisted country is still a country — but it is not given a code. */
  it('leaves an unlisted country as written and invents no code for it', () => {
    expect(derived({ country: 'Wakanda' })).toMatchObject({
      countryName: 'Wakanda',
      countryCode: '',
    });
    // A bare two-letter token in a country box *is* a code, so it is kept as
    // one — but it is not expanded into a name we do not have.
    expect(derived({ country: 'xy' })).toMatchObject({ countryName: '', countryCode: 'XY' });
    expect(derived({ country: '' })).toMatchObject({ countryName: '', countryCode: '' });
  });

  it('spells a date of birth every way a form asks for it', () => {
    expect(derived()).toMatchObject({
      dobIso: '1990-03-15',
      dobDotted: '15.03.1990',
      dobDay: '15',
      dobMonth: '03',
      dobYear: '1990',
    });
    // A hand-edited or imported profile may hold the Czech spelling instead.
    expect(derived({ dateOfBirth: '5.3.1990' })).toMatchObject({
      dobIso: '1990-03-05',
      dobDotted: '05.03.1990',
      dobDay: '05',
    });
    expect(derived({ dateOfBirth: '15/03/1990' }).dobIso).toBe('1990-03-15');
  });

  /**
   * A date of birth that is only probably right is a wrong date of birth: the
   * ambiguous and the impossible both derive nothing rather than a plausible
   * reading.
   */
  it('derives nothing from a date it cannot read for certain', () => {
    for (const dateOfBirth of ['', '1990', '15.03.90', '03/15/1990', '1990-13-01', '1990-02-30', 'yesterday']) {
      expect(derived({ dateOfBirth })).toMatchObject({
        dobIso: '',
        dobDotted: '',
        dobDay: '',
        dobMonth: '',
        dobYear: '',
      });
    }
    // …and a leap day that does exist is not thrown away with them.
    expect(derived({ dateOfBirth: '1992-02-29' }).dobDotted).toBe('29.02.1992');
  });

  it('takes the number of years out of however they were written', () => {
    expect(derived().experienceYears).toBe('5');
    expect(derived({ yearsOfExperience: '5 years' }).experienceYears).toBe('5');
    expect(derived({ yearsOfExperience: 'over 10' }).experienceYears).toBe('10');
    expect(derived({ yearsOfExperience: '' }).experienceYears).toBe('');
    expect(derived({ yearsOfExperience: 'several' }).experienceYears).toBe('');
  });

  it('takes the number out of a written amount', () => {
    expect(derived().salaryNumber).toBe('80000');
    expect(derived({ salaryExpectation: '80000 CZK' }).salaryNumber).toBe('80000');
    expect(derived({ salaryExpectation: '3,500 EUR / month' }).salaryNumber).toBe('3500');
    expect(derived({ salaryExpectation: '1500.50' }).salaryNumber).toBe('1500.50');
    expect(derived({ salaryExpectation: '1.234.567 Kč' }).salaryNumber).toBe('1234567');
    expect(derived({ salaryExpectation: '5' }).salaryNumber).toBe('5');
    expect(derived({ salaryExpectation: 'negotiable' }).salaryNumber).toBe('');
  });
});

describe('describeField', () => {
  it('normalizes case and diacritics and keeps the sources apart', () => {
    expect(normalizeText('  Příjmení   a Jméno ')).toBe('prijmeni a jmeno');
    const s = shapeOf('<label for="n">Příjmení a jméno</label><input id="n" name="cele_jmeno" />');
    expect(s.text).toContain('prijmeni a jmeno');
    expect(s.text).toContain('|');
  });

  it('reads the constraints the page states', () => {
    const s = shapeOf(
      '<input id="p" name="phone" type="tel" maxlength="9" pattern="[0-9]{9}" inputmode="TEL" placeholder="123 456 789" />',
    );
    expect(s).toMatchObject({
      maxLength: 9,
      pattern: '[0-9]{9}',
      inputMode: 'tel',
      controlType: 'tel',
      placeholder: '123 456 789',
      multiline: false,
    });
  });

  it('treats an absent, unparsable or negative maxlength as no constraint', () => {
    expect(shapeOf('<input id="a" />').maxLength).toBe(0);
    expect(shapeOf('<input id="a" maxlength="abc" />').maxLength).toBe(0);
    expect(shapeOf('<input id="a" maxlength="-1" />').maxLength).toBe(0);
  });

  it('knows a textarea holds prose', () => {
    expect(shapeOf('<textarea id="t" name="about"></textarea>').multiline).toBe(true);
  });

  it('works on a description with no element and no sources at all', () => {
    expect(describeField({})).toEqual(ANY_SHAPE);
    expect(describeField({ labelText: 'Full name' }).text).toBe('full name');
  });

  it('falls back to the element for a placeholder the description omits', () => {
    document.body.innerHTML = '<input id="p" placeholder="+420 123 456 789" />';
    const el = document.getElementById('p') as HTMLInputElement;
    expect(describeField({ element: el }).placeholder).toBe('+420 123 456 789');
  });
});

describe('reading a pattern', () => {
  it('finds the digit limit, or says it does not know', () => {
    expect(patternDigitLimit('[0-9]{9}')).toBe(9);
    expect(patternDigitLimit('^\\d{9,12}$')).toBe(12);
    expect(patternDigitLimit('[\\d]{8}')).toBe(8);
    expect(patternDigitLimit('[A-Za-z ]+')).toBe(0);
    expect(patternDigitLimit('')).toBe(0);
  });

  it('tells a literal plus from a quantifier', () => {
    expect(patternAllowsPlus('\\+?[0-9]{9,12}')).toBe(true);
    expect(patternAllowsPlus('[+0-9]{9,13}')).toBe(true);
    expect(patternAllowsPlus('[0-9]{9}')).toBe(false);
    expect(patternAllowsPlus('[0-9]+')).toBe(false);
  });

  it('recognises a control that can only hold digits', () => {
    expect(isNumericControl(shape({ controlType: 'number' }))).toBe(true);
    expect(isNumericControl(shape({ inputMode: 'numeric' }))).toBe(true);
    expect(isNumericControl(shape({ inputMode: 'decimal' }))).toBe(true);
    expect(isNumericControl(shape({ pattern: '[0-9]{9}' }))).toBe(true);
    // A pattern that admits `+` is not a digits-only control.
    expect(isNumericControl(shape({ pattern: '\\+?[0-9]{9,12}' }))).toBe(false);
    expect(isNumericControl(shape({ controlType: 'tel' }))).toBe(false);
  });

  it('says() looks at everything readable about the field', () => {
    expect(says(shape({ text: 'a | country code | b' }), /country[\s._-]?code/)).toBe(true);
    expect(says(shape({ text: 'phone' }), /country[\s._-]?code/)).toBe(false);
  });
});

describe('nameOrder', () => {
  it('reads the order out of the source that names both halves', () => {
    expect(nameOrder('jmeno a prijmeni')).toEqual({ surnameFirst: false, comma: false });
    expect(nameOrder('prijmeni a jmeno')).toEqual({ surnameFirst: true, comma: false });
    expect(nameOrder('prijmeni, jmeno')).toEqual({ surnameFirst: true, comma: true });
    expect(nameOrder('surname and first name')).toEqual({ surnameFirst: true, comma: false });
  });

  it('ignores sources that name only one half', () => {
    expect(nameOrder('prijmeni | full_name | your name')).toEqual({
      surnameFirst: false,
      comma: false,
    });
  });

  it('does not read an order across two sources', () => {
    expect(nameOrder('prijmeni | jmeno')).toEqual({ surnameFirst: false, comma: false });
  });
});

describe('resolveTemplate', () => {
  it('joins atoms into whatever shape the template describes', () => {
    expect(resolveTemplate('{firstName} {lastName}', ctxOf())).toBe('Dias Nurgaliyev');
    expect(resolveTemplate('{lastName}, {firstName}', ctxOf())).toBe('Nurgaliyev, Dias');
    expect(resolveTemplate('{firstName}', ctxOf())).toBe('Dias');
  });

  it('accepts a derived name as readily as a stored one', () => {
    expect(resolveTemplate('{givenName} {familyName}', ctxOf())).toBe('Dias Nurgaliyev');
    expect(resolveTemplate('{phoneNational}', ctxOf())).toBe('123456789');
  });

  it('is empty for an empty template', () => {
    expect(resolveTemplate('', ctxOf())).toBe('');
  });

  /** A model naming a field the profile does not have is answering another question. */
  it('writes nothing at all when a key does not exist', () => {
    expect(resolveTemplate('{firstName} {maidenName}', ctxOf())).toBe('');
  });

  it('resolves to the part that exists, without a dangling separator', () => {
    expect(resolveTemplate('{firstName} {lastName}', ctxOf({ lastName: '' }))).toBe('Dias');
    expect(resolveTemplate('{lastName}, {firstName}', ctxOf({ lastName: '' }))).toBe('Dias');
    expect(resolveTemplate('{linkedin} / {github}', ctxOf({ github: '' }))).toBe(
      'https://www.linkedin.com/in/dias-nur',
    );
  });

  /**
   * A composition that lost *every* atom is punctuation, not an answer: "+420 "
   * in a phone box is a stub an employer cannot tell from a typo.
   */
  it('writes nothing when every atom the template asked for is missing', () => {
    expect(resolveTemplate('{firstName} {lastName}', ctxOf({ firstName: '', lastName: '' }))).toBe(
      '',
    );
    expect(resolveTemplate('+420 {phoneNational}', ctxOf({ phone: '' }))).toBe('');
    expect(resolveTemplate('{city}, {country}', ctxOf({ city: '', country: '' }))).toBe('');
  });

  it('a template with no placeholders is literal text and survives', () => {
    expect(resolveTemplate('N/A', ctxOf())).toBe('N/A');
  });

  /**
   * The protection prose depends on: a cover letter is a template too. Blank
   * lines, the comma after "Dobrý den," and the trailing signature are the
   * letter, not separators left over from substitution.
   */
  it('never reformats multi-line text it did not have to repair', () => {
    const letter = 'Dobrý den,\n\nrád bych se ucházel o pozici.\n\n  S pozdravem,\n  Dias\n';
    expect(resolveTemplate('{coverLetter}', ctxOf({}, letter))).toBe(letter);
    expect(resolveTemplate(letter, ctxOf())).toBe(letter);
  });

  it('repairs a gap inside its own line, leaving the other lines standing', () => {
    const template = '{firstName} {lastName}\n{email}\n{city} — {phone}';
    expect(resolveTemplate(template, ctxOf({ city: '' }))).toBe(
      'Dias Nurgaliyev\ndias@example.com\n+420123456789',
    );
  });
});

describe('the placeholder vocabulary', () => {
  it('keeps the stored atoms and the computed ones apart', () => {
    expect(isProfileValueKey('firstName')).toBe(true);
    expect(isProfileValueKey('givenName')).toBe(false);
    expect(isTemplateValueKey('givenName')).toBe(true);
    expect(isTemplateValueKey('firstName')).toBe(true);
    expect(isTemplateValueKey('maidenName')).toBe(false);
  });

  it('every name in the vocabulary resolves to something', () => {
    for (const key of TEMPLATE_VALUE_KEYS) {
      expect(resolveTemplate(`{${key}}`, ctxOf({}, 'a letter'))).not.toBe('');
    }
    expect(TEMPLATE_VALUE_KEYS).toHaveLength(PROFILE_VALUE_KEYS.length + DERIVED_VALUE_KEYS.length);
  });

  /**
   * The list the model is shown has to *be* the profile. A profile entry with
   * no name in it is an answer the extension holds and never offers; a name
   * with no entry behind it is an atom the model can compose from and the page
   * cannot resolve. The second is how "Preferred Name" came to be answered with
   * a surname, so both directions are checked here rather than by inspection.
   */
  it('offers exactly one name per profile entry', () => {
    const stored = Object.keys(createEmptyProfile())
      .filter((key) => key !== 'id' && key !== 'label')
      // The one deliberate rename: the settings box is a salary *expectation*,
      // the placeholder a form would ask for is `{salary}`.
      .map((key) => (key === 'salaryExpectation' ? 'salary' : key));
    const offered = PROFILE_VALUE_KEYS.filter((key) => key !== 'coverLetter');

    expect([...offered].sort()).toEqual(stored.sort());
  });

  /** Every offered name is also a field type the filler knows how to answer. */
  it('resolves each of them as a field type too', () => {
    for (const key of PROFILE_VALUE_KEYS) {
      expect(DEFAULT_TEMPLATES[key]).toBeDefined();
      expect(resolveFieldType(key, ctxOf({}, 'a letter'))).not.toBe('');
    }
  });

  it('every default template is made of names that exist', () => {
    for (const template of Object.values(DEFAULT_TEMPLATES)) {
      for (const [, name] of template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)) {
        expect(isTemplateValueKey(name)).toBe(true);
      }
    }
  });

  it('every variant template is made of names that exist', () => {
    for (const variants of Object.values(VARIANTS)) {
      for (const variant of variants) {
        for (const [, name] of variant.template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)) {
          expect(isTemplateValueKey(name)).toBe(true);
        }
      }
    }
  });
});

describe('selectTemplate', () => {
  it('falls back to the type default when the field says nothing', () => {
    expect(selectTemplate('fullName', ctxOf())).toBe('{givenName} {familyName}');
    expect(selectTemplate('fullName', ctxOf(), ANY_SHAPE)).toBe('{givenName} {familyName}');
  });

  it('is empty for a field type that does not exist', () => {
    expect(selectTemplate('maidenName', ctxOf(), ANY_SHAPE)).toBe('');
    expect(resolveFieldType('maidenName', ctxOf())).toBe('');
  });

  it('leaves a type with no variants on its default', () => {
    expect(selectTemplate('email', ctxOf(), shape({ maxLength: 3 }))).toBe('{email}');
  });

  it('a fragment is only ever chosen when something asked for it by name', () => {
    // maxlength=4 fits "+420" and nothing else, and still does not get it.
    expect(selectTemplate('phone', ctxOf(), shape({ maxLength: 4 }))).toBe('{phone}');
    expect(selectTemplate('phone', ctxOf(), shape({ text: 'country code' }))).toBe(
      '{phoneCountryCode}',
    );
  });

  it('keeps the chosen spelling when nothing shorter fits either', () => {
    const s = shape({ maxLength: 5 });
    expect(selectTemplate('website', ctxOf({ website: 'my portfolio' }), s)).toBe('{website}');
  });

  it('prefers the fullest spelling that fits, not the first one', () => {
    // "Ada Lovelace" (12) does not fit 11; initials (2) and "A. Lovelace" (11) do.
    const ctx = ctxOf({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(selectTemplate('fullName', ctx, shape({ maxLength: 11 }))).toBe(
      '{firstInitial}. {familyName}',
    );
    // Asked for "Příjmení, jméno" (13) but given 12 → the default fits, initials
    // also fit and are not chosen: shorter is not better.
    expect(selectTemplate('fullName', ctx, shape({ text: 'prijmeni, jmeno', maxLength: 12 }))).toBe(
      '{givenName} {familyName}',
    );
  });
});

/**
 * The table the whole layer exists for. Each row is a control as an ATS really
 * writes it, the spelling selected for it, and what lands in the box. The test
 * title carries `what → template`, so a regression says *which* rule changed
 * rather than only that a string differs.
 */
const CASES: Array<{
  what: string;
  fieldType: string;
  html: string;
  template: string;
  value: string;
  profile?: Partial<Profile>;
}> = [
  // ── Name ──
  {
    what: 'Full name',
    fieldType: 'fullName',
    html: '<label for="f">Full name</label><input id="f" name="full_name" />',
    template: '{givenName} {familyName}',
    value: 'Dias Nurgaliyev',
  },
  {
    what: 'Jméno a příjmení',
    fieldType: 'fullName',
    html: '<label for="f">Jméno a příjmení</label><input id="f" name="jmeno_prijmeni" />',
    template: '{givenName} {familyName}',
    value: 'Dias Nurgaliyev',
  },
  {
    what: 'Příjmení a jméno (Czech forms really do ask in this order)',
    fieldType: 'fullName',
    html: '<label for="f">Příjmení a jméno</label><input id="f" name="cele_jmeno" />',
    template: '{familyName} {givenName}',
    value: 'Nurgaliyev Dias',
  },
  {
    what: 'Surname, first name',
    fieldType: 'fullName',
    html: '<label for="f">Surname, first name</label><input id="f" name="name" />',
    template: '{familyName}, {givenName}',
    value: 'Nurgaliyev, Dias',
  },
  {
    what: 'Initials',
    fieldType: 'fullName',
    html: '<label for="f">Initials</label><input id="f" name="initials" maxlength="4" />',
    template: '{firstInitial}{lastInitial}',
    value: 'DN',
  },
  {
    what: 'Full name in a box too short for it (maxlength=13)',
    fieldType: 'fullName',
    html: '<label for="f">Name</label><input id="f" name="name" maxlength="13" />',
    template: '{firstInitial}. {familyName}',
    value: 'D. Nurgaliyev',
  },
  {
    what: 'Full name in a box shorter still (maxlength=6)',
    fieldType: 'fullName',
    html: '<label for="f">Name</label><input id="f" name="name" maxlength="6" />',
    template: '{firstInitial}{lastInitial}',
    value: 'DN',
  },
  {
    what: 'Surname, with the whole name typed into the first settings box',
    fieldType: 'lastName',
    html: '<label for="f">Příjmení</label><input id="f" name="prijmeni" />',
    template: '{familyName}',
    value: 'Nurgaliyev',
    profile: { firstName: 'Dias Nurgaliyev', lastName: '' },
  },
  // ── Phone ──
  {
    what: 'Phone, unconstrained',
    fieldType: 'phone',
    html: '<label for="f">Phone</label><input id="f" name="phone" type="tel" />',
    template: '{phone}',
    value: '+420123456789',
  },
  {
    what: 'Phone with pattern="[0-9]{9}" — the country code is unwelcome',
    fieldType: 'phone',
    html: '<label for="f">Telefon</label><input id="f" name="telefon" type="tel" pattern="[0-9]{9}" />',
    template: '{phoneNational}',
    value: '123456789',
  },
  {
    what: 'Phone as <input type="number"> — a "+" would blank the field',
    fieldType: 'phone',
    html: '<label for="f">Phone</label><input id="f" name="phone" type="number" />',
    template: '{phoneDigits}',
    value: '420123456789',
  },
  {
    what: 'Phone with maxlength="9"',
    fieldType: 'phone',
    html: '<label for="f">Phone</label><input id="f" name="phone" maxlength="9" />',
    template: '{phoneNational}',
    value: '123456789',
  },
  {
    what: 'Phone whose placeholder demonstrates grouping',
    fieldType: 'phone',
    html: '<label for="f">Phone</label><input id="f" name="phone" placeholder="+420 123 456 789" />',
    template: '{phoneSpaced}',
    value: '+420 123 456 789',
  },
  {
    what: 'A separate "Country code" box next to the number',
    fieldType: 'phone',
    html: '<label for="f">Phone country code</label><input id="f" name="phone_country_code" />',
    template: '{phoneCountryCode}',
    value: '+420',
  },
  {
    what: 'Mobil (bez předvolby)',
    fieldType: 'phone',
    html: '<label for="f">Mobil (bez předvolby)</label><input id="f" name="mobil" />',
    template: '{phoneNational}',
    value: '123456789',
  },
  // ── Links ──
  {
    what: 'LinkedIn, unconstrained — whatever the user stored',
    fieldType: 'linkedin',
    html: '<label for="f">LinkedIn</label><input id="f" name="linkedin" />',
    template: '{linkedin}',
    value: 'https://www.linkedin.com/in/dias-nur',
  },
  {
    what: 'LinkedIn username — the handle, not the URL',
    fieldType: 'linkedin',
    html: '<label for="f">LinkedIn username</label><input id="f" name="linkedin_username" />',
    template: '{linkedinUser}',
    value: 'dias-nur',
  },
  {
    what: 'GitHub as <input type="url"> — a bare host would not validate',
    fieldType: 'github',
    html: '<label for="f">GitHub</label><input id="f" name="github" type="url" />',
    template: '{githubUrl}',
    value: 'https://github.com/diz1l',
  },
  {
    what: 'GitHub URL asked of a profile that stored only a handle',
    fieldType: 'github',
    html: '<label for="f">GitHub URL</label><input id="f" name="github_url" />',
    template: '{githubUrl}',
    value: 'https://github.com/diz1l',
    profile: { github: 'diz1l' },
  },
  {
    what: 'Website domain',
    fieldType: 'website',
    html: '<label for="f">Domain</label><input id="f" name="site_domain" />',
    template: '{websiteHost}',
    value: 'dias.dev',
    profile: { website: 'https://www.dias.dev/cv' },
  },
  // ── City ──
  {
    what: 'City — the town on its own',
    fieldType: 'city',
    html: '<label for="f">City</label><input id="f" name="city" />',
    template: '{cityName}',
    value: 'Praha',
  },
  {
    what: 'Location (city, country) — as wide as the profile holds',
    fieldType: 'city',
    html: '<label for="f">Location (city, country)</label><input id="f" name="location" />',
    template: '{city}',
    value: 'Praha, Czechia',
  },
  // ── The Workday-shaped fields the profile could not answer before ──
  {
    what: 'Legal Middle Name — the box that used to receive the given name',
    fieldType: 'middleName',
    html: '<label for="f">Legal Middle Name</label><input id="f" name="middleName" />',
    template: '{middleName}',
    value: 'Serik',
  },
  {
    what: 'Preferred Name — the box that used to receive the surname',
    fieldType: 'preferredName',
    html: '<label for="f">Preferred Name</label><input id="f" name="preferredName" />',
    template: '{preferredName}',
    value: 'Dee',
  },
  {
    what: 'Preferred Name of a profile that did not fill one in — still empty',
    fieldType: 'preferredName',
    html: '<label for="f">Preferred Name</label><input id="f" name="preferredName" />',
    template: '{preferredName}',
    value: '',
    profile: { preferredName: '' },
  },
  {
    what: 'Suffix',
    fieldType: 'nameSuffix',
    html: '<label for="f">Suffix</label><input id="f" name="suffix" />',
    template: '{nameSuffix}',
    value: 'Jr.',
  },
  // ── Address ──
  {
    what: 'Address Line 1',
    fieldType: 'addressLine1',
    html: '<label for="f">Address Line 1</label><input id="f" name="addressLine1" />',
    template: '{addressLine1}',
    value: 'Vinohradská 1511/230',
  },
  {
    what: 'State / Province / County',
    fieldType: 'state',
    html: '<label for="f">State / Province / County</label><input id="f" name="state" />',
    template: '{state}',
    value: 'Hlavní město Praha',
  },
  {
    what: 'PSČ — the stored "100 00" without the space a validator rejects',
    fieldType: 'postalCode',
    html: '<label for="f">PSČ</label><input id="f" name="psc" pattern="[0-9]{5}" />',
    template: '{postalCodeCompact}',
    value: '10000',
  },
  {
    what: 'Country — the full name, however it was written down',
    fieldType: 'country',
    html: '<label for="f">Country</label><input id="f" name="country" />',
    template: '{countryName}',
    value: 'Czechia',
    profile: { country: 'CZ' },
  },
  // ── Background ──
  {
    what: 'Date of birth — ISO, the one spelling a date input accepts',
    fieldType: 'dateOfBirth',
    html: '<label for="f">Date of birth</label><input id="f" name="dob" type="date" />',
    template: '{dobIso}',
    value: '1990-03-15',
  },
  {
    what: 'Highest level of education',
    fieldType: 'education',
    html: '<label for="f">Highest level of education</label><input id="f" name="education" />',
    template: '{education}',
    value: "Master's degree",
  },
  {
    what: 'Řidičský průkaz',
    fieldType: 'drivingLicence',
    html: '<label for="f">Řidičský průkaz</label><input id="f" name="ridicsky_prukaz" />',
    template: '{drivingLicence}',
    value: 'B',
  },
  // ── Work ──
  {
    what: 'Current employer',
    fieldType: 'currentEmployer',
    html: '<label for="f">Current employer</label><input id="f" name="employer" />',
    template: '{currentEmployer}',
    value: 'Acme s.r.o.',
  },
  {
    what: 'Years of experience — as written, "5+" and all',
    fieldType: 'yearsOfExperience',
    html: '<label for="f">Years of experience</label><input id="f" name="experience" />',
    template: '{yearsOfExperience}',
    value: '5+',
  },
  // ── Salary ──
  {
    what: 'Salary as text — currency and all',
    fieldType: 'salary',
    html: '<label for="f">Salary expectation</label><input id="f" name="salary" />',
    template: '{salary}',
    value: '80 000 Kč',
  },
  {
    what: 'Salary as <input type="number"> — "80 000 Kč" would blank the field',
    fieldType: 'salary',
    html: '<label for="f">Expected salary</label><input id="f" name="salary" type="number" />',
    template: '{salaryNumber}',
    value: '80000',
  },
  // ── An atom that is not there ──
  {
    what: 'Full name with no surname in the profile — no dangling space',
    fieldType: 'fullName',
    html: '<label for="f">Full name</label><input id="f" name="full_name" />',
    template: '{givenName} {familyName}',
    value: 'Dias',
    profile: { firstName: 'Dias', lastName: '' },
  },
  {
    what: 'Příjmení a jméno with no surname — no leading separator either',
    fieldType: 'fullName',
    html: '<label for="f">Příjmení a jméno</label><input id="f" name="cele_jmeno" />',
    template: '{familyName} {givenName}',
    value: 'Dias',
    profile: { firstName: 'Dias', lastName: '' },
  },
  {
    what: 'Country code with no phone in the profile — nothing, not "+"',
    fieldType: 'phone',
    html: '<label for="f">Country code</label><input id="f" name="country_code" />',
    template: '{phoneCountryCode}',
    value: '',
    profile: { phone: '' },
  },
];

describe('form field → template → value', () => {
  for (const row of CASES) {
    it(`${row.what} → ${row.template}`, () => {
      const s = shapeOf(row.html);
      const ctx = ctxOf(row.profile);
      expect(selectTemplate(row.fieldType, ctx, s)).toBe(row.template);
      expect(resolveFieldType(row.fieldType, ctx, s)).toBe(row.value);
    });
  }
});

describe('composition through fillPage', () => {
  afterEach(() => {
    removeAllHighlights();
    forgetCoverTargets();
  });

  const valueOf = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

  it('fills the Czech single-box name in the order the label asks for', () => {
    document.body.innerHTML =
      '<form><div><label for="n">Příjmení a jméno</label>' +
      '<input id="n" name="cele_jmeno" /></div></form>';
    fillPage(PROFILE);
    expect(valueOf('n')).toBe('Nurgaliyev Dias');
  });

  it('drops the country code for a phone box that validates nine digits', () => {
    document.body.innerHTML =
      '<form><div><label for="p">Telefon</label>' +
      '<input id="p" name="telefon" type="tel" pattern="[0-9]{9}" /></div></form>';
    fillPage(PROFILE);
    expect(valueOf('p')).toBe('123456789');
  });

  /** No key, no network, no settings: composition is the default behaviour. */
  it('needs nothing but the profile — no classifier is consulted', () => {
    document.body.innerHTML =
      '<form><div><label for="n">Full name</label><input id="n" name="full_name" /></div>' +
      '<div><label for="c">City</label><input id="c" name="city" /></div></form>';
    const summary = fillPage(PROFILE);
    expect(valueOf('n')).toBe('Dias Nurgaliyev');
    expect(valueOf('c')).toBe('Praha');
    expect(summary.high + summary.medium).toBe(2);
  });

  /**
   * An atom the profile does not hold is still reported as missing — the
   * composition layer must not paper over it by writing half a value.
   */
  it('reports an empty atom as missing data rather than writing a stub', () => {
    document.body.innerHTML =
      '<form><div><label for="p">Phone country code</label>' +
      '<input id="p" name="phone_country_code" /></div></form>';
    const summary = fillPage({ ...PROFILE, phone: '' });
    expect(valueOf('p')).toBe('');
    expect(summary.noData).toBe(1);
    expect(summary.missingFields).toEqual(['phone']);
  });
});

describe('resolveAnswer', () => {
  it('resolves a field type', () => {
    expect(resolveAnswer('email', ctxOf())).toBe('dias@example.com');
  });

  it('resolves a template the model composed itself', () => {
    expect(resolveAnswer('{lastName}, {firstName}', ctxOf())).toBe('Nurgaliyev, Dias');
  });

  it('answers a shaped field with the shaped spelling', () => {
    expect(resolveAnswer('phone', ctxOf(), shape({ pattern: '[0-9]{9}' }))).toBe('123456789');
  });

  it('writes nothing for an answer that is neither', () => {
    expect(resolveAnswer('maidenName', ctxOf())).toBe('');
    expect(resolveAnswer('{maidenName}', ctxOf())).toBe('');
  });
});

describe('spellings for the fields added in schema v2', () => {
  const p = createEmptyProfile({
    country: 'Czechia',
    dateOfBirth: '1998-03-15',
    yearsOfExperience: '5 years',
  });
  const ask = (type: string, html: string) => {
    document.body.innerHTML = html;
    const el = document.querySelector('input') as HTMLInputElement;
    return resolveAnswer(type, { profile: p }, describeField(buildFingerprint(el)));
  };

  it('gives a country box the name and a code box the code', () => {
    expect(ask('country', '<label for="x">Country</label><input id="x">')).toBe('Czechia');
    expect(ask('country', '<label for="x">Country code</label><input id="x" maxlength="2">')).toBe('CZ');
  });

  it('does not invent a code for a country the table does not list', () => {
    document.body.innerHTML = '<label for="x">Country code</label><input id="x" maxlength="2">';
    const el = document.querySelector('input') as HTMLInputElement;
    const unknown = createEmptyProfile({ country: 'Wakanda' });
    expect(resolveAnswer('country', { profile: unknown }, describeField(buildFingerprint(el)))).toBe('');
  });

  it('reads a dd.mm.rrrr placeholder as one whole date, not as a day box', () => {
    // The demonstration contains the literal `dd`, which answered the entire
    // field with "15" until the full-date check was moved ahead of the split ones.
    expect(ask('dateOfBirth', '<label for="x">Datum narození</label><input id="x" placeholder="dd.mm.rrrr">'))
      .toBe('15.03.1998');
  });

  it('answers each box of a split date with its own component', () => {
    expect(ask('dateOfBirth', '<label for="x">Day</label><input id="x">')).toBe('15');
    expect(ask('dateOfBirth', '<label for="x">Month</label><input id="x">')).toBe('03');
    expect(ask('dateOfBirth', '<label for="x">Year</label><input id="x" maxlength="4">')).toBe('1998');
  });

  it('keeps the canonical spelling for a native date control', () => {
    expect(ask('dateOfBirth', '<label for="x">Date of birth</label><input id="x" type="date">'))
      .toBe('1998-03-15');
  });

  it('reads a format spelled out in the label, not only in the placeholder', () => {
    // "Datum narození (dd.mm.rrrr)" states the format in the label itself.
    expect(ask('dateOfBirth', '<label for="x">Datum narození (dd.mm.rrrr)</label><input id="x">'))
      .toBe('15.03.1998');
  });

  it('takes a country code from the wording alone, with no length limit to help', () => {
    expect(ask('country', '<label for="x">ISO code</label><input id="x">')).toBe('CZ');
  });

  it('treats a four-digit pattern as a year box even when nothing is labelled', () => {
    expect(ask('dateOfBirth', '<label for="x">Narození</label><input id="x" pattern="[0-9]{4}">'))
      .toBe('1998');
  });

  it('strips the unit from years of experience only where a number is required', () => {
    expect(ask('yearsOfExperience', '<label for="x">Years of experience</label><input id="x" type="number">')).toBe('5');
    expect(ask('yearsOfExperience', '<label for="x">Years of experience</label><input id="x">')).toBe('5 years');
  });
});
