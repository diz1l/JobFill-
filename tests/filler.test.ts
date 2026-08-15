import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setNativeValue } from '../shared/filler/setNativeValue';
import {
  fillSelect,
  readableOptions,
  selectOptionByLabel,
} from '../shared/filler/selectStrategy';
import {
  askableSelects,
  isBinaryChoice,
  isDeclarationField,
  protectedTopic,
} from '../shared/filler/questionPolicy';
import {
  classifyUnresolvedFields,
  fillPage,
  type FillOptions,
} from '../shared/filler/index';
import * as filler from '../shared/filler';
import { removeAllHighlights } from '../shared/filler/highlight';
import { forgetCoverTargets, resolveCoverTarget } from '../shared/filler/coverTarget';
import { describeMissingData, splitMissingData } from '../shared/filler/missingData';
import { buildFingerprint, type FieldFingerprint } from '../shared/field-matcher/fingerprint';
import type { SelectQuestion } from '../shared/messages';
import {
  MAX_CLASSIFY_FIELDS,
  MAX_OPTION_LABEL_CHARS,
  MAX_OPTION_PAYLOAD_CHARS,
  MAX_OPTION_SELECTS,
  MAX_SELECT_OPTIONS,
} from '../shared/messages';
import {
  createEmptyProfile,
  DEFAULT_SETTINGS,
  LLM_FIELD_CONFIDENCE,
  type LlmFieldConfidence,
  type Profile,
} from '../shared/types';

describe('setNativeValue', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function record(el: HTMLElement): string[] {
    const seen: string[] = [];
    el.addEventListener('input', () => seen.push('input'));
    el.addEventListener('change', () => seen.push('change'));
    return seen;
  }

  it('writes the value into an input', () => {
    const el = document.createElement('input');
    setNativeValue(el, 'Ada');
    expect(el.value).toBe('Ada');
  });

  it('writes the value into a textarea', () => {
    const el = document.createElement('textarea');
    setNativeValue(el, 'Dear hiring manager');
    expect(el.value).toBe('Dear hiring manager');
  });

  it('dispatches input then change, in that order', () => {
    const el = document.createElement('input');
    const seen = record(el);
    setNativeValue(el, 'x');
    expect(seen).toEqual(['input', 'change']);
  });

  it('dispatches input and change on a textarea too', () => {
    const el = document.createElement('textarea');
    const seen = record(el);
    setNativeValue(el, 'x');
    expect(seen).toEqual(['input', 'change']);
  });

  /**
   * The whole point of this helper: React attaches ONE delegated listener high
   * up in the tree, so a non-bubbling event never reaches it and the controlled
   * component silently reverts the value on the next render.
   */
  it('the events bubble, which is what React-controlled forms rely on', () => {
    document.body.innerHTML = '<form id="root"><input id="f" /></form>';
    const root = document.getElementById('root') as HTMLFormElement;
    const el = document.getElementById('f') as HTMLInputElement;
    const seen: string[] = [];
    root.addEventListener('input', (e) => seen.push(`input:${e.bubbles}`));
    root.addEventListener('change', (e) => seen.push(`change:${e.bubbles}`));

    setNativeValue(el, 'Ada');
    expect(seen).toEqual(['input:true', 'change:true']);
  });

  it('goes through the prototype setter, not the own property (React value tracker)', () => {
    const el = document.createElement('input');
    // React installs its own `value` shim on the instance; writing straight to
    // `el.value` would hit that shim and be swallowed. Prove we bypass it.
    let ownSetterCalls = 0;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => 'shim',
      set: () => {
        ownSetterCalls++;
      },
    });

    setNativeValue(el, 'Ada');
    expect(ownSetterCalls).toBe(0);

    delete (el as unknown as Record<string, unknown>).value;
    expect(el.value).toBe('Ada');
  });

  it('writes an empty string without throwing', () => {
    const el = document.createElement('input');
    el.value = 'stale';
    setNativeValue(el, '');
    expect(el.value).toBe('');
  });

  it('does nothing when the prototype exposes no value setter', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    // `set: undefined` has to be explicit — redefining an existing accessor with
    // a partial descriptor keeps the attributes it does not mention.
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true,
      get: () => 'frozen',
      set: undefined,
    });
    try {
      const el = document.createElement('input');
      const seen = record(el);
      expect(() => setNativeValue(el, 'Ada')).not.toThrow();
      expect(seen).toEqual([]);
    } finally {
      Object.defineProperty(HTMLInputElement.prototype, 'value', original);
    }
  });
});

