import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setNativeValue } from '../shared/filler/setNativeValue';
import { fillSelect } from '../shared/filler/selectStrategy';
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
import { MAX_CLASSIFY_FIELDS } from '../shared/messages';
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
