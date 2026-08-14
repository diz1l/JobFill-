import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildClassificationBatch,
  buildFingerprint,
  enumerateFillable,
  extractSemanticName,
  normalize,
  serializeFingerprint,
  type FieldFingerprint,
  type FillableElement,
} from '../shared/field-matcher/fingerprint';
import { MAX_CLASSIFY_FIELDS } from '../shared/messages';
import { scoreField, MIN_MARGIN, MEDIUM_THRESHOLD } from '../shared/field-matcher/scorer';
import { FIELD_RULES } from '../shared/field-matcher/dictionary';
import * as fieldMatcher from '../shared/field-matcher';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadFixture(name: string): Document {
  const html = readFileSync(resolve(__dirname, `fixtures/${name}.html`), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mount a markup fragment in the live document and return its first control */
function mount(html: string): FillableElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  const el = host.querySelector<FillableElement>('input,textarea,select');
  if (!el) throw new Error('fixture fragment contains no control');
  return el;
}

/** What the filler would actually do: high/medium is written, everything else is not */
function fills(html: string): string | null {
  const match = scoreField(buildFingerprint(mount(html)));
  if (!match) return null;
  return match.confidence === 'high' || match.confidence === 'medium' ? match.fieldType : null;
}

/** Classification regardless of confidence */
function classify(html: string) {
  return scoreField(buildFingerprint(mount(html)));
}

/** `<label>` + `<input>` pair, the shape most ATS forms boil down to */
function labelled(label: string, attrs: string): string {
  return `<label for="f">${label}</label><input id="f" ${attrs} />`;
}

afterEach(() => {
  document.body.innerHTML = '';
});

// ─── Public API surface ───────────────────────────────────────────────────────

describe('barrel exports', () => {
  it('exposes the engine through shared/field-matcher', () => {
    expect(Object.keys(fieldMatcher).sort()).toEqual([
      'FIELD_RULES',
      'HIGH_THRESHOLD',
      'MEDIUM_THRESHOLD',
      'MIN_MARGIN',
      'buildClassificationBatch',
      'buildFingerprint',
      'enumerateFillable',
      'extractSemanticName',
      'normalize',
      'scoreField',
      'serializeFingerprint',
    ]);
  });

  it('re-exports working implementations', () => {
    const el = mount('<label for="f">First Name</label><input id="f" name="first_name" />');
    expect(fieldMatcher.scoreField(fieldMatcher.buildFingerprint(el))?.fieldType).toBe('firstName');
    expect(fieldMatcher.MIN_MARGIN).toBe(MIN_MARGIN);
  });
});

// ─── Scorer unit tests ────────────────────────────────────────────────────────

describe('scoreField', () => {
  it('matches first name via autocomplete=given-name', () => {
    const input = document.createElement('input');
    input.setAttribute('autocomplete', 'given-name');
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('firstName');
    expect(match?.confidence).toBe('high');
  });

  it('matches email via autocomplete=email', () => {
    const input = document.createElement('input');
    input.setAttribute('autocomplete', 'email');
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('email');
    expect(match?.confidence).toBe('high');
  });

  it('matches Czech first name via label text', () => {
    const label = document.createElement('label');
    label.textContent = 'Křestní jméno';
    const input = document.createElement('input');
    input.id = 'krestni';
    label.setAttribute('for', 'krestni');
    document.body.appendChild(label);
    document.body.appendChild(input);

    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('firstName');
  });

  it('matches Czech last name via name attribute', () => {
    const input = document.createElement('input');
    input.setAttribute('name', 'prijmeni');
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('lastName');
  });

  it('matches phone via name attribute', () => {
    const input = document.createElement('input');
    input.setAttribute('name', 'phone_number');
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('phone');
  });

  it('matches LinkedIn via placeholder', () => {
    const input = document.createElement('input');
    input.setAttribute('placeholder', 'https://linkedin.com/in/...');
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('linkedin');
  });

  it('matches GitHub via id', () => {
    const input = document.createElement('input');
    input.id = 'github_url';
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('github');
  });

  it('matches cover letter via name', () => {
    const textarea = document.createElement('textarea');
    textarea.setAttribute('name', 'cover_letter');
    const fp = buildFingerprint(textarea);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('coverLetter');
  });

  it('matches Czech cover letter via placeholder', () => {
    const textarea = document.createElement('textarea');
    textarea.setAttribute('placeholder', 'Průvodní dopis...');
    const fp = buildFingerprint(textarea);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('coverLetter');
  });

  it('matches salary via Czech label', () => {
    const input = document.createElement('input');
    input.setAttribute('name', 'mzda_ocekavani');
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('salary');
  });

  it('returns null for unrecognised field', () => {
    const input = document.createElement('input');
    input.setAttribute('name', 'some_unknown_field_xyz');
    const fp = buildFingerprint(input);
    const match = scoreField(fp);
    expect(match).toBeNull();
  });

  it('scores an aria-describedby hint as a weak extra signal', () => {
    const withHint = classify(
      `<input name="q_1" aria-label="Number" aria-describedby="h" /><span id="h">Your phone number</span>`,
    );
    expect(withHint?.fieldType).toBe('phone');
  });
});

// ─── P1-1: `fullName` false positives ────────────────────────────────────────

describe('fullName — regression: must not swallow every field containing "name"', () => {
  const traps: [string, string][] = [
    ['Company name', 'name="company_name"'],
    ['Company Name', 'name="companyName"'],
    ['Organisation name', 'name="organisation_name"'],
    ['Employer name', 'name="employer_name"'],
    ['Referral name', 'name="referral_name"'],
    ['Reference name', 'name="reference_name"'],
    ['Manager name', 'name="manager_name"'],
    ['Emergency contact name', 'name="emergency_contact_name"'],
    ['File name', 'name="file_name"'],
    ['Project name', 'name="project_name"'],
    ['School name', 'name="school_name"'],
    ['Username', 'name="username"'],
    ['Display name', 'name="display_name"'],
    ['Name of the company', 'name="name_of_company"'],
    ['Pet name', 'name="pet_name"'],
  ];

  for (const [label, attrs] of traps) {
    it(`"${label}" is never filled with the candidate's name`, () => {
      expect(fills(labelled(label, attrs))).not.toBe('fullName');
    });
  }

  it('a bare "Company name" label alone is enough to disqualify the rule', () => {
    // No name/id signal at all — the label is the only evidence, and it is negative
    expect(fills('<label for="f">Company name</label><input id="f" />')).toBeNull();
  });

  const positives: [string, string][] = [
    ['Full name', 'name="name"'],
    ['Name', 'name="name"'],
    ['Your name', 'name="your_name"'],
    ['Legal name', 'name="legal_name"'],
    ['Candidate name', 'name="candidate_name"'],
    ['Celé jméno', 'name="cele_jmeno"'],
    ['Jméno a příjmení', 'name="jmeno_prijmeni"'],
  ];

  for (const [label, attrs] of positives) {
    it(`"${label}" is still recognised as fullName`, () => {
      expect(fills(labelled(label, attrs))).toBe('fullName');
    });
  }

  it('Lever\'s bare name="name" still resolves to fullName', () => {
    expect(fills('<label>Full name<input type="text" name="name" /></label>')).toBe('fullName');
  });

  it('"First name" goes to firstName, not fullName', () => {
    expect(fills(labelled('First Name', 'name="first_name"'))).toBe('firstName');
  });

  it('"Křestní jméno" does not leak into fullName', () => {
    expect(fills(labelled('Křestní jméno', 'name="krestni_jmeno"'))).toBe('firstName');
  });

  it('an organisation prefix does not disqualify firstName — a company has no first name', () => {
    expect(fills(labelled('First Name', 'name="user_first_name"'))).toBe('firstName');
  });

  it('"Emergency contact first name" is somebody else\'s first name', () => {
    expect(fills(labelled('Emergency contact first name', 'name="emergency_contact_first_name"'))).toBeNull();
  });

  it('"Reference last name" is somebody else\'s last name', () => {
    expect(fills(labelled('Reference last name', 'name="reference_last_name"'))).toBeNull();
  });
});

// ─── P1-2: `city` matching `location` ────────────────────────────────────────

describe('city — regression: "Location" must not be treated as the home town', () => {
  it('a bare Location filter on a job board is not filled', () => {
    expect(fills('<input name="location" id="location" aria-label="Location" />')).toBeNull();
  });

  it('a Location filter with a label is still not filled', () => {
    expect(fills(labelled('Location', 'name="location"'))).toBeNull();
  });

  it('a search-role Location field is not classified at all', () => {
    const el = mount(
      '<form role="search"><input name="location" aria-label="City, state, or zip code" /></form>',
    );
    expect(buildFingerprint(el).isSearchContext).toBe(true);
    expect(scoreField(buildFingerprint(el))).toBeNull();
  });

  it('type=search is treated as search context', () => {
    const el = mount('<input type="search" name="city" aria-label="City" />');
    expect(buildFingerprint(el).isSearchContext).toBe(true);
  });

  it('role=searchbox is treated as search context', () => {
    const el = mount('<input role="searchbox" name="city" />');
    expect(buildFingerprint(el).isSearchContext).toBe(true);
  });

  const traps = ['Job location', 'Office location', 'Work location', 'Position location'];
  for (const label of traps) {
    it(`"${label}" is not the candidate's city`, () => {
      const attr = `name="${label.toLowerCase().replace(' ', '_')}"`;
      expect(fills(labelled(label, attr))).toBeNull();
    });
  }

  const positives: [string, string][] = [
    ['City', 'name="city"'],
    ['Město', 'name="mesto"'],
    ['Current location', 'name="current_location"'],
    ['Home location', 'name="home_location"'],
    ['Bydliště', 'name="bydliste"'],
  ];
  for (const [label, attrs] of positives) {
    it(`"${label}" is still recognised as city`, () => {
      expect(fills(labelled(label, attrs))).toBe('city');
    });
  }

  it('Greenhouse "Location (City)" still fills — location plus a real city token', () => {
    expect(
      fills(
        '<label for="f">Location (City)</label><input id="f" name="job_application[location]" placeholder="City, Country" />',
      ),
    ).toBe('city');
  });

  it('"location" alone stays below the fill threshold even with four sources', () => {
    const match = classify(
      '<label for="f">Location</label><input id="f" name="location" aria-label="Location" />',
    );
    expect(match?.fieldType).toBe('city');
    expect(match!.score).toBeLessThan(MEDIUM_THRESHOLD);
    expect(match?.confidence).toBe('low');
  });

  it('an email address field is not mistaken for a city (the old rule matched "adresa")', () => {
    expect(fills(labelled('E-mailová adresa', 'name="email_adresa"'))).toBe('email');
  });
});

// ─── Remaining dictionary traps ──────────────────────────────────────────────

describe('dictionary — other false positives found while auditing all 14 rules', () => {
  it('"About this job" is not the candidate\'s bio', () => {
    expect(fills('<label for="f">About this job</label><textarea id="f" name="about_job"></textarea>')).toBeNull();
  });

  it('"About the company" is not the candidate\'s bio', () => {
    expect(fills('<label for="f">About the company</label><textarea id="f" name="about_company"></textarea>')).toBeNull();
  });

  it('"Order summary" is not the candidate\'s bio', () => {
    expect(fills(labelled('Order summary', 'name="order_summary"'))).toBeNull();
  });

  it('"About you" is still the candidate\'s bio', () => {
    expect(fills('<label for="f">About you</label><textarea id="f" name="about"></textarea>')).toBe('about');
  });

  it('"Professional summary" is still the candidate\'s bio', () => {
    expect(fills('<label for="f">Professional summary</label><textarea id="f" name="summary"></textarea>')).toBe('about');
  });

  it('"LinkedIn profile" is a link, not an "about" text (the old profil[.\\s_-] rule)', () => {
    expect(fills(labelled('LinkedIn profil', 'name="linkedin_profil"'))).toBe('linkedin');
  });

  it('"Project start date" is not the candidate\'s availability', () => {
    expect(fills(labelled('Project start date', 'name="project_start_date"'))).toBeNull();
  });

  it('"Education end date" is not the candidate\'s availability', () => {
    expect(fills(labelled('Education end date', 'name="education_end_date"'))).toBeNull();
  });

  it('"Start date" is still availability', () => {
    expect(fills(labelled('Start date', 'name="start_date"'))).toBe('availability');
  });

  it('"Notice period" is still availability', () => {
    expect(fills(labelled('Notice period', 'name="notice_period"'))).toBe('availability');
  });

  const phoneTraps = ['Hotel', 'Telegram', 'Intel experience'];
  for (const label of phoneTraps) {
    it(`"${label}" does not match the phone rule (old /tel(?!l)/ did)`, () => {
      const attr = `name="${label.toLowerCase().split(' ')[0]}"`;
      expect(fills(labelled(label, attr))).not.toBe('phone');
    });
  }

  it('"Mobilní telefon" is still a phone', () => {
    expect(fills(labelled('Mobilní telefon', 'name="mobilni_telefon"'))).toBe('phone');
  });

  it('id="tel" is still a phone', () => {
    expect(fills('<label for="tel">Telefon</label><input id="tel" name="tel" />')).toBe('phone');
  });

  it('"Company website" is not the candidate\'s website', () => {
    expect(fills(labelled('Company website', 'name="company_website"'))).toBeNull();
  });

  it('"Portfolio" is still the candidate\'s website', () => {
    expect(fills(labelled('Portfolio', 'name="portfolio_url"'))).toBe('website');
  });

  it('"Platforma" is not a salary (old /plat[.\\s_-]/ was already close)', () => {
    expect(fills(labelled('Platforma', 'name="platform"'))).toBeNull();
  });

  it('"Platové očekávání" is a salary', () => {
    expect(fills(labelled('Platové očekávání', 'name="platove_ocekavani"'))).toBe('salary');
  });

  it('"Mzdové očekávání" is a salary', () => {
    expect(fills(labelled('Mzdové očekávání', 'name="mzdove_ocekavani"'))).toBe('salary');
  });

  it('"What motivates you about this role?" is not a cover letter slot', () => {
    expect(
      fills('<label for="f">What motivates you about this role?</label><textarea id="f" name="motivation"></textarea>'),
    ).not.toBe('coverLetter');
  });

  it('"Motivation" next to a letter field is still a cover letter', () => {
    expect(fills('<label for="f">Motivation</label><textarea id="f" name="motivation_letter"></textarea>')).toBe(
      'coverLetter',
    );
  });

  it('"Referral email" never receives the candidate\'s email', () => {
    expect(fills(labelled('Referral email', 'name="referral_email"'))).toBeNull();
  });

  it('"Emergency contact phone" never receives the candidate\'s phone', () => {
    expect(fills(labelled('Emergency contact phone', 'name="emergency_contact_phone"'))).toBeNull();
  });

  it('"Newsletter" email is not filled', () => {
    expect(fills(labelled('Get new jobs by email', 'name="newsletter_email"'))).toBeNull();
  });

  it('"Do you require visa sponsorship?" is a work permit question', () => {
    expect(fills(labelled('Do you require visa sponsorship?', 'name="visa_sponsorship"'))).toBe('workPermit');
  });

  it('a credit card field does not match the visa rule', () => {
    expect(fills(labelled('Credit card type (Visa/Mastercard)', 'name="credit_card_type"'))).toBeNull();
  });

  it('every rule regex is anchored enough not to match an empty-ish token', () => {
    for (const rule of FIELD_RULES) {
      expect(rule.pattern.test(''), `${rule.type} matched an empty string`).toBe(false);
    }
  });
});

// ─── P1-3: near-tie protection ───────────────────────────────────────────────

describe('scorer — margin over the runner-up (P1-3)', () => {
  it('exposes the margin so callers can reason about it', () => {
    expect(MIN_MARGIN).toBe(15);
  });

  it('an ambiguous "Website or LinkedIn URL" field is not filled', () => {
    const match = classify(labelled('Website or LinkedIn URL', 'name="link"'));
    expect(match).not.toBeNull();
    expect(match?.confidence).toBe('low');
  });

  it('a photo finish is downgraded even when the raw score would be high', () => {
    // github and linkedin both score name(30) + semantic(25) + label(20) = 75
    const match = classify(labelled('GitHub / LinkedIn', 'name="github_linkedin"'));
    expect(match!.score).toBeGreaterThanOrEqual(70);
    expect(match?.confidence).toBe('low');
  });

  it('a clear winner keeps its confidence', () => {
    const match = classify(labelled('First Name', 'name="first_name" autocomplete="given-name"'));
    expect(match?.fieldType).toBe('firstName');
    expect(match?.confidence).toBe('high');
  });

  it('the winner must lead by at least MIN_MARGIN', () => {
    // aria-label "Name" → fullName 20, placeholder "City" → city 15: lead of 5
    const match = classify('<input name="f1" aria-label="Name" placeholder="City" />');
    expect(match?.confidence).toBe('low');
  });

  it('a lead of exactly MIN_MARGIN is enough', () => {
    // label "Cover letter" → coverLetter 20+10(heading); placeholder "linkedin.com" → linkedin 15
    const match = classify(
      '<label for="f">Cover letter</label><textarea id="f" name="cover_letter" placeholder="linkedin.com"></textarea>',
    );
    expect(match?.fieldType).toBe('coverLetter');
    expect(match?.confidence).toBe('high');
  });
});

// ─── P1-6: open-ended questions ──────────────────────────────────────────────

describe('open question detection (P1-6)', () => {
  it('finds a question kept in a sibling div instead of a label', () => {
    expect(classify('<div>Why do you want to work here?</div><textarea name="q_12345"></textarea>')?.fieldType).toBe(
      'openQuestion',
    );
  });

  it('finds a question in aria-label', () => {
    expect(
      classify('<textarea name="q_1" aria-label="Tell us about your experience with React"></textarea>')?.fieldType,
    ).toBe('openQuestion');
  });

  it('finds a question in the placeholder', () => {
    expect(classify('<textarea name="q_1" placeholder="What makes you a great fit?"></textarea>')?.fieldType).toBe(
      'openQuestion',
    );
  });

  it('accepts a short question that ends with a question mark', () => {
    expect(classify('<textarea name="q_1" aria-label="Why us?"></textarea>')?.fieldType).toBe('openQuestion');
  });

  it('accepts a question on a plain text input, not just a textarea', () => {
    expect(classify(labelled('What is your greatest achievement?', 'name="q_9"'))?.fieldType).toBe('openQuestion');
  });

  it('recognises a Czech question', () => {
    expect(classify('<textarea name="q_1" aria-label="Proč chcete pracovat u nás?"></textarea>')?.fieldType).toBe(
      'openQuestion',
    );
  });

  it('still accepts a long prompt without a question mark on a textarea', () => {
    expect(
      classify('<textarea name="q_1" aria-label="Tell us about a project you are proud of"></textarea>')?.fieldType,
    ).toBe('openQuestion');
  });

  it('does not hijack a field a dictionary rule already owns', () => {
    const match = classify(
      '<label for="f">Cover letter — what motivates you?</label><textarea id="f" name="cover_letter"></textarea>',
    );
    expect(match?.fieldType).toBe('coverLetter');
  });

  it('does not fire on a short non-question label', () => {
    expect(classify('<textarea name="q_1" aria-label="Notes"></textarea>')).toBeNull();
  });

  it('does not fire on a select', () => {
    expect(classify('<select name="q_1" aria-label="Do you have a work permit?"></select>')?.fieldType).not.toBe(
      'openQuestion',
    );
  });

  it('does not fire on an email input', () => {
    expect(
      classify('<input type="email" name="q_1" aria-label="Where should we send our questions?" />')?.fieldType,
    ).not.toBe('openQuestion');
  });
});

// ─── P1-5: aria-labelledby ───────────────────────────────────────────────────

describe('getLabelText / aria-labelledby (P1-5)', () => {
  it('collects text from a space separated ID list', () => {
    const el = mount(
      '<span id="lbl1">First Name</span><span id="lbl2">(required)</span>' +
        '<input name="input-9" aria-labelledby="lbl1 lbl2" />',
    );
    expect(buildFingerprint(el).labelText).toBe('First Name (required)');
  });

  it('still handles a single ID', () => {
    const el = mount('<span id="lbl1">Email Address</span><input name="x" aria-labelledby="lbl1" />');
    expect(buildFingerprint(el).labelText).toBe('Email Address');
  });

  it('ignores IDs that do not resolve', () => {
    const el = mount('<span id="lbl1">Phone</span><input name="x" aria-labelledby="missing lbl1 alsoMissing" />');
    expect(buildFingerprint(el).labelText).toBe('Phone');
  });

  it('falls back to label[for] when no referenced element exists', () => {
    const el = mount('<label for="f">City</label><input id="f" name="x" aria-labelledby="nope" />');
    expect(buildFingerprint(el).labelText).toBe('City');
  });

  it('a Workday-style two-ID label makes the field classifiable', () => {
    expect(
      fills(
        '<span id="l">First Name</span><span id="r">*</span><input name="input-9" data-automation-id="legalNameSection_firstName" aria-labelledby="l r" />',
      ),
    ).toBe('firstName');
  });

  it('joins several <label for> elements pointing at the same control', () => {
    const el = mount('<label for="f">Salary</label><label for="f">expectation</label><input id="f" />');
    expect(buildFingerprint(el).labelText).toBe('Salary expectation');
  });

  it('reads a wrapping label and strips the nested control', () => {
    const el = mount('<label>Full name <input type="text" name="name" /></label>');
    expect(buildFingerprint(el).labelText).toBe('Full name');
  });

  it('strips aria-hidden decorations from a wrapping label', () => {
    const el = mount(
      '<label><span>Email<span aria-hidden="true">✱</span></span><input type="email" name="email" /></label>',
    );
    expect(buildFingerprint(el).labelText).toBe('Email');
  });

  it('reads aria-describedby into the description field', () => {
    const el = mount('<input name="phone" aria-describedby="h1 h2" /><i id="h1">Include</i><i id="h2">country code</i>');
    expect(buildFingerprint(el).description).toBe('Include country code');
  });

  it('leaves the description empty when there is no aria-describedby', () => {
    expect(buildFingerprint(mount('<input name="x" />')).description).toBe('');
  });

  it('escapes ids that are not valid CSS identifiers', () => {
    const el = mount('<label for="a.b:c">Phone</label><input id="a.b:c" />');
    expect(buildFingerprint(el).labelText).toBe('Phone');
  });
});

// ─── P1-4: context heading ───────────────────────────────────────────────────

describe('getContextHeading (P1-4)', () => {
  it('picks up a real section heading', () => {
    const el = mount('<section><h2>Personal details</h2><div><input name="x" /></div></section>');
    expect(buildFingerprint(el).contextHeading).toBe('Personal details');
  });

  it('picks up a fieldset legend', () => {
    const el = mount('<fieldset><legend>Osobní údaje</legend><div><input name="x" /></div></fieldset>');
    expect(buildFingerprint(el).contextHeading).toBe('Osobní údaje');
  });

  it('picks up role=heading', () => {
    const el = mount('<div><div role="heading">Contact information</div><input name="x" /></div>');
    expect(buildFingerprint(el).contextHeading).toBe('Contact information');
  });

  it('accepts the label-like div immediately above the field', () => {
    const el = mount('<div class="field"><div class="label">Phone number</div><input name="q_1" /></div>');
    expect(buildFingerprint(el).contextHeading).toBe('Phone number');
  });

  it('accepts a label-like div one wrapper up', () => {
    const el = mount(
      '<div class="field"><div class="label">Phone number</div><div class="control"><input name="q_1" /></div></div>',
    );
    expect(buildFingerprint(el).contextHeading).toBe('Phone number');
  });

  it('does not reuse the neighbouring field\'s label', () => {
    mount(
      '<div class="row">' +
        '<div class="field"><label for="a">Company name</label><input id="a" name="company" /></div>' +
        '<div class="field"><label for="b">Full name</label><input id="b" name="name" /></div>' +
        '</div>',
    );
    const target = document.getElementById('b') as HTMLInputElement;
    expect(buildFingerprint(target).contextHeading).not.toMatch(/company/i);
  });

  it('does not repeat the label text as a heading', () => {
    const el = mount('<div><label for="f">First name</label><input id="f" name="first_name" /></div>');
    const fp = buildFingerprint(el);
    expect(fp.labelText).toBe('First name');
    expect(fp.contextHeading).toBe('');
  });

  it('ignores a <label for> belonging to another control', () => {
    const el = mount('<div><label for="other">Company name</label><input id="mine" name="q_1" /></div>');
    expect(buildFingerprint(el).contextHeading).toBe('');
  });

  it('ignores punctuation-only siblings', () => {
    const el = mount('<div><span>*</span><input name="q_1" /></div>');
    expect(buildFingerprint(el).contextHeading).toBe('');
  });

  it('ignores prose longer than a heading', () => {
    const long = 'x'.repeat(120);
    const el = mount(`<div><p>${long}</p><input name="q_1" /></div>`);
    expect(buildFingerprint(el).contextHeading).toBe('');
  });

  it('ignores a sibling block that contains its own control', () => {
    mount('<div><div><span>Company name</span><input name="company" /></div><input name="q_1" /></div>');
    const target = document.querySelector('input[name="q_1"]') as HTMLInputElement;
    expect(buildFingerprint(target).contextHeading).toBe('');
  });

  it('stops climbing after a bounded number of ancestors', () => {
    const deep = '<div>'.repeat(9) + '<input name="q_1" />' + '</div>'.repeat(9);
    const el = mount(`<section><h2>Far away heading</h2>${deep}</section>`);
    expect(buildFingerprint(el).contextHeading).toBe('');
  });

  it('finds a heading through several wrapper levels', () => {
    const el = mount('<section><h2>Application questions</h2><div><div><input name="q_1" /></div></div></section>');
    expect(buildFingerprint(el).contextHeading).toBe('Application questions');
  });
});

// ─── extractSemanticName / normalize / serialize ─────────────────────────────

describe('extractSemanticName', () => {
  it('de-obfuscates a systemfield prefix', () => {
    expect(extractSemanticName('_systemfield_name')).toBe('name');
  });

  it('prefers the content of bracket notation', () => {
    expect(extractSemanticName('job_application[first_name]')).toBe('first name');
  });

  it('joins several bracket groups', () => {
    expect(extractSemanticName('user[profile][city]')).toBe('profile city');
  });

  it('splits camelCase', () => {
    expect(extractSemanticName('firstName')).toBe('first name');
  });

  it('strips a field- prefix', () => {
    expect(extractSemanticName('field-email_address')).toBe('email address');
  });

  it('returns an empty string for an empty attribute', () => {
    expect(extractSemanticName('')).toBe('');
  });

  it('falls back to data-automation-id when the id is meaningless', () => {
    const el = mount('<input id="input-9" data-automation-id="legalNameSection_firstName" />');
    expect(buildFingerprint(el).semanticName).toBe('legal name section first name');
  });

  it('falls back to data-qa', () => {
    const el = mount('<input id="input-4" data-qa="candidate-email" />');
    expect(buildFingerprint(el).semanticName).toBe('candidate email');
  });

  it('prefers a meaningful name over a meaningless id', () => {
    const el = mount('<input id="input-4" name="phone_number" />');
    expect(buildFingerprint(el).semanticName).toBe('phone number');
  });

  it('yields nothing matchable for a purely generated id', () => {
    const el = mount('<input id="input-4" />');
    expect(buildFingerprint(el).semanticName).toBe('4');
    expect(scoreField(buildFingerprint(el))).toBeNull();
  });
});

describe('normalize / serializeFingerprint', () => {
  it('folds diacritics and case', () => {
    expect(normalize('  Příjmení  ')).toBe('prijmeni');
  });

  it('serialises without DOM references', () => {
    const el = mount('<label for="f">Email</label><input id="f" name="email" autocomplete="email" />');
    const serialised = serializeFingerprint(buildFingerprint(el));
    expect(serialised).toContain('email');
    expect(serialised.split('|')).toHaveLength(9);
  });

  it('carries the de-obfuscated attribute name, which is often the only identity', () => {
    const el = mount('<input data-automation-id="preferredName" />');
    expect(serializeFingerprint(buildFingerprint(el))).toContain('preferred name');
  });

  /**
   * Known limitation, deliberately not "fixed" here: `pickSemanticName` returns
   * the first attribute that is not obviously generic, and a hash-like `id`
   * qualifies — so it shadows the meaningful `data-automation-id` behind it.
   * Reordering that list changes what every rule scores against, which is a
   * scorer change, not a serialisation one.
   */
  it('lets an opaque id shadow a meaningful data-automation-id', () => {
    const el = mount('<input id="a7f3c91e" data-automation-id="preferredName" />');
    const serialised = serializeFingerprint(buildFingerprint(el));
    expect(serialised).toContain('a7f3c91e');
    expect(serialised).not.toContain('preferred name');
  });
});

// ─── buildClassificationBatch (FR-5.3 / S-3) ──────────────────────────────────

describe('buildClassificationBatch', () => {
  /** Every fillable control on the page, fingerprinted — what the filler hands over. */
  function fingerprintsOf(html: string): FieldFingerprint[] {
    document.body.innerHTML = html;
    return enumerateFillable(document).map(buildFingerprint);
  }

  it('carries attributes only — never a control’s contents (S-3)', () => {
    const fps = fingerprintsOf(
      '<form><label for="f">Preferred name</label>' +
        '<input id="f" name="preferred_name" placeholder="How should we call you?" /></form>',
    );
    // The user has typed into it; the model must not learn what.
    (fps[0].element as HTMLInputElement).value = 'Ada Lovelace';

    const { payload } = buildClassificationBatch(fps);

    expect(payload).toHaveLength(1);
    expect(payload[0]).toContain('preferred_name');
    expect(payload[0]).toContain('Preferred name');
    expect(payload[0]).not.toContain('Ada');
  });

  it('keeps fields and payload index-aligned — the reply maps back by index', () => {
    const fps = fingerprintsOf(
      '<form><input name="alpha_one" /><input name="beta_two" /><input name="gamma_three" /></form>',
    );
    const batch = buildClassificationBatch(fps);

    expect(batch.fields).toHaveLength(3);
    batch.fields.forEach((field, i) => {
      expect(batch.payload[i]).toBe(serializeFingerprint(field));
      expect(field.element).toBe(fps[i].element);
    });
  });

  it('drops controls whose fingerprint carries no signal at all', () => {
    const fps = fingerprintsOf('<form><input /><input name="street_address" /></form>');
    const batch = buildClassificationBatch(fps);

    expect(batch.payload).toHaveLength(1);
    expect(batch.payload[0]).toContain('street_address');
  });

  it('caps the batch at MAX_CLASSIFY_FIELDS', () => {
    const many = Array.from({ length: MAX_CLASSIFY_FIELDS + 20 }, (_, i) => `<input name="q_${i}" />`);
    const batch = buildClassificationBatch(fingerprintsOf(`<form>${many.join('')}</form>`));

    expect(batch.payload).toHaveLength(MAX_CLASSIFY_FIELDS);
    expect(batch.fields).toHaveLength(MAX_CLASSIFY_FIELDS);
    expect(batch.payload[0]).toContain('q_0');
  });

  it('is empty for an empty input', () => {
    expect(buildClassificationBatch([])).toEqual({ fields: [], payload: [] });
  });
});

// ─── enumerateFillable ────────────────────────────────────────────────────────

describe('enumerateFillable', () => {
  it('excludes file inputs', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="text" name="name" />
      <input type="file" name="resume" />
      <textarea name="bio"></textarea>
    `;
    document.body.appendChild(form);
    const elements = enumerateFillable(form);
    expect(elements.some((el) => (el as HTMLInputElement).type === 'file')).toBe(false);
    expect(elements.length).toBe(2);
  });

  it('excludes consent fields', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="text" name="first_name" />
      <input type="text" name="gdpr_consent" />
    `;
    document.body.appendChild(form);
    const elements = enumerateFillable(form);
    expect(elements.every((el) => !(el as HTMLInputElement).name?.includes('gdpr'))).toBe(true);
  });

  it('excludes password inputs (P0-4)', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="text" name="username" />
      <input type="password" name="password" />
      <input type="password" name="password_confirmation" />
    `;
    document.body.appendChild(form);
    const elements = enumerateFillable(form);
    expect(elements.some((el) => (el as HTMLInputElement).type === 'password')).toBe(false);
    expect(elements).toHaveLength(1);
  });

  it('excludes a password input whose type is set as a property', () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'password';
    input.name = 'secret';
    form.appendChild(input);
    document.body.appendChild(form);
    expect(enumerateFillable(form)).toHaveLength(0);
  });

  it('excludes a password input declared with an upper-case type', () => {
    const form = document.createElement('form');
    form.innerHTML = '<input type="PASSWORD" name="secret" /><input type="text" name="first_name" />';
    document.body.appendChild(form);
    const elements = enumerateFillable(form);
    expect(elements.map((el) => (el as HTMLInputElement).name)).toEqual(['first_name']);
  });

  it('excludes search inputs and search widgets', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="search" name="q" />
      <input type="text" name="site_search" />
      <input type="text" name="keyword_filter" />
      <input type="text" name="first_name" />
    `;
    document.body.appendChild(form);
    const elements = enumerateFillable(form);
    expect(elements).toHaveLength(1);
    expect((elements[0] as HTMLInputElement).name).toBe('first_name');
  });

  it('does not mistake "research" for a search box', () => {
    const form = document.createElement('form');
    form.innerHTML = '<input type="text" name="research_interests" />';
    document.body.appendChild(form);
    expect(enumerateFillable(form)).toHaveLength(1);
  });

  it('excludes disabled and readonly controls', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="text" name="a" disabled />
      <input type="text" name="b" readonly />
      <input type="text" name="c" aria-disabled="true" />
      <input type="text" name="d" />
    `;
    document.body.appendChild(form);
    const elements = enumerateFillable(form);
    expect(elements).toHaveLength(1);
    expect((elements[0] as HTMLInputElement).name).toBe('d');
  });

  it('excludes hidden controls', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="text" name="a" hidden />
      <input type="text" name="b" style="display:none" />
      <input type="text" name="c" style="visibility:hidden" />
      <div style="display:none"><input type="text" name="d" /></div>
      <div aria-hidden="true"><input type="text" name="e" /></div>
      <div inert><input type="text" name="f" /></div>
      <input type="text" name="g" />
    `;
    document.body.appendChild(form);
    const elements = enumerateFillable(form);
    expect(elements.map((el) => (el as HTMLInputElement).name)).toEqual(['g']);
  });

  it('excludes colour and range inputs', () => {
    const form = document.createElement('form');
    form.innerHTML = '<input type="color" name="a" /><input type="range" name="b" /><textarea name="c"></textarea>';
    document.body.appendChild(form);
    expect(enumerateFillable(form)).toHaveLength(1);
  });

  it('keeps selects and textareas', () => {
    const form = document.createElement('form');
    form.innerHTML = '<select name="country"></select><textarea name="bio"></textarea>';
    document.body.appendChild(form);
    expect(enumerateFillable(form)).toHaveLength(2);
  });

  it('excludes Czech consent wording', () => {
    const form = document.createElement('form');
    form.innerHTML = '<label for="s">Souhlasím se zpracováním údajů</label><input id="s" name="souhlas" />';
    document.body.appendChild(form);
    expect(enumerateFillable(form)).toHaveLength(0);
  });
});