describe('fillSelect', () => {
  function select(...options: (string | [string, string])[]): HTMLSelectElement {
    const el = document.createElement('select');
    for (const opt of options) {
      const [text, value] = Array.isArray(opt) ? opt : [opt, opt];
      const o = document.createElement('option');
      o.textContent = text;
      o.value = value;
      el.appendChild(o);
    }
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('picks an exactly matching option text', () => {
    const el = select('Yes', 'No');
    expect(fillSelect(el, 'Yes')).toBe(true);
    expect(el.selectedIndex).toBe(0);
  });

  it('picks an exactly matching option value when the text differs', () => {
    const el = select(['Ano', 'yes'], ['Ne', 'no']);
    expect(fillSelect(el, 'no')).toBe(true);
    expect(el.value).toBe('no');
  });

  it('is case insensitive', () => {
    const el = select('Prague', 'Brno');
    expect(fillSelect(el, 'PRAGUE')).toBe(true);
    expect(el.value).toBe('Prague');
  });

  it('folds diacritics', () => {
    const el = select('Plzeň', 'Praha');
    expect(fillSelect(el, 'Plzen')).toBe(true);
    expect(el.selectedIndex).toBe(0);
  });

  it('ignores punctuation', () => {
    const el = select('Czech Republic', 'Slovakia');
    expect(fillSelect(el, '(Czech Republic)')).toBe(true);
    expect(el.selectedIndex).toBe(0);
  });

  it('accepts a substring match', () => {
    const el = select('Prague, Czech Republic', 'Vienna, Austria');
    expect(fillSelect(el, 'Prague')).toBe(true);
    expect(el.selectedIndex).toBe(0);
  });

  it('accepts a superstring match', () => {
    const el = select('Prague', 'Vienna');
    expect(fillSelect(el, 'Prague, Czechia')).toBe(true);
    expect(el.selectedIndex).toBe(0);
  });

  it('accepts a half-word overlap (exactly at the threshold)', () => {
    const el = select('Prague Czechia', 'Berlin Germany');
    expect(fillSelect(el, 'Prague Slovakia')).toBe(true);
    expect(el.selectedIndex).toBe(0);
  });

  it('refuses when nothing resembles the value', () => {
    const el = select('Alpha', 'Beta', 'Gamma');
    expect(fillSelect(el, 'Prague')).toBe(false);
    expect(el.selectedIndex).toBe(0); // untouched
  });

  it('refuses a one-in-three word overlap (below the threshold)', () => {
    const el = select('alpha beta gamma');
    expect(fillSelect(el, 'alpha delta epsilon')).toBe(false);
  });

  it('refuses a select with no options', () => {
    expect(fillSelect(select(), 'Yes')).toBe(false);
  });

  it('ignores an empty placeholder option', () => {
    const el = select(['Select…', ''], 'Yes', 'No');
    expect(fillSelect(el, 'No')).toBe(true);
    expect(el.value).toBe('No');
  });

  it('dispatches a bubbling change event when it selects something', () => {
    document.body.innerHTML = '<form id="root"></form>';
    const root = document.getElementById('root') as HTMLFormElement;
    const el = select('Yes', 'No');
    root.appendChild(el);

    const seen: string[] = [];
    root.addEventListener('change', (e) => seen.push(`change:${e.bubbles}`));
    fillSelect(el, 'Yes');
    expect(seen).toEqual(['change:true']);
  });

  it('dispatches nothing when it refuses to choose', () => {
    const el = select('Alpha', 'Beta');
    const seen: string[] = [];
    el.addEventListener('change', () => seen.push('change'));
    expect(fillSelect(el, 'Prague')).toBe(false);
    expect(seen).toEqual([]);
  });

  it('keeps the best of several partial matches', () => {
    const el = select('Other', 'Prague area', 'Prague');
    expect(fillSelect(el, 'Prague')).toBe(true);
    expect(el.selectedIndex).toBe(2);
  });

  // ── Placeholders are not answers (the visible half of the Workday report) ──

  describe('placeholders', () => {
    /**
     * Every list on the reported form sat on "Please Select", and "Select" is a
     * real word that really does resemble things — a similarity score on its own
     * makes this *worse*, not better.
     */
    it.each([
      'Please Select',
      'Please select one',
      '-- Select --',
      'Select…',
      'Select an option',
      'Choose one',
      '— vyberte —',
      'Vyberte možnost',
      'Zvolte prosím',
      'Bitte wählen',
      'None',
      'Not specified',
      '---',
    ])('never selects "%s", whatever the value is', (label) => {
      const el = select([label, 'placeholder-value'], 'Praha');
      expect(fillSelect(el, label)).toBe(false);
      expect(el.selectedIndex).toBe(0);
      expect(el.value).toBe('placeholder-value');
    });

    it('never selects a disabled option', () => {
      const el = select('Yes', 'No');
      el.options[0].disabled = true;
      expect(fillSelect(el, 'Yes')).toBe(false);
    });

    it('never selects an option with an empty value attribute', () => {
      const el = select(['Yes', ''], 'No');
      expect(fillSelect(el, 'Yes')).toBe(false);
    });

    it('never selects an option whose label normalizes to nothing', () => {
      // Cyrillic, CJK and the like fold away entirely. Two strings that both
      // vanish are not a match; they are two absences agreeing.
      const el = select(['Русский', 'ru-value'], 'English');
      expect(fillSelect(el, 'Українська')).toBe(false);
    });

    it('still fills the list around them', () => {
      const el = select(['Please Select', ''], 'Yes', 'No');
      expect(fillSelect(el, 'Yes')).toBe(true);
      expect(el.value).toBe('Yes');
    });
  });

  // ── Named things are compared by name (the reported country case) ──

  describe('synonyms', () => {
    it('finds "Czech Republic" for a profile that says Czechia', () => {
      const el = select(['Please Select', ''], 'Austria', 'Czech Republic', 'Slovakia');
      expect(fillSelect(el, 'Czechia')).toBe(true);
      expect(el.value).toBe('Czech Republic');
    });

    it('works in every direction the two spellings can be typed', () => {
      const czechia = () => select(['Please Select', ''], 'Czechia', 'Slovakia');
      const long = () => select(['Please Select', ''], 'Czech Republic', 'Slovakia');

      expect(fillSelect(czechia(), 'Czech Republic')).toBe(true);
      expect(fillSelect(long(), 'CZ')).toBe(true);
      expect(fillSelect(long(), 'Česká republika')).toBe(true);
      expect(fillSelect(czechia(), 'Česko')).toBe(true);
    });

    it('reads the option value when the label is the one it does not know', () => {
      const el = select(['Please Select', ''], ['Česká republika (CZ)', 'CZ'], ['Slovensko', 'SK']);
      expect(fillSelect(el, 'Czechia')).toBe(true);
      expect(el.value).toBe('CZ');
    });

    it('refuses a neighbouring country outright, however the words line up', () => {
      // The refusal is the point: "Slovakia" shares a word with nothing here,
      // but a list of "X Republic" entries scores half a point all over.
      const el = select(['Please Select', ''], 'Slovak Republic');
      expect(fillSelect(el, 'Czech Republic')).toBe(false);
      expect(el.selectedIndex).toBe(0);
    });

    it('matches a language by its native name, its English name and its code', () => {
      const list = () => select(['Please Select', ''], ['Čeština', 'cs'], ['English', 'en']);
      expect(fillSelect(list(), 'Czech')).toBe(true);
      expect(fillSelect(list(), 'Čeština')).toBe(true);
      expect(fillSelect(list(), 'cs')).toBe(true);

      const filled = list();
      fillSelect(filled, 'Czech');
      expect(filled.value).toBe('cs');
    });

    it('does not confuse a language with the country of the same name', () => {
      const countries = select(['Please Select', ''], 'Germany', 'Austria');
      expect(fillSelect(countries, 'German')).toBe(false);
    });

    it('matches a level of education across languages and phrasings', () => {
      const list = () =>
        select(['Please Select', ''], "Bachelor's Degree", "Master's Degree", 'Doctorate');
      expect(fillSelect(list(), 'Bachelor')).toBe(true);
      expect(fillSelect(list(), 'Vysokoškolské — bakalářské')).toBe(true);
      expect(fillSelect(list(), 'BSc')).toBe(true);

      const filled = list();
      fillSelect(filled, 'Bakalářské');
      expect(filled.value).toBe("Bachelor's Degree");
    });

    it('never rounds a degree up: a bachelor is not a master', () => {
      const el = select(['Please Select', ''], "Master's Degree", 'Doctorate');
      expect(fillSelect(el, "Bachelor's Degree")).toBe(false);
    });

    it('answers a Czech yes/no list from an English profile value', () => {
      const el = select(['— vyberte —', ''], 'Ano', 'Ne');
      expect(fillSelect(el, 'Yes')).toBe(true);
      expect(el.value).toBe('Ano');
    });

    /**
     * `<option value="NO">Norway</option>` says "Norway" to a reader and "no" to
     * a matcher that trusts the value attribute. A profile answer of "No" must
     * not select a country — the label is asked first, and it vetoes.
     */
    it('does not answer "No" with Norway', () => {
      const el = select(['Please Select', ''], ['Norway', 'NO'], ['Sweden', 'SE']);
      expect(fillSelect(el, 'No')).toBe(false);
      expect(el.selectedIndex).toBe(0);
    });
  });

  // ── Ambiguity is a refusal ──

  describe('the decisive lead', () => {
    /**
     * The case the threshold cannot see: both options are equally good, so the
     * winner is whichever the page listed first. On this pair that is a coin
     * toss between two countries.
     */
    it('selects nothing when two options answer equally well', () => {
      const el = select(
        ['Please Select', ''],
        'Korea, Republic of',
        "Korea, Democratic People's Republic of",
      );
      expect(fillSelect(el, 'Korea')).toBe(false);
      expect(el.selectedIndex).toBe(0);
    });

    it('is not confused by a list that repeats the same answer twice', () => {
      // Same text and same value: one answer written twice is not a rival.
      const el = select(['Please Select', ''], 'Yes', 'Yes');
      expect(fillSelect(el, 'Yes')).toBe(true);
      expect(el.selectedIndex).toBe(1);
    });

    it('still resolves an exact match beside a longer option containing it', () => {
      const el = select(['Please Select', ''], 'Yes, with conditions', 'Yes');
      expect(fillSelect(el, 'Yes')).toBe(true);
      expect(el.selectedIndex).toBe(2);
    });
  });
});

describe('readableOptions', () => {
  function select(html: string): HTMLSelectElement {
    document.body.innerHTML = `<select>${html}</select>`;
    return document.querySelector('select')!;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lists the options that could actually be chosen, in page order', () => {
    const el = select(
      '<option value="">Please Select</option><option>Mobile</option><option>Home</option>',
    );
    expect(readableOptions(el)).toEqual(['Mobile', 'Home']);
  });

  it('collapses whitespace but keeps the label as the page prints it', () => {
    const el = select('<option>  Czech\n  Republic </option><option>Slovakia</option>');
    expect(readableOptions(el)).toEqual(['Czech Republic', 'Slovakia']);
  });

  it('is empty for a list that offers nothing but a prompt', () => {
    const el = select('<option value="">— vyberte —</option>');
    expect(readableOptions(el)).toEqual([]);
  });
});

describe('selectOptionByLabel', () => {
  function select(...labels: string[]): HTMLSelectElement {
    document.body.innerHTML = `<select><option value="">Please Select</option>${labels
      .map((l) => `<option>${l}</option>`)
      .join('')}</select>`;
    return document.querySelector('select')!;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('selects the option carrying exactly that label', () => {
    const el = select('Mobile', 'Home', 'Work');
    expect(selectOptionByLabel(el, 'Home')).toBe(true);
    expect(el.value).toBe('Home');
  });

  it('dispatches a bubbling change event, like every other write', () => {
    const el = select('Mobile');
    const seen: string[] = [];
    el.addEventListener('change', (e) => seen.push(`change:${e.bubbles}`));
    selectOptionByLabel(el, 'Mobile');
    expect(seen).toEqual(['change:true']);
  });

  it('refuses a label the list does not offer — nothing fuzzy happens here', () => {
    const el = select('Mobile', 'Home');
    expect(selectOptionByLabel(el, 'Mobil')).toBe(false);
    expect(selectOptionByLabel(el, 'Mobile phone')).toBe(false);
    expect(el.selectedIndex).toBe(0);
  });

  it('refuses a placeholder even when named exactly', () => {
    const el = select('Mobile');
    expect(selectOptionByLabel(el, 'Please Select')).toBe(false);
  });

  it('refuses an empty label rather than matching an empty option', () => {
    const el = select('Mobile');
    expect(selectOptionByLabel(el, '   ')).toBe(false);
  });
});

// ─── The questions no model may answer ───────────────────────────────────────

describe('questionPolicy', () => {
  /** `serializeFingerprint` order: autocomplete|name|id|semantic|aria|label|placeholder|heading|desc */
  const fp = (label: string, name = '') => `|${name}||${name}||${label}|||`;

  /**
   * The four questions the live Workday run turned up, plus the classes the
   * brief names. Every one of them is a statement about a person that goes to an
   * employer under that person's name.
   */
  it.each([
    ['age', 'Are you at least 18 years of age or older?', 'age_18'],
    ['age', 'Are you of required legal drinking age?', 'drinking_age'],
    ['age', 'Datum narození', 'datum_narozeni'],
    ['workAuthorization', 'Are you legally authorized to work in this country?', 'work_auth'],
    ['workAuthorization', 'Will you now or in the future require sponsorship?', 'sponsorship'],
    ['workAuthorization', 'Country of citizenship', 'citizenship'],
    ['criminalRecord', 'Have you ever been convicted of a felony?', 'conviction'],
    ['criminalRecord', 'Výpis z rejstříku trestů', 'rejstrik'],
    ['militaryService', 'Are you a protected veteran?', 'veteran_status'],
    ['disability', 'Do you have a disability?', 'disability_status'],
    ['protectedGroup', 'Gender', 'gender'],
    ['protectedGroup', 'Race / Ethnicity', 'ethnicity'],
    ['consent', 'Human Resources may contact me regarding other positions', 'hr_contact'],
    ['consent', 'Souhlasím se zpracováním osobních údajů', 'souhlas'],
    ['attestation', 'Is your work experience and education included on your resume?', 'resume_ok'],
    ['attestation', 'I certify that the information provided is true and complete', 'certify'],
    ['credentials', 'Please list your highest level of education achieved', 'education_level'],
    ['credentials', 'Nejvyšší dosažené vzdělání', 'vzdelani'],
    ['credentials', 'Driving licence', 'driving_licence'],
  ])('refuses %s: "%s"', (topic, label, name) => {
    expect(protectedTopic(fp(label, name))).toBe(topic);
  });

  /**
   * The patterns are drawn generously, which is only safe while they stay off
   * the ordinary fields. `Preferred Language` is the one that matters most here:
   * "Language" contains "age".
   */
  it.each([
    ['Preferred Language', 'preferred_language'],
    ['Phone Type', 'phone_type'],
    ['Country', 'country'],
    ['State / Province / County', 'state'],
    ['Suffix', 'suffix'],
    ['How did you hear about us?', 'source'],
    ['Preferred contact method', 'contact_method'],
    ['City', 'city'],
  ])('leaves "%s" answerable', (label, name) => {
    expect(protectedTopic(fp(label, name))).toBeNull();
  });

  it('bars the value-template path only for what no stored value can answer', () => {
    // No profile field exists — or ever will — for these, so a template naming
    // a real atom here is an invented declaration.
    expect(isDeclarationField(fp('Have you been convicted of a crime?'))).toBe(true);
    expect(isDeclarationField(fp('Do you have a disability?'))).toBe(true);
    expect(isDeclarationField(fp('I certify that this is accurate'))).toBe(true);

    // …while these have a profile field of their own, so copying it is the user
    // answering, not the model. The dropdown path still refuses them.
    expect(isDeclarationField(fp('Do you need a work permit?'))).toBe(false);
    expect(isDeclarationField(fp('Highest level of education'))).toBe(false);
    expect(protectedTopic(fp('Do you need a work permit?'))).toBe('workAuthorization');
  });

  it('recognises a yes/no list by its shape, in either language', () => {
    expect(isBinaryChoice(['Yes', 'No'])).toBe(true);
    expect(isBinaryChoice(['Ano', 'Ne'])).toBe(true);
    expect(isBinaryChoice(['Yes', 'No', 'Prefer not to say'])).toBe(true);
    expect(isBinaryChoice(['Mobile', 'Home', 'Work'])).toBe(false);
    expect(isBinaryChoice(['Yes', 'Yes, with conditions'])).toBe(false);
  });

  describe('askableSelects', () => {
    const question = (fingerprint: string, options: string[]) => ({ fingerprint, options });
    const many = (n: number) => Array.from({ length: n }, (_, i) => `Option ${i}`);

    it('passes an ordinary category list through untouched', () => {
      const asked = [question(fp('Phone Type', 'phone_type'), ['Mobile', 'Home', 'Work'])];
      expect(askableSelects(asked)).toEqual(asked);
    });

    it('drops a protected question before it can be asked', () => {
      expect(
        askableSelects([question(fp('Are you at least 18?', 'age'), ['Under 18', 'Over 18'])]),
      ).toEqual([]);
    });

    it('drops every yes/no list, whatever it is about', () => {
      expect(askableSelects([question(fp('Would you relocate?'), ['Yes', 'No'])])).toEqual([]);
    });

    it('drops a list that offers no choice at all', () => {
      expect(askableSelects([question(fp('Phone Type'), ['Mobile'])])).toEqual([]);
    });

    it('never sends a long list — a country dropdown is answered from the profile', () => {
      expect(askableSelects([question(fp('Country'), many(MAX_SELECT_OPTIONS + 1))])).toEqual([]);
      expect(askableSelects([question(fp('Region'), many(MAX_SELECT_OPTIONS))])).toHaveLength(1);
    });

    it('never sends an option that is a paragraph', () => {
      const essay = 'x'.repeat(MAX_OPTION_LABEL_CHARS + 1);
      expect(askableSelects([question(fp('Terms'), ['Short', essay])])).toEqual([]);
    });

    it('stops at MAX_OPTION_SELECTS dropdowns', () => {
      const asked = Array.from({ length: MAX_OPTION_SELECTS + 4 }, (_, i) =>
        question(fp(`Category ${i}`), ['Alpha', 'Beta']),
      );
      expect(askableSelects(asked)).toHaveLength(MAX_OPTION_SELECTS);
    });

    it('stops at the character budget, so a page cannot enlarge the request', () => {
      const long = 'Category option '.repeat(3).slice(0, MAX_OPTION_LABEL_CHARS);
      const wide = () => question(fp('Category'), Array(MAX_SELECT_OPTIONS).fill(long));
      const asked = Array.from({ length: MAX_OPTION_SELECTS }, wide);
      const sent = askableSelects(asked);

      const chars = sent.reduce(
        (total, s) => total + s.fingerprint.length + s.options.join('').length,
        0,
      );
      expect(chars).toBeLessThanOrEqual(MAX_OPTION_PAYLOAD_CHARS);
      expect(sent.length).toBeLessThan(asked.length);
    });
  });
});

// ─── fillPage (the orchestrator) ─────────────────────────────────────────────

const PROFILE: Profile = createEmptyProfile({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '+420123456789',
  city: 'Prague',
  linkedin: 'https://linkedin.com/in/ada',
  github: 'https://github.com/ada',
  website: 'https://ada.dev',
  salaryExpectation: '80000 CZK',
  availability: '1 September',
  workPermit: 'Yes',
  about: 'I build things that work.',
});

/** `<label>` + control inside a wrapper, the shape most ATS forms boil down to. */
function field(id: string, label: string, control: string): string {
  return `<div class="field"><label for="${id}">${label}</label>${control}</div>`;
}

function render(html: string): void {
  document.body.innerHTML = html;
}

function valueOf(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value;
}

describe('fillPage', () => {
  beforeEach(() => {
    forgetCoverTargets();
  });

  afterEach(() => {
    removeAllHighlights();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('fills every profile-backed field type it recognises', () => {
    render(
      '<form>' +
        field('fn', 'First name', '<input id="fn" name="first_name" />') +
        field('ln', 'Last name', '<input id="ln" name="last_name" />') +
        field('em', 'Email', '<input id="em" type="email" name="email" autocomplete="email" />') +
        field('ph', 'Phone', '<input id="ph" type="tel" name="phone" />') +
        field('li', 'LinkedIn', '<input id="li" name="linkedin_url" />') +
        field('gh', 'GitHub', '<input id="gh" name="github_url" />') +
        field('ws', 'Personal website', '<input id="ws" name="website" />') +
        field('sal', 'Salary expectation', '<input id="sal" name="salary_expectation" />') +
        field('cty', 'City', '<input id="cty" name="city" />') +
        field('av', 'Start date', '<input id="av" name="start_date" />') +
        field('wp', 'Work permit', '<input id="wp" name="work_permit" />') +
        field('ab', 'About you', '<textarea id="ab" name="about"></textarea>') +
        '</form>',
    );

    const summary = fillPage(PROFILE);

    expect(valueOf('fn')).toBe('Ada');
    expect(valueOf('ln')).toBe('Lovelace');
    expect(valueOf('em')).toBe('ada@example.com');
    expect(valueOf('ph')).toBe('+420123456789');
    expect(valueOf('li')).toBe('https://linkedin.com/in/ada');
    expect(valueOf('gh')).toBe('https://github.com/ada');
    expect(valueOf('ws')).toBe('https://ada.dev');
    expect(valueOf('sal')).toBe('80000 CZK');
    expect(valueOf('cty')).toBe('Prague');
    expect(valueOf('av')).toBe('1 September');
    expect(valueOf('wp')).toBe('Yes');
    expect(valueOf('ab')).toBe('I build things that work.');

    expect(summary.high + summary.medium).toBe(12);
    expect(summary.total).toBe(12);
  });

  it('composes fullName out of the two name parts', () => {
    render('<form>' + field('nm', 'Full name', '<input id="nm" name="name" />') + '</form>');
    fillPage(PROFILE);
    expect(valueOf('nm')).toBe('Ada Lovelace');
  });

  it('writes the pre-resolved cover letter text into the cover-letter field', () => {
    render(
      '<form>' + field('cl', 'Cover letter', '<textarea id="cl" name="cover_letter"></textarea>') + '</form>',
    );
    fillPage(PROFILE, { coverLetterText: 'Dear Acme,' });
    expect(valueOf('cl')).toBe('Dear Acme,');
  });

  it('remembers the cover-letter field even when there is no text for it yet (P1-12)', () => {
    render(
      '<form>' + field('cl', 'Cover letter', '<textarea id="cl" name="cover_letter"></textarea>') + '</form>',
    );
    const summary = fillPage(PROFILE);
    expect(valueOf('cl')).toBe('');
    // Recognised, not unrecognised: we knew exactly what this field was.
    expect(summary.unrecognized).toBe(0);
    expect(summary.noData).toBe(1);
    expect(summary.missingFields).toEqual(['coverLetter']);
    expect(resolveCoverTarget()).toBe(document.getElementById('cl'));
  });

  /**
   * A cover letter is generated text in a box an employer reads: it is reported
   * amber ("check this") even when the match itself was unambiguous.
   */
  it('never highlights a cover letter green, however confident the match', () => {
    render(
      '<form>' + field('cl', 'Cover letter', '<textarea id="cl" name="cover_letter"></textarea>') + '</form>',
    );
    const s = fillPage(PROFILE, { coverLetterText: 'Dear Acme,' });
    expect(valueOf('cl')).toBe('Dear Acme,');
    expect(document.getElementById('cl')!.classList.contains('__jobfill-medium')).toBe(true);
    expect(document.getElementById('cl')!.classList.contains('__jobfill-high')).toBe(false);
    expect(s.medium).toBe(1);
    expect(s.high).toBe(0);
  });

  it('dispatches bubbling input/change events for every field it writes', () => {
    render('<form id="root">' + field('fn', 'First name', '<input id="fn" name="first_name" />') + '</form>');
    const seen: string[] = [];
    document.getElementById('root')!.addEventListener('input', () => seen.push('input'));
    document.getElementById('root')!.addEventListener('change', () => seen.push('change'));
    fillPage(PROFILE);
    expect(seen).toEqual(['input', 'change']);
  });

  // ── Counters ──
  it('keeps high + medium + unrecognized + noData + aiQuestions + fileInputs === total', () => {
    render(
      '<form>' +
        field('fn', 'First name', '<input id="fn" name="first_name" />') +
        field('cv', 'Résumé', '<input id="cv" type="file" name="resume" />') +
        field('q1', 'Why do you want to work here?', '<textarea id="q1" name="q_1"></textarea>') +
        field('zz', 'Widget identifier', '<input id="zz" name="widget_identifier_9" />') +
        // recognised, and this profile has nothing for it
        field('cl', 'Cover letter', '<textarea id="cl" name="cover_letter"></textarea>') +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect(s.high + s.medium + s.unrecognized + s.noData + s.aiQuestions + s.fileInputs).toBe(s.total);
    expect(s.fileInputs).toBe(1);
    expect(s.aiQuestions).toBe(1);
    expect(s.unrecognized).toBe(1);
    expect(s.noData).toBe(1);
    expect(s.high + s.medium).toBe(1);
  });

  it('highlights file inputs but never fills them (FR-2.5)', () => {
    render('<form>' + field('cv', 'Résumé', '<input id="cv" type="file" name="resume" />') + '</form>');
    const s = fillPage(PROFILE);
    expect(s.fileInputs).toBe(1);
    expect(document.getElementById('cv')!.classList.contains('__jobfill-file')).toBe(true);
    expect(valueOf('cv')).toBe('');
  });

  it('routes an open-ended question to the AI bucket without filling it', () => {
    render(
      '<form>' +
        field('q1', 'Tell us about a project you are proud of', '<textarea id="q1" name="q_1"></textarea>') +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect(s.aiQuestions).toBe(1);
    expect(valueOf('q1')).toBe('');
    expect(document.getElementById('q1')!.classList.contains('__jobfill-ai')).toBe(true);
  });

  it('marks an unrecognised field and leaves it alone', () => {
    render('<form>' + field('zz', 'Widget identifier', '<input id="zz" name="widget_identifier_9" />') + '</form>');
    const s = fillPage(PROFILE);
    expect(s.unrecognized).toBe(1);
    expect(valueOf('zz')).toBe('');
    expect(document.getElementById('zz')!.classList.contains('__jobfill-none')).toBe(true);
  });

  it('marks a low-confidence near-tie as unrecognised', () => {
    // "GitHub / LinkedIn" scores identically for two rules → downgraded to low.
    render('<form>' + field('amb', 'GitHub / LinkedIn', '<input id="amb" name="github_linkedin" />') + '</form>');
    const s = fillPage(PROFILE);
    expect(s.unrecognized).toBe(1);
    expect(valueOf('amb')).toBe('');
  });

  // ── "We understood it, we have nothing for it" ──

  it('reports a recognised field with an empty profile value as noData, not unrecognized', () => {
    render('<form>' + field('fn', 'First name', '<input id="fn" name="first_name" />') + '</form>');
    const s = fillPage(createEmptyProfile());
    expect(s.noData).toBe(1);
    expect(s.unrecognized).toBe(0);
    expect(s.high + s.medium).toBe(0);
    expect(valueOf('fn')).toBe('');
    // …and it says so on the page, instead of the previous silent skip.
    expect(document.getElementById('fn')!.classList.contains('__jobfill-empty')).toBe(true);
  });

  it('names the field types it had no data for', () => {
    render(
      '<form>' +
        field('fn', 'First name', '<input id="fn" name="first_name" />') +
        field('ph', 'Phone', '<input id="ph" type="tel" name="phone" />') +
        field('cl', 'Cover letter', '<textarea id="cl" name="cover_letter"></textarea>') +
        '</form>',
    );
    const s = fillPage(createEmptyProfile());
    expect(s.noData).toBe(3);
    expect(s.missingFields).toEqual(['firstName', 'phone', 'coverLetter']);
  });

  it('counts controls but lists types only once each', () => {
    render(
      '<form>' +
        field('e1', 'Email', '<input id="e1" name="email" autocomplete="email" />') +
        field('e2', 'Confirm email', '<input id="e2" name="email_confirm" autocomplete="email" />') +
        '</form>',
    );
    const s = fillPage(createEmptyProfile());
    expect(s.noData).toBe(2);
    expect(s.missingFields).toEqual(['email']);
  });

  it('reports nothing missing when the profile covers the page', () => {
    render('<form>' + field('fn', 'First name', '<input id="fn" name="first_name" />') + '</form>');
    const s = fillPage(PROFILE);
    expect(s.noData).toBe(0);
    expect(s.missingFields).toEqual([]);
  });

  /**
   * A `<select>` we recognised, holding a value the page has no option for, is a
   * *third* thing: the data exists, it just does not fit. Nothing the user can
   * add in settings fixes it, so it stays out of `noData`.
   */
  it('keeps an unfillable select in unrecognized, not in noData', () => {
    render(
      '<form>' +
        field('wp', 'Work permit', '<select id="wp" name="work_permit"><option>Alpha</option></select>') +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect(s.unrecognized).toBe(1);
    expect(s.noData).toBe(0);
  });

  it('does not offer a noData field to the LLM pass — a second opinion adds no value', () => {
    render('<form>' + field('fn', 'First name', '<input id="fn" name="first_name" />') + '</form>');
    const seen: FieldFingerprint[] = [];
    fillPage(createEmptyProfile(), { onUnresolved: (fp) => seen.push(fp) });
    expect(seen).toEqual([]);
  });

  it('counts high and medium confidence separately', () => {
    render(
      '<form>' +
        field('em', 'Email', '<input id="em" name="email" autocomplete="email" />') +
        field('ct', 'Location (City)', '<input id="ct" name="job_application[location]" placeholder="City, Country" />') +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect(s.high).toBeGreaterThanOrEqual(1);
    expect(s.high + s.medium).toBe(2);
  });

  // ── <select> path ──
  it('fills a matching <select> and counts it', () => {
    render(
      '<form>' +
        field('wp', 'Work permit', '<select id="wp" name="work_permit"><option>Yes</option><option>No</option></select>') +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect((document.getElementById('wp') as HTMLSelectElement).value).toBe('Yes');
    expect(s.high + s.medium).toBe(1);
    expect(document.getElementById('wp')!.classList.contains('__jobfill-high')).toBe(true);
  });

  it('marks a <select> unrecognised when no option resembles the value', () => {
    render(
      '<form>' +
        field('wp', 'Work permit', '<select id="wp" name="work_permit"><option>Alpha</option><option>Beta</option></select>') +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect(s.unrecognized).toBe(1);
    expect(s.high + s.medium).toBe(0);
    expect(document.getElementById('wp')!.classList.contains('__jobfill-none')).toBe(true);
  });

  it('never writes into a credential field, even when the matcher wants to (P0-4)', () => {
    render(
      '<form>' +
        // A perfect first-name field by every lexical signal, but the
        // autocomplete token marks it as a one-time code.
        field('otp', 'First name', '<input id="otp" name="first_name" autocomplete="one-time-code" />') +
        // A revealed "show password" field the matcher reads as a full name.
        field('pw', 'Full name', '<input id="pw" type="text" name="name" aria-label="Password" />') +
        // A payment field wearing an application field's label.
        field('cc', 'City', '<input id="cc" name="city" placeholder="CVV" />') +
        '</form>',
    );

    const s = fillPage(PROFILE);

    expect(valueOf('otp')).toBe('');
    expect(valueOf('pw')).toBe('');
    expect(valueOf('cc')).toBe('');
    // They are not even counted — they never entered the loop.
    expect(s.total).toBe(0);
  });

  it('never touches anything inside a login form', () => {
    render(
      '<form id="login">' +
        field('le', 'Email', '<input id="le" type="email" name="email" autocomplete="email" />') +
        '<input type="password" name="password" />' +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect(valueOf('le')).toBe('');
    expect(s.total).toBe(0);
  });

  it('still fills the application form when a password field sits in a big form', () => {
    render(
      '<form id="apply">' +
        field('fn', 'First name', '<input id="fn" name="first_name" />') +
        field('ln', 'Last name', '<input id="ln" name="last_name" />') +
        field('em', 'Email', '<input id="em" type="email" name="email" autocomplete="email" />') +
        field('ph', 'Phone', '<input id="ph" type="tel" name="phone" />') +
        field('cty', 'City', '<input id="cty" name="city" />') +
        '<input type="password" name="account_password" />' +
        '<input type="file" name="resume" />' +
        '</form>',
    );
    const s = fillPage(PROFILE);
    expect(valueOf('fn')).toBe('Ada');
    expect(valueOf('em')).toBe('ada@example.com');
    expect(s.high + s.medium).toBe(5);
    expect(s.fileInputs).toBe(1);
  });

  // ── Highlight duration ──
  it('clears highlights after the default 3 s', () => {
    vi.useFakeTimers();
    render('<form>' + field('fn', 'First name', '<input id="fn" name="first_name" />') + '</form>');
    fillPage(PROFILE);
    expect(filler.activeHighlightCount()).toBe(1);
    vi.advanceTimersByTime(2999);
    expect(filler.activeHighlightCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(filler.activeHighlightCount()).toBe(0);
  });

  it('honours a custom highlight duration', () => {
    vi.useFakeTimers();
    render('<form>' + field('fn', 'First name', '<input id="fn" name="first_name" />') + '</form>');
    fillPage(PROFILE, { highlightDurationMs: 500 });
    vi.advanceTimersByTime(500);
    expect(filler.activeHighlightCount()).toBe(0);
  });

  it('returns an all-zero summary on a page with no controls', () => {
    render('<main><p>Nothing to see here.</p></main>');
    expect(fillPage(PROFILE)).toEqual({
      total: 0,
      high: 0,
      medium: 0,
      unrecognized: 0,
      fileInputs: 0,
      aiQuestions: 0,
      noData: 0,
      missingFields: [],
    });
  });
});

/**
 * The form the extension was first run against, reduced to the four controls
 * that matter: a CV file input, the 6000-character motivation letter, and two
 * consent checkboxes. The letter came back empty and the summary said "skipped".
 *
 * These tests are about the *insertion* half of that bug, not about scoring, so
 * the textarea carries the `name` the matcher already keys on — they must not go
 * red when the scorer is retuned.
 */
const CZECH_FORM =
  '<form>' +
  '<div><label for="cv">Životopis</label><input id="cv" type="file" name="cv" /></div>' +
  '<div><label for="dopis">Přiložte motivační dopis</label>' +
  '<textarea id="dopis" name="motivacni_dopis" maxlength="6000"></textarea>' +
  '<span class="counter">0 / 6000</span></div>' +
  '<div><label><input id="gdpr" type="checkbox" name="gdpr_souhlas" />' +
  'Souhlasím se zpracováním osobních údajů</label></div>' +
  '<div><label><input id="news" type="checkbox" name="marketing_souhlas" />' +
  'Chci dostávat nabídky práce e-mailem</label></div>' +
  '<button type="submit">Odeslat</button>' +
  '</form>';

describe('the Czech application form (first live run)', () => {
  beforeEach(() => {
    forgetCoverTargets();
  });

  afterEach(() => {
    removeAllHighlights();
    document.body.innerHTML = '';
  });

  it('writes the letter into the textarea and marks it "check this"', () => {
    render(CZECH_FORM);
    const s = fillPage(PROFILE, { coverLetterText: 'Dobrý den,\n\nrád bych se ucházel…' });

    const letter = document.getElementById('dopis') as HTMLTextAreaElement;
    expect(letter.value).toBe('Dobrý den,\n\nrád bych se ucházel…');
    expect(letter.classList.contains('__jobfill-medium')).toBe(true);
    expect(s.medium).toBe(1);
  });

  it('never touches either consent checkbox (FR-2.6 / S-4)', () => {
    render(CZECH_FORM);
    fillPage(PROFILE, { coverLetterText: 'Dobrý den,' });

    for (const id of ['gdpr', 'news']) {
      const box = document.getElementById(id) as HTMLInputElement;
      expect(box.checked).toBe(false);
      // Not filled, and not even decorated: a checkbox is not a fill target.
      expect(box.className).toBe('');
    }
  });

  it('counts consent checkboxes out of the pass entirely', () => {
    render(CZECH_FORM);
    // 1 file input + 1 textarea. The two checkboxes and the submit button are
    // not enumerable controls at all, so they cannot inflate any counter.
    expect(fillPage(PROFILE, { coverLetterText: 'x' }).total).toBe(2);
  });

  it('highlights the CV input without filling it (FR-2.5)', () => {
    render(CZECH_FORM);
    const s = fillPage(PROFILE, { coverLetterText: 'Dobrý den,' });

    const cv = document.getElementById('cv') as HTMLInputElement;
    expect(cv.value).toBe('');
    expect(cv.classList.contains('__jobfill-file')).toBe(true);
    expect(s.fileInputs).toBe(1);
  });

  it('explains the empty letter instead of silently skipping it (the original bug)', () => {
    render(CZECH_FORM);
    // A brand-new install: a profile exists, no cover template does.
    const s = fillPage(PROFILE, { coverLetterText: '' });

    const letter = document.getElementById('dopis') as HTMLTextAreaElement;
    expect(letter.value).toBe('');
    expect(s.noData).toBe(1);
    expect(s.unrecognized).toBe(0);
    expect(s.missingFields).toEqual(['coverLetter']);
    expect(letter.classList.contains('__jobfill-empty')).toBe(true);
    expect(describeMissingData(s.missingFields)).toContain('No cover letter template yet');
  });

  it('leaves the letter field findable for "Generate → Insert" afterwards', () => {
    render(CZECH_FORM);
    fillPage(PROFILE, { coverLetterText: '' });
    expect(resolveCoverTarget()).toBe(document.getElementById('dopis'));

    // …and still findable once the WeakRef hint is gone (SPA re-render, second
    // visit): the pink outline is enough to identify it.
    forgetCoverTargets();
    expect(resolveCoverTarget()).toBe(document.getElementById('dopis'));
  });
});

describe('describeMissingData', () => {
  it('says nothing when nothing is missing', () => {
    expect(describeMissingData([])).toBe('');
  });

  it('offers both exits for a missing cover letter', () => {
    const text = describeMissingData(['coverLetter']);
    expect(text).toContain('settings');
    expect(text).toContain('generate');
  });

  it('names a single missing profile field in the singular', () => {
    expect(describeMissingData(['phone'])).toBe(
      'Your profile has no phone — add it in JobFill settings.',
    );
  });

  it('joins two missing profile fields', () => {
    expect(describeMissingData(['email', 'phone'])).toContain('email and phone');
  });

  it('joins three with a comma and an "and"', () => {
    expect(describeMissingData(['email', 'phone', 'city'])).toContain('email, phone and city');
  });

  it('stops naming after three and counts the rest', () => {
    const text = describeMissingData(['email', 'phone', 'city', 'github', 'website']);
    expect(text).toContain('email, phone, city and 2 more');
  });

  it('covers both halves when the letter and the profile are both empty', () => {
    const text = describeMissingData(['coverLetter', 'email']);
    expect(text).toContain('cover letter template');
    expect(text).toContain('Your profile has no email');
  });

  it('de-duplicates repeated field types', () => {
    expect(describeMissingData(['email', 'email'])).toContain('no email —');
  });

  it('drops a field type it has no human name for, rather than printing it raw', () => {
    expect(describeMissingData(['someInternalType'])).toBe('');
    expect(describeMissingData(['someInternalType', 'phone'])).toBe(
      'Your profile has no phone — add it in JobFill settings.',
    );
  });

  it('splits the two kinds of missing data apart', () => {
    expect(splitMissingData(['coverLetter', 'phone', 'phone'])).toEqual({
      coverLetter: true,
      profileFields: ['phone'],
    });
  });
});

/**
 * A control the heuristics genuinely cannot name — the subject every test below
 * needs, since a field the matcher *can* name never reaches the LLM pass at all.
 *
 * It used to be "Preferred name", which stopped being opaque once the scorer
 * learned to trust a visible label on its own: the heuristics started filling it
 * and this whole block quietly lost its subject. This label sits outside every
 * dictionary rule and the only other signal is an opaque automation id, so the
 * first test asserts the fixture is still unnameable rather than trusting it.
 */
const OPAQUE_LABEL = 'Widget identifier';
const OPAQUE_FIELD = field('op', OPAQUE_LABEL, '<input id="op" data-automation-id="a7f3c91e" />');

describe('classifyUnresolvedFields', () => {
  it('the opaque fixture really is unnameable by the heuristics', () => {
    render(`<form>${OPAQUE_FIELD}</form>`);
    const s = fillPage(PROFILE);
    expect(s.unrecognized).toBe(1);
    expect(valueOf('op')).toBe('');
  });

  afterEach(() => {
    removeAllHighlights();
    forgetCoverTargets();
    document.body.innerHTML = '';
  });

  /** Run the heuristic pass and keep what it could not name — as content.ts does. */
  function unresolvedAfterFill(profile: Profile = PROFILE, opts: FillOptions = {}): FieldFingerprint[] {
    const candidates: FieldFingerprint[] = [];
    fillPage(profile, { ...opts, onUnresolved: (fp) => candidates.push(fp) });
    return candidates;
  }

  function transportOf(answer: Record<string, string>) {
    return vi.fn(async (payload: string[]) => {
      void payload;
      return answer;
    });
  }

  function classes(id: string): string {
    return document.getElementById(id)!.className;
  }

  // ── Candidate selection: only what the heuristics failed on ──

  it('classifies only the fields left at low / none', () => {
    render(
      '<form>' +
        // recognised and filled — settled, not a candidate
        field('fn', 'First name', '<input id="fn" name="first_name" />') +
        // recognised, but this profile has no city — settled too, as `noData`:
        // asking the model to name it again cannot produce a value we lack
        field('cty', 'City', '<input id="cty" name="city" />') +
        // an open question — belongs to the AI *answering* path, not to this one
        field('q1', 'Why do you want to work here?', '<textarea id="q1" name="q_1"></textarea>') +
        // opaque: no signal any dictionary rule matches
        OPAQUE_FIELD +
        // an outright near-tie the scorer downgraded to low
        field('amb', 'GitHub / LinkedIn', '<input id="amb" name="github_linkedin" />') +
        '</form>',
    );

    const candidates = unresolvedAfterFill({ ...PROFILE, city: '' });

    expect(candidates.map((fp) => fp.element.id).sort()).toEqual(['amb', 'op']);
  });

  // ── The opt-in ──

  it('sends nothing at all while the setting is off', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');
    const classify = transportOf({ '0': 'firstName' });

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: false,
      classify,
    });

    expect(classify).not.toHaveBeenCalled();
    expect(result).toEqual({ filled: 0, sent: 0, confidence: 'medium' });
    expect(valueOf('op')).toBe('');
  });

  it('is off for the settings a fresh install ships with', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');
    const classify = transportOf({ '0': 'firstName' });

    await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: DEFAULT_SETTINGS.llmFieldClassification,
      classify,
    });

    expect(classify).not.toHaveBeenCalled();
  });

  it('sends nothing when there is nothing left to classify', async () => {
    render('<form>' + field('fn', 'First name', '<input id="fn" name="first_name" />') + '</form>');
    const classify = transportOf({ '0': 'email' });

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify,
    });

    expect(classify).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });

  // ── The medium ceiling ──

  it('fills a classified field and highlights it medium — never high', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '0': 'firstName' }),
    });

    expect(valueOf('op')).toBe('Ada');
    expect(result).toEqual({ filled: 1, sent: 1, confidence: 'medium' });
    expect(classes('op')).toContain('__jobfill-medium');
    expect(classes('op')).not.toContain('__jobfill-high');
  });

  it('replaces the grey "unrecognised" outline with the amber "check this" one', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');
    const candidates = unresolvedAfterFill();
    expect(classes('op')).toContain('__jobfill-none');

    await classifyUnresolvedFields(PROFILE, candidates, {
      enabled: true,
      classify: transportOf({ '0': 'firstName' }),
      highlightDurationMs: 500,
    });

    expect(classes('op')).toBe('__jobfill-medium');
    expect(filler.activeHighlightCount()).toBe(1);
  });

  it('has no way to express a confidence other than medium', () => {
    // Compile-time half of the guarantee: `LlmFieldConfidence` has exactly one
    // inhabitant, and no LLM code path takes a confidence argument at all.
    // @ts-expect-error — 'high' is not assignable to LlmFieldConfidence
    const forbidden: LlmFieldConfidence = 'high';
    const allowed: LlmFieldConfidence = LLM_FIELD_CONFIDENCE;

    expect(forbidden).toBe('high'); // the value exists at runtime; the type does not
    expect(allowed).toBe('medium');
  });

  // ── Silent failure ──

  it('stays silent when the transport rejects (no key, no network, timeout)', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');
    const classify = vi.fn(async () => {
      throw new Error('Groq API key is not configured.');
    });

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify,
    });

    expect(result).toEqual({ filled: 0, sent: 1, confidence: 'medium' });
    expect(valueOf('op')).toBe('');
    expect(classes('op')).toContain('__jobfill-none'); // heuristic result untouched
  });

  it('stays silent when the worker answers with nothing usable', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: vi.fn(async () => undefined),
    });

    expect(result.filled).toBe(0);
    expect(valueOf('op')).toBe('');
  });

  it('ignores indices and keys that do not address the batch', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '7': 'firstName', notAnIndex: 'email', '-1': 'phone' }),
    });

    expect(result.filled).toBe(0);
    expect(valueOf('op')).toBe('');
  });

  it('ignores a field type the profile has nothing for', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');

    const result = await classifyUnresolvedFields({ ...PROFILE, github: '' }, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '0': 'github' }),
    });

    expect(result.filled).toBe(0);
    expect(valueOf('op')).toBe('');
  });

  it('ignores a field type that does not exist at all', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');

    // The API client drops unknown types before this point; if one ever slipped
    // through, it resolves to no value and therefore writes nothing.
    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '0': 'socialSecurityNumber' }),
    });

    expect(result.filled).toBe(0);
    expect(valueOf('op')).toBe('');
  });

  /**
   * The composition case is exactly the one the model is useful for: a label the
   * dictionary has no rule for, whose answer is two atoms joined. An answer that
   * is a *template* is resolved here, in the page, against a profile the model
   * never saw — it named `lastName` and `firstName`, not Ada Lovelace.
   */
  it('resolves an answer that is a template, not a field type', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '0': '{lastName}, {firstName}' }),
    });

    expect(result.filled).toBe(1);
    expect(valueOf('op')).toBe('Lovelace, Ada');
    expect(classes('op')).toContain('__jobfill-medium');
  });

  it('writes nothing for a template whose atoms the profile does not hold', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');

    const result = await classifyUnresolvedFields(
      { ...PROFILE, firstName: '', lastName: '' },
      unresolvedAfterFill(),
      { enabled: true, classify: transportOf({ '0': '{firstName} {lastName}' }) },
    );

    expect(result.filled).toBe(0);
    expect(valueOf('op')).toBe('');
  });

  it('remembers a cover-letter target whether the answer was a type or a template', async () => {
    render('<form><textarea id="op" name="a7f3c91e"></textarea></form>');

    await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '0': '{coverLetter}' }),
      coverLetterText: 'Dear Acme,',
    });

    expect(valueOf('op')).toBe('Dear Acme,');
    // Cleared so the answer cannot come from the highlight classes: what is left
    // is the remembered target itself.
    removeAllHighlights();
    expect(resolveCoverTarget()).toBe(document.getElementById('op'));
  });

  // ── The page moved on while the request was in flight ──

  it('never overwrites what the user typed while the request was in flight', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');
    const candidates = unresolvedAfterFill();

    const result = await classifyUnresolvedFields(PROFILE, candidates, {
      enabled: true,
      classify: vi.fn(async () => {
        (document.getElementById('op') as HTMLInputElement).value = 'typed by hand';
        return { '0': 'firstName' };
      }),
    });

    expect(valueOf('op')).toBe('typed by hand');
    expect(result.filled).toBe(0);
  });

  it('skips a control that has left the DOM', async () => {
    render('<form>' + OPAQUE_FIELD + '</form>');
    const candidates = unresolvedAfterFill();

    const result = await classifyUnresolvedFields(PROFILE, candidates, {
      enabled: true,
      classify: vi.fn(async () => {
        document.getElementById('op')!.remove();
        return { '0': 'firstName' };
      }),
    });

    expect(result.filled).toBe(0);
  });

  // ── Defence in depth: the model does not get to override this ──

  it('refuses a credential field even when the model calls it a name field', async () => {
    render('<form><input id="pw" type="text" name="account" aria-label="Password" /></form>');
    const el = document.getElementById('pw') as HTMLInputElement;

    const result = await classifyUnresolvedFields(PROFILE, [buildFingerprint(el)], {
      enabled: true,
      classify: transportOf({ '0': 'fullName' }),
    });

    expect(el.value).toBe('');
    expect(result.filled).toBe(0);
  });

  it('refuses anything inside a login form', async () => {
    render(
      '<form id="login">' +
        '<input id="lu" name="account" />' +
        '<input type="password" name="password" />' +
        '</form>',
    );
    const el = document.getElementById('lu') as HTMLInputElement;

    const result = await classifyUnresolvedFields(PROFILE, [buildFingerprint(el)], {
      enabled: true,
      classify: transportOf({ '0': 'email' }),
    });

    expect(el.value).toBe('');
    expect(result.filled).toBe(0);
  });

  // ── Control types ──

  it('fills a classified <select> and skips one with no matching option', async () => {
    render(
      '<form>' +
        field('wp', 'Status', '<select id="wp" data-automation-id="b91"><option>— pick —</option><option>Yes</option></select>') +
        field('zz', 'Category', '<select id="zz" data-automation-id="c22"><option>— pick —</option><option>Alpha</option></select>') +
        '</form>',
    );

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '0': 'workPermit', '1': 'workPermit' }),
    });

    expect((document.getElementById('wp') as HTMLSelectElement).value).toBe('Yes');
    expect((document.getElementById('zz') as HTMLSelectElement).selectedIndex).toBe(0);
    expect(result.filled).toBe(1);
    expect(classes('wp')).toContain('__jobfill-medium');
  });

  it('leaves a <select> the user already answered alone', async () => {
    render(
      '<form>' +
        field('wp', 'Status', '<select id="wp" data-automation-id="b91"><option>— pick —</option><option>No</option><option>Yes</option></select>') +
        '</form>',
    );
    const candidates = unresolvedAfterFill();
    (document.getElementById('wp') as HTMLSelectElement).selectedIndex = 1;

    const result = await classifyUnresolvedFields(PROFILE, candidates, {
      enabled: true,
      classify: transportOf({ '0': 'workPermit' }),
    });

    expect((document.getElementById('wp') as HTMLSelectElement).value).toBe('No');
    expect(result.filled).toBe(0);
  });

  it('remembers a cover-letter field the model identified (P1-12)', async () => {
    render('<form>' + field('cl', 'Your message', '<textarea id="cl" data-automation-id="d40"></textarea>') + '</form>');

    const result = await classifyUnresolvedFields(PROFILE, unresolvedAfterFill(), {
      enabled: true,
      classify: transportOf({ '0': 'coverLetter' }),
      coverLetterText: 'Dear Acme,',
    });

    expect(valueOf('cl')).toBe('Dear Acme,');
    expect(result.filled).toBe(1);
    expect(resolveCoverTarget()).toBe(document.getElementById('cl'));
  });

  // ── Volume ──

  it('never puts more than MAX_CLASSIFY_FIELDS fingerprints on the wire', async () => {
    const many = Array.from(
      { length: MAX_CLASSIFY_FIELDS + 25 },
      (_, i) => field(`u${i}`, `Question ${i}`, `<input id="u${i}" data-automation-id="op_${i}" />`),
    );
    render(`<form>${many.join('')}</form>`);
    const candidates = unresolvedAfterFill();
    expect(candidates.length).toBe(MAX_CLASSIFY_FIELDS + 25);

    const classify = transportOf({});
    const result = await classifyUnresolvedFields(PROFILE, candidates, { enabled: true, classify });

    expect(classify.mock.calls[0][0]).toHaveLength(MAX_CLASSIFY_FIELDS);
    expect(result.sent).toBe(MAX_CLASSIFY_FIELDS);
  });

  it('puts field fingerprints on the wire and nothing else (S-3)', async () => {
    render(
      '<form>' +
        field('fn', 'First name', '<input id="fn" name="first_name" />') +
        field('em', 'Email', '<input id="em" name="email" autocomplete="email" />') +
        OPAQUE_FIELD +
        '</form>',
    );

    // The form is already filled with the profile, and the user has typed into
    // the field that is about to be classified — the worst case for a leak.
    const candidates = unresolvedAfterFill();
    expect(valueOf('fn')).toBe('Ada');
    (document.getElementById('op') as HTMLInputElement).value = 'Ada, privately';

    const classify = transportOf({});
    await classifyUnresolvedFields(PROFILE, candidates, { enabled: true, classify });

    const sent = (classify.mock.calls[0][0] as string[]).join('\n');
    for (const secret of Object.values(PROFILE)) {
      if (secret) expect(sent).not.toContain(secret);
    }
    expect(sent).not.toContain('privately');
    // …while the attributes that make classification possible are all there.
    expect(sent).toContain(OPAQUE_LABEL);
    expect(sent.split('\n')).toHaveLength(1); // only the unrecognised field
  });
});