// ─── Fixture-based integration tests ─────────────────────────────────────────

describe('LinkedIn fixture', () => {
  let doc: Document;
  beforeEach(() => { doc = loadFixture('linkedin'); });

  it('detects firstName field', () => {
    const el = doc.getElementById('firstName') as HTMLInputElement;
    expect(el).toBeTruthy();
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('firstName');
    expect(match?.confidence).toBe('high');
  });

  it('detects email field', () => {
    const el = doc.getElementById('emailAddress') as HTMLInputElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('email');
    expect(match?.confidence).toBe('high');
  });

  it('detects coverLetter field', () => {
    const el = doc.getElementById('coverLetter') as HTMLTextAreaElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('coverLetter');
  });
});

describe('Jobs.cz fixture (Czech)', () => {
  let doc: Document;
  beforeEach(() => { doc = loadFixture('jobs-cz'); });

  it('detects Czech first name', () => {
    const el = doc.getElementById('jmeno') as HTMLInputElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('firstName');
  });

  it('detects Czech email', () => {
    const el = doc.getElementById('email') as HTMLInputElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('email');
    expect(match?.confidence).toBe('high');
  });

  it('detects Czech cover letter', () => {
    const el = doc.getElementById('motivace') as HTMLTextAreaElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('coverLetter');
  });

  it('detects Czech salary', () => {
    const el = doc.getElementById('plat') as HTMLInputElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('salary');
  });

  it('detects Czech city', () => {
    const el = doc.getElementById('mesto') as HTMLInputElement;
    const match = scoreField(buildFingerprint(el));
    expect(match?.fieldType).toBe('city');
  });
});