// ─── The AI picking an option out of a dropdown ──────────────────────────────

/**
 * The form from the live run, in the shape that matters here: a category list
 * with no source in the profile, a legal declaration, an attestation, a consent,
 * and a long list that is answered from stored data instead.
 */
const PHONE_TYPE = field(
  'pt',
  'Phone Type',
  '<select id="pt" data-automation-id="phoneType"><option value="">Please Select</option>' +
    '<option>Mobile</option><option>Home</option><option>Work</option></select>',
);
const AGE_18 = field(
  'age',
  'Are you at least 18 years of age or older?',
  '<select id="age" data-automation-id="age18"><option value="">Please Select</option>' +
    '<option>Yes</option><option>No</option></select>',
);
const DRINKING_AGE = field(
  'drink',
  'Are you of required legal drinking age?',
  '<select id="drink" data-automation-id="drinkingAge"><option value="">Please Select</option>' +
    '<option>Yes</option><option>No</option></select>',
);
const RESUME_OK = field(
  'res',
  'Is your work experience and education included on your resume?',
  '<select id="res" data-automation-id="resumeComplete"><option value="">Please Select</option>' +
    '<option>Yes</option><option>No</option></select>',
);
const HR_CONTACT = field(
  'hr',
  'Human Resources may contact me regarding other positions',
  '<select id="hr" data-automation-id="hrContact"><option value="">Please Select</option>' +
    '<option>Yes</option><option>No</option></select>',
);

describe('the dropdowns of the live run, end to end', () => {
  const APPLICANT: Profile = createEmptyProfile({
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+420123456789',
    city: 'Praha',
    country: 'Czechia',
    preferredLanguage: 'Czech',
    education: 'Bachelor',
    workPermit: 'Yes',
  });

  const FORM =
    '<form>' +
    field(
      'country',
      'Country',
      '<select id="country" name="country"><option value="">Please Select</option>' +
        '<option>Austria</option><option>Czech Republic</option><option>Slovakia</option></select>',
    ) +
    field(
      'lang',
      'Preferred Language',
      '<select id="lang" name="preferredLanguage"><option value="">Please Select</option>' +
        '<option value="en">English</option><option value="cs">Čeština</option></select>',
    ) +
    field(
      'edu',
      'Please list your highest level of education achieved',
      '<select id="edu" name="education"><option value="">Please Select</option>' +
        "<option>High School</option><option>Bachelor's Degree</option><option>Master's Degree</option></select>",
    ) +
    AGE_18 +
    DRINKING_AGE +
    RESUME_OK +
    HR_CONTACT +
    PHONE_TYPE +
    '</form>';

  afterEach(() => {
    removeAllHighlights();
    document.body.innerHTML = '';
  });

  function selected(id: string): string {
    return (document.getElementById(id) as HTMLSelectElement).value;
  }

  /**
   * The half that needs no API key at all. Every one of these lists spells its
   * answer differently from the profile — `Czech Republic` for "Czechia",
   * `Čeština` for "Czech", `Bachelor's Degree` for "Bachelor" — which is why
   * they all sat on "Please Select" before.
   */
  it('answers the profile-backed lists from stored data alone', () => {
    render(FORM);
    fillPage(APPLICANT);

    expect(selected('country')).toBe('Czech Republic');
    expect(selected('lang')).toBe('cs');
    expect(selected('edu')).toBe("Bachelor's Degree");
  });

  /**
   * And the half that must stay empty. Four questions about the applicant, no
   * profile entry that answers any of them, and no model allowed to: they are
   * left exactly as the page had them, which is the correct outcome and not a
   * failure to try.
   */
  it('leaves every legal declaration on its placeholder, with the AI enabled', async () => {
    render(FORM);
    const unresolved: FieldFingerprint[] = [];
    fillPage(APPLICANT, { onUnresolved: (fp) => unresolved.push(fp) });

    // A model that answers every field it is sent, both ways: `{workPermit}`
    // resolves to "Yes" for this profile, and "Yes" is on every one of these
    // lists — so nothing but the rule stops it from being selected.
    await classifyUnresolvedFields(APPLICANT, unresolved, {
      enabled: true,
      classify: vi.fn(async () => ({
        '0': 'workPermit',
        '1': 'workPermit',
        '2': 'workPermit',
        '3': 'workPermit',
        '4': 'workPermit',
      })),
      chooseOptions: vi.fn(async () => ({ '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 })),
    });

    expect(selected('age')).toBe('');
    expect(selected('drink')).toBe('');
    expect(selected('res')).toBe('');
    expect(selected('hr')).toBe('');
    // The one category list with no source in the profile is the one it helped
    // with — amber, "check this".
    expect(selected('pt')).toBe('Mobile');
    expect(document.getElementById('pt')!.className).toBe('__jobfill-medium');
  });

  it('does not send a single one of those questions to the model', async () => {
    render(FORM);
    const unresolved: FieldFingerprint[] = [];
    fillPage(APPLICANT, { onUnresolved: (fp) => unresolved.push(fp) });

    const ask = vi.fn(async (selects: SelectQuestion[]) => {
      void selects;
      return {};
    });
    await classifyUnresolvedFields(APPLICANT, unresolved, {
      enabled: true,
      classify: vi.fn(async () => ({})),
      chooseOptions: ask,
    });

    const sent = JSON.stringify(ask.mock.calls[0][0]);
    expect(sent).toContain('Phone Type');
    for (const phrase of ['18 years', 'drinking age', 'resume', 'other positions']) {
      expect(sent).not.toContain(phrase);
    }
  });
});

describe('the AI choosing an option (the dropdowns of the live run)', () => {
  afterEach(() => {
    removeAllHighlights();
    forgetCoverTargets();
    document.body.innerHTML = '';
  });

  function candidates(profile: Profile = PROFILE): FieldFingerprint[] {
    const unresolved: FieldFingerprint[] = [];
    fillPage(profile, { onUnresolved: (fp) => unresolved.push(fp) });
    return unresolved;
  }

  /** Never answers; records what it was asked. */
  function silentAsk() {
    return vi.fn(async (selects: SelectQuestion[]) => {
      void selects;
      return {};
    });
  }

  function askOf(answer: Record<string, number>) {
    return vi.fn(async (selects: SelectQuestion[]) => {
      void selects;
      return answer;
    });
  }

  /** A fresh spy per use: the template half answers nothing in these tests. */
  const noTemplates = () => vi.fn(async () => ({}));

  function selected(id: string): string {
    return (document.getElementById(id) as HTMLSelectElement).value;
  }

  // ── The case the owner asked for ──

  it('fills a category list the profile has no source for', async () => {
    render(`<form>${PHONE_TYPE}</form>`);

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: askOf({ '0': 0 }),
    });

    expect(selected('pt')).toBe('Mobile');
    expect(result.filled).toBe(1);
    // Amber, like everything else the model touches: "check this", never green.
    expect(document.getElementById('pt')!.className).toBe('__jobfill-medium');
  });

  it('answers with the label the page offered, not with one the model invented', async () => {
    render(`<form>${PHONE_TYPE}</form>`);

    // A string answer is accepted, but only when it is one of the offered
    // labels — the model cannot spell an option into existence.
    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: vi.fn(async () => ({ '0': 5 })),
    });

    expect(selected('pt')).toBe('');
    expect(result.filled).toBe(0);
  });

  it('sends the option labels and nothing else about the page (S-3)', async () => {
    render(`<form>${PHONE_TYPE}</form>`);
    const ask = silentAsk();

    await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask).toHaveBeenCalledTimes(1);
    const [sent] = ask.mock.calls[0];
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual(['Mobile', 'Home', 'Work']);
    // The placeholder is not an answer and is not offered as one.
    expect(sent[0].options).not.toContain('Please Select');

    const body = JSON.stringify(sent);
    for (const secret of Object.values(PROFILE)) {
      if (secret) expect(body).not.toContain(secret);
    }
  });

  // ── The declarations. This is the part that must not be answerable ──

  it.each([
    ['an age question', AGE_18, 'age'],
    ['an attestation about the CV', RESUME_OK, 'res'],
    ['a consent to being contacted', HR_CONTACT, 'hr'],
  ])('never even asks about %s', async (_case, markup, id) => {
    render(`<form>${markup}${PHONE_TYPE}</form>`);
    const ask = silentAsk();

    await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    const sent = ask.mock.calls[0][0];
    const asked = JSON.stringify(sent);
    expect(asked).not.toContain(id === 'age' ? '18 years' : id === 'res' ? 'resume' : 'positions');
    expect(sent.every((s) => !s.options.includes('No'))).toBe(true);
    expect(selected(id)).toBe('');
  });

  /**
   * The guarantee stated as the model failing to get its way: it answers every
   * index it can think of, with both a number and a label, and the declarations
   * stay empty — because the only dropdown in the batch was `Phone Type`, so no
   * index addresses them at all.
   */
  it('ignores a model that answers the age question anyway', async () => {
    render(`<form>${AGE_18}${RESUME_OK}${HR_CONTACT}${PHONE_TYPE}</form>`);

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: vi.fn(async () => ({ '0': 0, '1': 0, '2': 0, '3': 0 })),
    });

    expect(selected('age')).toBe('');
    expect(selected('res')).toBe('');
    expect(selected('hr')).toBe('');
    // …while the one field it was allowed to answer was answered.
    expect(selected('pt')).toBe('Mobile');
    expect(result.filled).toBe(1);
  });

  it('never answers a yes/no list, whatever it is about', async () => {
    render(
      '<form>' +
        field(
          'rel',
          'Would you consider relocating?',
          '<select id="rel" data-automation-id="relocate"><option value="">Please Select</option>' +
            '<option>Yes</option><option>No</option></select>',
        ) +
        '</form>',
    );
    const ask = silentAsk();

    await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(selected('rel')).toBe('');
  });

  // ── The opt-in ──

  it('sends no option list at all while the setting is off', async () => {
    render(`<form>${PHONE_TYPE}</form>`);
    const ask = silentAsk();

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: false,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual({ filled: 0, sent: 0, confidence: 'medium' });
  });

  it('does nothing about dropdowns when no transport was passed', async () => {
    render(`<form>${PHONE_TYPE}</form>`);

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
    });

    expect(selected('pt')).toBe('');
    expect(result.filled).toBe(0);
  });

  it('asks nothing when the page has no dropdown it may ask about', async () => {
    render(`<form>${OPAQUE_FIELD}</form>`);
    const ask = silentAsk();

    await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask).not.toHaveBeenCalled();
  });

  // ── Silent failure, exactly like the template pass ──

  it('stays silent when the transport rejects (no key, no network, timeout)', async () => {
    render(`<form>${PHONE_TYPE}</form>`);

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: vi.fn(async () => {
        throw new Error('Groq API key is not configured.');
      }),
    });

    expect(result.filled).toBe(0);
    expect(selected('pt')).toBe('');
  });

  it('stays silent when the worker answers with nothing usable', async () => {
    render(`<form>${PHONE_TYPE}</form>`);

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: vi.fn(async () => undefined),
    });

    expect(result.filled).toBe(0);
    expect(selected('pt')).toBe('');
  });

  it('ignores keys that address no dropdown in the batch', async () => {
    render(`<form>${PHONE_TYPE}</form>`);

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: askOf({ '7': 0, '-1': 1 }),
    });

    expect(result.filled).toBe(0);
    expect(selected('pt')).toBe('');
  });

  // ── The page moved on while the request was in flight ──

  it('never overwrites a dropdown the user answered while the request was out', async () => {
    render(`<form>${PHONE_TYPE}</form>`);
    const asked = candidates();

    const result = await classifyUnresolvedFields(PROFILE, asked, {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: vi.fn(async () => {
        (document.getElementById('pt') as HTMLSelectElement).selectedIndex = 2;
        return { '0': 0 };
      }),
    });

    expect(selected('pt')).toBe('Home');
    expect(result.filled).toBe(0);
  });

  it('skips a dropdown that has left the DOM', async () => {
    render(`<form>${PHONE_TYPE}</form>`);
    const asked = candidates();

    const result = await classifyUnresolvedFields(PROFILE, asked, {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: vi.fn(async () => {
        document.getElementById('pt')!.remove();
        return { '0': 0 };
      }),
    });

    expect(result.filled).toBe(0);
  });

  it('writes nothing when the option it named is no longer on the page', async () => {
    render(`<form>${PHONE_TYPE}</form>`);
    const asked = candidates();

    const result = await classifyUnresolvedFields(PROFILE, asked, {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: vi.fn(async () => {
        const el = document.getElementById('pt') as HTMLSelectElement;
        el.innerHTML = '<option value="">Please Select</option><option>Landline</option>';
        return { '0': 0 };
      }),
    });

    expect(result.filled).toBe(0);
    expect(selected('pt')).toBe('');
  });

  // ── Which dropdowns are candidates at all ──

  it('never asks about a dropdown the profile already answered', async () => {
    render(
      '<form>' +
        field(
          'wp',
          'Work permit',
          '<select id="wp" name="work_permit"><option value="">Please Select</option>' +
            '<option>Yes</option><option>No</option></select>',
        ) +
        PHONE_TYPE +
        '</form>',
    );
    const ask = silentAsk();
    const asked = candidates();

    // `fillPage` answered the work-permit list from the profile before this pass
    // ever ran; only what is still on its placeholder is a candidate.
    expect(selected('wp')).toBe('Yes');

    await classifyUnresolvedFields(PROFILE, asked, {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask.mock.calls[0][0]).toHaveLength(1);
    expect(ask.mock.calls[0][0][0].options).toEqual(['Mobile', 'Home', 'Work']);
  });

  /**
   * `fillPage` never enumerates a control inside a sign-in form, so this can
   * only be reached by handing the fingerprint over directly — which is the
   * point: the check is defence in depth, and the test exercises it as such.
   */
  it('never asks about a dropdown inside a sign-in form', async () => {
    render(
      '<form id="login">' +
        '<input type="password" name="password" />' +
        field(
          'acc',
          'Account type',
          '<select id="acc" data-automation-id="accountType"><option value="">Please Select</option>' +
            '<option>Personal</option><option>Business</option></select>',
        ) +
        '</form>',
    );
    const ask = silentAsk();
    const el = document.getElementById('acc') as HTMLSelectElement;

    await classifyUnresolvedFields(PROFILE, [buildFingerprint(el)], {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(el.value).toBe('');
  });

  /**
   * The pass is started without being awaited, so seconds of the user's own
   * clicking happen between collecting the candidates and asking about them.
   * Anything they answered, or the page has since replaced, is left out of the
   * question entirely — not merely refused when the answer comes back.
   */
  it('never asks about a dropdown that stopped being a candidate meanwhile', async () => {
    render(
      `<form>${PHONE_TYPE}` +
        field(
          'src',
          'How did you hear about us?',
          '<select id="src" data-automation-id="source"><option value="">Please Select</option>' +
            '<option>Job board</option><option>Referral</option></select>',
        ) +
        '</form>',
    );
    const asked = candidates();
    expect(asked).toHaveLength(2);

    (document.getElementById('pt') as HTMLSelectElement).selectedIndex = 1; // answered by hand
    document.getElementById('src')!.remove(); // re-rendered away
    const ask = silentAsk();

    await classifyUnresolvedFields(PROFILE, asked, {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(selected('pt')).toBe('Mobile');
  });

  /**
   * A list with no placeholder, whose first entry happens to be the answer: it
   * reads as "still on its default" after being selected, so only the record of
   * what the first half wrote keeps the second half from asking about it — and
   * from replacing a value that came out of the profile with a guess.
   */
  it('never asks about a dropdown the first half of the pass just answered', async () => {
    render(
      '<form>' +
        field(
          'wp',
          'Status',
          '<select id="wp" data-automation-id="b91"><option>Yes</option><option>No</option></select>',
        ) +
        '</form>',
    );
    const ask = silentAsk();

    const result = await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: vi.fn(async () => ({ '0': 'workPermit' })),
      chooseOptions: ask,
    });

    expect(selected('wp')).toBe('Yes');
    expect(result.filled).toBe(1);
    expect(ask).not.toHaveBeenCalled();
  });

  it('never asks about a list that offers nothing but a placeholder', async () => {
    render(
      '<form>' +
        field(
          'empty',
          'Team',
          '<select id="empty" data-automation-id="team"><option value="">Please Select</option></select>',
        ) +
        '</form>',
    );
    const ask = silentAsk();

    await classifyUnresolvedFields(PROFILE, candidates(), {
      enabled: true,
      classify: noTemplates(),
      chooseOptions: ask,
    });

    expect(ask).not.toHaveBeenCalled();
  });

  /**
   * The dropdown that started this: recognised by the heuristics, filled with a
   * phone *number*, and left on "Please Select" because a number is not one of
   * Mobile / Home / Work. Recognised-but-unfillable is still unfilled, so it
   * reaches the second pass.
   */
  it('reaches the second pass even when the heuristics claimed the field', async () => {
    render(`<form>${PHONE_TYPE}</form>`);
    const summary = fillPage(PROFILE);

    expect(selected('pt')).toBe('');
    expect(summary.unrecognized).toBe(1);
    expect(candidates().map((fp) => fp.element.id)).toEqual(['pt']);
  });
});

describe('shared/filler barrel', () => {
  it('exposes exactly the documented surface', () => {
    expect(Object.keys(filler).sort()).toEqual([
      'ANY_SHAPE',
      'COVER_LETTER_FIELD',
      'DEFAULT_TEMPLATES',
      'DERIVED_VALUE_KEYS',
      'LLM_FIELD_CONFIDENCE',
      'MISSING_DATA_LABELS',
      'PROFILE_VALUE_KEYS',
      'TEMPLATE_VALUE_KEYS',
      'VARIANTS',
      'activeHighlightCount',
      'classifyUnresolvedFields',
      'countFillableControls',
      'describeField',
      'describeMissingData',
      'fillPage',
      'fillSelect',
      'forgetCoverTargets',
      'hasFillableControls',
      'highlightField',
      'isFillableControl',
      'isInlineButtonAnchor',
      'isInsideAuthForm',
      'isProfileValueKey',
      'isSensitiveControl',
      'isTemplateValueKey',
      'looksLikeAuthPage',
      'rememberFocusedField',
      'rememberRecognizedCoverField',
      'removeAllHighlights',
      'removeStyles',
      'resolveAnswer',
      'resolveCoverTarget',
      'resolveFieldType',
      'resolveTemplate',
      'selectTemplate',
      'setNativeValue',
      'splitMissingData',
    ]);
  });

  it('re-exports working implementations', () => {
    const el = document.createElement('input');
    filler.setNativeValue(el, 'Ada');
    expect(el.value).toBe('Ada');
    expect(filler.isSensitiveControl(Object.assign(document.createElement('input'), { type: 'password' }))).toBe(
      true,
    );
  });
});