describe('Greenhouse fixture', () => {
  let doc: Document;
  beforeEach(() => { doc = loadFixture('greenhouse'); });

  it('detects all key fields', () => {
    const cases: [string, string][] = [
      ['first_name', 'firstName'],
      ['last_name', 'lastName'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['linkedin_profile', 'linkedin'],
      ['github', 'github'],
      ['cover_letter', 'coverLetter'],
      ['salary', 'salary'],
      ['location', 'city'],
    ];

    for (const [id, expectedType] of cases) {
      const el = doc.getElementById(id) as HTMLInputElement;
      expect(el, `element #${id} not found`).toBeTruthy();
      const fp = buildFingerprint(el);
      const match = scoreField(fp);
      expect(match?.fieldType, `#${id} expected ${expectedType}`).toBe(expectedType);
    }
  });
});

describe('StartupJobs fixture (Czech)', () => {
  let doc: Document;
  beforeEach(() => { doc = loadFixture('startupjobs'); });

  it('detects Czech first name via label', () => {
    const el = doc.getElementById('krestni_jmeno') as HTMLInputElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('firstName');
  });

  it('detects Czech email', () => {
    const el = doc.getElementById('email_adresa') as HTMLInputElement;
    const fp = buildFingerprint(el);
    const match = scoreField(fp);
    expect(match?.fieldType).toBe('email');
  });

  it('uses the fieldset legend as context heading', () => {
    const el = doc.getElementById('krestni_jmeno') as HTMLInputElement;
    expect(buildFingerprint(el).contextHeading).toBe('Osobní údaje');
  });
});

// ─── Realistic ATS fixtures (P1-11) ──────────────────────────────────────────

/** Map every enumerated control of a fixture to what the filler would write */
function classifyFixture(name: string): Record<string, string | null> {
  const doc = loadFixture(name);
  const result: Record<string, string | null> = {};
  for (const el of enumerateFillable(doc)) {
    const key =
      el.getAttribute('data-automation-id') ?? el.getAttribute('id') ?? el.getAttribute('name') ?? '?';
    const match = scoreField(buildFingerprint(el));
    result[key] =
      match && (match.confidence === 'high' || match.confidence === 'medium') ? match.fieldType : null;
  }
  return result;
}

describe('Greenhouse (realistic markup)', () => {
  let doc: Document;
  let byId: Record<string, string | null>;
  beforeEach(() => {
    doc = loadFixture('greenhouse-real');
    byId = classifyFixture('greenhouse-real');
  });

  it('never enumerates the account password', () => {
    expect(doc.getElementById('account_password')).toBeTruthy();
    expect(enumerateFillable(doc).some((el) => (el as HTMLInputElement).type === 'password')).toBe(false);
  });

  it('never enumerates the file input or the consent checkbox', () => {
    const enumerated = enumerateFillable(doc);
    expect(enumerated.some((el) => (el as HTMLInputElement).type === 'file')).toBe(false);
    expect(enumerated.some((el) => (el as HTMLInputElement).name?.includes('gdpr'))).toBe(false);
  });

  it('classifies the applicant fields through Rails bracket names', () => {
    expect(byId).toMatchObject({
      first_name: 'firstName',
      last_name: 'lastName',
      email: 'email',
      phone: 'phone',
      'candidate-location': 'city',
      cover_letter_text: 'coverLetter',
      salary_expectation: 'salary',
    });
  });

  it('leaves every trap field alone', () => {
    expect(byId.company_name).toBeNull();
    expect(byId.company_website).toBeNull();
    expect(byId.project_start).toBeNull();
    expect(byId.referral_name).toBeNull();
    expect(byId.referral_email).toBeNull();
  });

  it('routes custom questions to the AI path', () => {
    expect(byId.question_11842145).toBe('openQuestion');
    expect(byId.question_11842146).toBe('openQuestion');
  });

  it('resolves an aria-labelledby list on the question textarea', () => {
    const el = doc.getElementById('question_11842145') as HTMLTextAreaElement;
    expect(buildFingerprint(el).labelText).toContain('Why do you want to work at Acme?');
  });

  it('reads the aria-describedby hint on the phone field', () => {
    const el = doc.getElementById('phone') as HTMLInputElement;
    expect(buildFingerprint(el).description).toContain('country code');
  });
});

describe('Workday (realistic markup)', () => {
  let doc: Document;
  let byAutomationId: Record<string, string | null>;
  beforeEach(() => {
    doc = loadFixture('workday');
    byAutomationId = classifyFixture('workday');
  });

  it('classifies fields that only have data-automation-id and an aria-labelledby list', () => {
    expect(byAutomationId).toMatchObject({
      legalNameSection_firstName: 'firstName',
      legalNameSection_lastName: 'lastName',
      addressSection_city: 'city',
      email: 'email',
      'phone-number': 'phone',
    });
  });

  it('never enumerates the password or verify-password fields', () => {
    expect(doc.querySelectorAll('input[type="password"]')).toHaveLength(2);
    expect(enumerateFillable(doc).some((el) => (el as HTMLInputElement).type === 'password')).toBe(false);
  });

  it('skips the read-only picker proxy', () => {
    expect(byAutomationId.addressSection_countryRegion).toBeUndefined();
  });

  it('skips the collapsed work-experience section', () => {
    expect(doc.querySelector('[data-automation-id="workExperience_1_companyName"]')).toBeTruthy();
    expect(byAutomationId.workExperience_1_companyName).toBeUndefined();
  });

  it('routes the questionnaire textarea to the AI path', () => {
    expect(byAutomationId['primaryQuestionnaire--question1']).toBe('openQuestion');
  });

  it('reads the label out of the aria-labelledby ID list, dropping the required marker text', () => {
    const el = doc.querySelector('[data-automation-id="legalNameSection_firstName"]') as HTMLInputElement;
    expect(buildFingerprint(el).labelText).toContain('First Name');
  });

  it('uses the section heading as context', () => {
    const el = doc.querySelector('[data-automation-id="addressSection_city"]') as HTMLInputElement;
    expect(buildFingerprint(el).contextHeading).toBe('Address');
  });
});

describe('Lever (realistic markup)', () => {
  let byName: Record<string, string | null>;
  beforeEach(() => {
    byName = classifyFixture('lever');
  });

  it('classifies wrapping-label fields', () => {
    expect(byName).toMatchObject({
      name: 'fullName',
      email: 'email',
      phone: 'phone',
    });
  });

  it('reads link fields out of bracket notation', () => {
    expect(byName['urls[LinkedIn]']).toBe('linkedin');
    expect(byName['urls[GitHub]']).toBe('github');
    expect(byName['urls[Portfolio]']).toBe('website');
  });

  it('leaves "Current company" alone', () => {
    expect(byName.org).toBeNull();
  });

  it('routes the opaque custom question to the AI path via its sibling div', () => {
    const key = Object.keys(byName).find((k) => k.startsWith('cards['));
    expect(key, 'custom question field missing').toBeTruthy();
    expect(byName[key!]).toBe('openQuestion');
  });
});

describe('Job search page — nothing may be filled', () => {
  let doc: Document;
  beforeEach(() => { doc = loadFixture('job-search'); });

  it('skips both inputs of the role=search form', () => {
    const enumerated = enumerateFillable(doc);
    expect(enumerated.some((el) => el.getAttribute('name') === 'keywords')).toBe(false);
    expect(enumerated.some((el) => el.id === 'jobs-search-box-location-id')).toBe(false);
  });

  it('does not fill the sidebar Location filter', () => {
    const el = doc.getElementById('loc') as HTMLInputElement;
    const match = scoreField(buildFingerprint(el));
    expect(match?.confidence).toBe('low');
  });

  it('does not enumerate the login password', () => {
    expect(doc.getElementById('login-password')).toBeTruthy();
    expect(enumerateFillable(doc).some((el) => (el as HTMLInputElement).type === 'password')).toBe(false);
  });

  it('does not fill the login email', () => {
    const el = doc.getElementById('login-email') as HTMLInputElement;
    expect(scoreField(buildFingerprint(el))).toBeNull();
  });

  it('does not fill the newsletter email', () => {
    const el = doc.getElementById('newsletter-email') as HTMLInputElement;
    expect(scoreField(buildFingerprint(el))).toBeNull();
  });
});

// ─── NFR-3: throughput ───────────────────────────────────────────────────────

describe('performance (NFR-3)', () => {
  it('enumerates, fingerprints and scores 200 controls well inside 300 ms', () => {
    const form = document.createElement('form');
    let html = '<h2>Application</h2>';
    for (let i = 0; i < 200; i++) {
      html +=
        `<div class="field"><div class="label">Field ${i}</div>` +
        `<div class="control"><input id="f${i}" name="field_${i}" placeholder="Field ${i}" /></div></div>`;
    }
    form.innerHTML = html;
    document.body.appendChild(form);

    const started = performance.now();
    const elements = enumerateFillable(form);
    for (const el of elements) scoreField(buildFingerprint(el));
    const elapsed = performance.now() - started;

    expect(elements).toHaveLength(200);
    expect(elapsed).toBeLessThan(300);
  });
});
