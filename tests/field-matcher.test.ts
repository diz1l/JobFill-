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
import { scoreField, MIN_MARGIN, MEDIUM_THRESHOLD, DEDICATED_BONUS } from '../shared/field-matcher/scorer';
import { FIELD_RULES, type FieldType } from '../shared/field-matcher/dictionary';
import * as fieldMatcher from '../shared/field-matcher';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadFixture(name: string): Document {
  const html = readFileSync(resolve(__dirname, `fixtures/${name}.html`), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

describe('city — Czech vocabulary (P2-2)', () => {
  it('"Preferovaná lokalita" is the applicant\'s own location', () => {
    expect(fills('<label for="f">Preferovaná lokalita</label><input id="f" name="d4e7f0" />')).toBe('city');
  });

  const qualified = ['Současná lokalita', 'Preferované místo', 'Trvalé bydliště', 'Požadovaná lokalita'];
  for (const label of qualified) {
    it(`"${label}" carries a whose-location qualifier and fills`, () => {
      expect(fills(`<label for="f">${label}</label><input id="f" name="q_1" />`)).toBe('city');
    });
  }

  /**
   * Bare "Lokalita" is the Czech counterpart of bare "Location" — what Jobs.cz
   * and Prace.cz call their search filter. Recognised (so the field is outlined)
   * but, exactly like "Location", never filled.
   */
  it('bare "Lokalita" is recognised but never filled — it is the Jobs.cz filter', () => {
    const match = classify('<label for="f">Lokalita</label><input id="f" name="lokalita" />');
    expect(match?.fieldType).toBe('city');
    expect(match?.confidence).toBe('low');
    expect(fills('<label for="f">Lokalita</label><input id="f" name="lokalita" />')).toBeNull();
  });

  /**
   * The English mirror, "Work location", is pinned above as a false positive.
   * The Czech one is identical: on a vacancy it is the employer's site, so it
   * is outlined and left alone.
   */
  it('"Místo výkonu práce" is the employer\'s site, not the applicant\'s home town', () => {
    const match = classify('<label for="f">Místo výkonu práce</label><input id="f" name="misto_vykonu_prace" />');
    expect(match?.fieldType).toBe('city');
    expect(match?.confidence).toBe('low');
  });

  it('"Pracoviště" is recognised but not filled — it is a company site, not a city', () => {
    expect(fills(labelled('Pracoviště', 'name="pracoviste"'))).toBeNull();
  });

  it('"Pracovní místo" is the vacancy itself and is disqualified outright', () => {
    expect(classify(labelled('Pracovní místo', 'name="pracovni_misto"'))).toBeNull();
  });

  it('"Místo" never fills however many sources repeat it (weak-only ceiling)', () => {
    const match = classify(
      '<label for="f">Místo</label><input id="f" name="misto" aria-label="Místo" placeholder="Místo" />',
    );
    expect(match?.fieldType).toBe('city');
    expect(match!.score).toBeLessThan(MEDIUM_THRESHOLD);
    expect(match?.confidence).toBe('low');
  });

  it('"Město" (a settlement) still outranks "místo" (a place)', () => {
    expect(fills(labelled('Město', 'name="q_1"'))).toBe('city');
    expect(fills(labelled('Místo', 'name="q_1"'))).toBeNull();
  });

  it('"Kraj" is not a city — the profile has no region to write there', () => {
    expect(classify(labelled('Kraj', 'name="kraj"'))).toBeNull();
  });
});

describe('dedicated labels (P2-1) — the label is often the only signal there is', () => {
  /** Nothing but a <label>: no name, no id, no autocomplete, no aria */
  function labelOnly(label: string, tag = 'input'): string {
    return tag === 'input'
      ? `<label for="f">${label}</label><input id="f" name="a3f9c1" />`
      : `<label for="f">${label}</label><${tag} id="f" name="a3f9c1"></${tag}>`;
  }

  it('a label that names the field is exactly enough to fill it', () => {
    const match = classify(labelOnly('Motivační dopis', 'textarea'));
    expect(match?.fieldType).toBe('coverLetter');
    expect(match!.score).toBe(MEDIUM_THRESHOLD);
    expect(match?.confidence).toBe('medium');
  });

  it('DEDICATED_BONUS is calibrated so a dedicated label lands on the threshold', () => {
    expect(DEDICATED_BONUS).toBe(15);
  });

  const dedicated: [string, string, string][] = [
    ['Motivační dopis', 'textarea', 'coverLetter'],
    ['Přiložte motivační dopis', 'textarea', 'coverLetter'],
    ['Průvodní dopis', 'textarea', 'coverLetter'],
    ['Preferovaná lokalita', 'input', 'city'],
    ['Kdy můžete nastoupit?', 'input', 'availability'],
    ['Jméno a příjmení', 'input', 'fullName'],
    ['Telefon', 'input', 'phone'],
    ['E-mail', 'input', 'email'],
    ['Můžete přiložit LinkedIn profil', 'input', 'linkedin'],
    ['Attach your cover letter', 'textarea', 'coverLetter'],
    ['When can you start?', 'input', 'availability'],
    ['Please enter your city', 'input', 'city'],
  ];
  for (const [label, tag, expected] of dedicated) {
    it(`"${label}" fills from the label alone`, () => {
      expect(fills(labelOnly(label, tag))).toBe(expected);
    });
  }

  /**
   * The cost of the bonus, and why it is not simply a bigger `STRONG.label`: a
   * label that *mentions* a rule token inside a real question must stay unfilled
   * and go to the model instead.
   */
  const mentionsOnly: [string, string][] = [
    ['What is your availability to travel?', 'availability'],
    ['Which city was our Prague office opened in?', 'city'],
    ['Tell us about a project you are proud of', 'about'],
    ['How did you hear about this job?', 'about'],
    ['What would you put in a cover letter that a CV cannot say?', 'coverLetter'],
  ];
  for (const [label, notThis] of mentionsOnly) {
    it(`"${label}" only mentions the token and is not filled as ${notThis}`, () => {
      expect(fills(`<label for="f">${label}</label><textarea id="f" name="q_1"></textarea>`)).not.toBe(notThis);
    });
  }

  it('an aria-label is worth exactly as much as a <label>', () => {
    expect(fills('<input name="a3f9c1" aria-label="Preferovaná lokalita" />')).toBe('city');
  });

  it('a dedicated placeholder alone is still not enough', () => {
    const match = classify('<input name="a3f9c1" placeholder="Město" />');
    expect(match?.fieldType).toBe('city');
    expect(match?.confidence).toBe('low');
  });

  it('a dedicated context heading alone is still not enough', () => {
    const match = classify('<div class="row"><div class="label">Město</div><input name="a3f9c1" /></div>');
    expect(match?.fieldType).toBe('city');
    expect(match?.confidence).toBe('low');
  });

  it('a sentence too long to be a field name never counts as dedicated', () => {
    // Every leftover word is filler, but 60+ characters is prose, not a name
    const label = 'Please please please please please please please enter your city here';
    expect(label.length).toBeGreaterThan(60);
    expect(fills(`<label for="f">${label}</label><input id="f" name="a3f9c1" />`)).toBeNull();
  });

  it('a required marker and a character counter do not spoil dedication', () => {
    expect(fills('<label for="f">Motivační dopis *</label><textarea id="f" name="a3f9c1"></textarea>')).toBe(
      'coverLetter',
    );
    expect(fills('<label for="f">Cover letter (optional)</label><textarea id="f" name="a3f9c1"></textarea>')).toBe(
      'coverLetter',
    );
  });

  it('a negative context still beats a perfectly dedicated label', () => {
    expect(fills('<label for="f">Company name</label><input id="f" name="a3f9c1" />')).toBeNull();
    expect(fills('<label for="f">Job location</label><input id="f" name="a3f9c1" />')).toBeNull();
  });

  /**
   * "Preferred name" is a nickname ("How should we call you?"), offered by ATS
   * *next to* Legal Name. The profile holds a legal name, so the field belongs
   * to the model path — the bonus must not promote it.
   */
  it('"Preferred name" is a nickname and stays unresolved for the model', () => {
    expect(classify('<label for="f">Preferred name</label><input id="f" name="a3f9c1" />')).toBeNull();
  });
});

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

describe('dictionary vs. open question (P2-3)', () => {
  /**
   * "Kdy můžete nastoupit?" is the standard Czech phrasing of the start-date
   * field. It used to reach the open-question path — the question mark won over
   * the meaning — and the model answered it as an essay prompt instead of it
   * being filled from `availability`. Two things had to be true for the rule to
   * win: `nastoup-` in the dictionary, and a label worth enough on its own.
   */
  const startDateQuestions = [
    'Kdy můžete nastoupit?',
    'Kdy můžete nastoupit',
    'Kdy jste schopen nastoupit?',
    'When can you start?',
    'What is your notice period?',
  ];
  for (const label of startDateQuestions) {
    it(`"${label}" is a start date, not an essay prompt`, () => {
      const match = classify(`<label for="f">${label}</label><input id="f" name="q_1" />`);
      expect(match?.fieldType).toBe('availability');
      expect(match?.confidence).toBe('medium');
    });
  }

  it('a question the dictionary only half-recognises still goes to the model', () => {
    // "travel" is a real subject word, so the label merely mentions availability
    expect(
      classify('<label for="f">What is your availability to travel?</label><textarea id="f" name="q_1"></textarea>')
        ?.fieldType,
    ).toBe('openQuestion');
  });

  it('an open question with no dictionary match at all is unaffected', () => {
    expect(
      classify('<label for="f">Proč chcete pracovat u nás?</label><textarea id="f" name="q_1"></textarea>')?.fieldType,
    ).toBe('openQuestion');
  });
});

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
   * qualifies — shadowing the meaningful `data-automation-id` behind it.
   * Reordering that list is a scorer change, not a serialisation one.
   */
  it('lets an opaque id shadow a meaningful data-automation-id', () => {
    const el = mount('<input id="a7f3c91e" data-automation-id="preferredName" />');
    const serialised = serializeFingerprint(buildFingerprint(el));
    expect(serialised).toContain('a7f3c91e');
    expect(serialised).not.toContain('preferred name');
  });
});

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

// ─── Realistic ATS fixtures ──────────────────────────────────────────────────

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

describe('Jobs.cz reply form — the form the extension actually failed on', () => {
  let doc: Document;
  let byId: Record<string, string | null>;
  beforeEach(() => {
    doc = loadFixture('jobs-cz-reply');
    byId = classifyFixture('jobs-cz-reply');
  });

  /**
   * The point of this fixture: not one control has a usable `name`, `id`,
   * `autocomplete` or `data-*` hook. Everything below is decided by the label.
   */
  it('gives the matcher nothing but the label to work with', () => {
    for (const el of enumerateFillable(doc)) {
      const fp = buildFingerprint(el);
      expect(fp.autocomplete).toBe('');
      expect(fp.ariaLabel).toBe('');
      expect(scoreField(fp), `#${fp.id} scored nothing`).not.toBeNull();
      expect(fp.labelText.length).toBeGreaterThan(0);
    }
  });

  it('classifies every applicant field from its Czech label alone', () => {
    expect(byId).toEqual({
      'f-1': 'fullName',
      'f-2': 'email',
      'f-3': 'phone',
      'f-4': 'city',
      'f-5': 'availability',
      'f-7': 'coverLetter',
      'f-8': 'linkedin',
    });
  });

  it('never enumerates the CV upload or either consent checkbox', () => {
    expect(doc.getElementById('f-6')).toBeTruthy();
    const enumerated = enumerateFillable(doc);
    expect(enumerated.some((el) => (el as HTMLInputElement).type === 'file')).toBe(false);
    expect(enumerated.some((el) => (el as HTMLInputElement).type === 'checkbox')).toBe(false);
    expect(enumerated).toHaveLength(7);
  });

  it('reads the character counter as help text, not as a label', () => {
    const el = doc.getElementById('f-7') as HTMLTextAreaElement;
    const fp = buildFingerprint(el);
    expect(fp.description).toBe('0/6000 znaků');
    expect(fp.labelText).toBe('Přiložte motivační dopis');
  });

  it('"Kdy můžete nastoupit?" resolves to availability, not to an open question', () => {
    const match = scoreField(buildFingerprint(doc.getElementById('f-5') as HTMLInputElement));
    expect(match?.fieldType).toBe('availability');
    expect(match?.confidence).toBe('medium');
  });

  it('the vacancy header\'s "Místo výkonu práce" is prose and owns no control', () => {
    expect(doc.querySelector('.Job-meta')?.textContent).toContain('Místo výkonu práce');
    for (const el of enumerateFillable(doc)) {
      expect(buildFingerprint(el).contextHeading).not.toMatch(/výkonu/i);
    }
  });

  it('each field carries a single unambiguous winner', () => {
    for (const el of enumerateFillable(doc)) {
      const match = scoreField(buildFingerprint(el));
      expect(match!.confidence, `#${el.id} was downgraded`).not.toBe('low');
    }
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

// ─── Vocabulary coverage table ───────────────────────────────────────────────

/**
 * Breadth is this dictionary's primary function: both field-level bugs seen on
 * live forms were a *missing synonym* (`lokalita`, `nastoupit`), never a scoring
 * mistake. Every row is a phrasing that occurs on a real Czech, Slovak or
 * English application form, pinned to what the filler would actually do.
 *
 * Rows are checked on a LABEL-ONLY control (`name="a3f9c1"`, no id, no
 * autocomplete, no aria, no data-*) — the hardest realistic shape, and the one
 * the extension actually failed on, since Jobs.cz and Prace.cz generate hashed
 * names and positional ids. A phrasing that fills here fills everywhere with
 * more signal, so the table doubles as a regression test for `DEDICATED_BONUS`:
 * any change that leaves an adjective stranded ("Mobilní **telefon**",
 * "Earliest start **date**") drops the row from 35 to 20 and fails here.
 */
function labelOnly(label: string, tag = 'input'): string {
  return tag === 'input'
    ? `<label for="f">${label}</label><input id="f" name="a3f9c1" />`
    : `<label for="f">${label}</label><${tag} id="f" name="a3f9c1"></${tag}>`;
}

/** Every phrasing that must resolve to its field type and be written */
const COVERAGE: [FieldType, string, string][] = [
  // ── firstName: EN, ATS, Czech declension, Slovak, imperatives ──
  ['firstName', 'First name', 'input'],
  ['firstName', 'First Name *', 'input'],
  ['firstName', 'Given name', 'input'],
  ['firstName', 'Forename', 'input'],
  ['firstName', 'Christian name', 'input'],
  ['firstName', 'Jméno', 'input'],
  ['firstName', 'Jmeno', 'input'],
  ['firstName', 'Křestní jméno', 'input'],
  ['firstName', 'Vaše jméno', 'input'],
  ['firstName', 'Jménem', 'input'],
  ['firstName', 'Zadejte prosím Vaše jméno', 'input'],
  ['firstName', 'Uveďte své jméno', 'input'],
  ['firstName', 'Meno', 'input'],
  ['firstName', 'Krstné meno', 'input'],

  // ── lastName ──
  ['lastName', 'Last name', 'input'],
  ['lastName', 'Surname', 'input'],
  ['lastName', 'Family name', 'input'],
  ['lastName', 'Second name', 'input'],
  ['lastName', 'Příjmení', 'input'],
  ['lastName', 'Prijmeni', 'input'],
  ['lastName', 'Vaše příjmení', 'input'],
  ['lastName', 'Vyplňte příjmení', 'input'],
  ['lastName', 'Priezvisko', 'input'],

  // ── fullName, incl. the compound spellings ──
  ['fullName', 'Full name', 'input'],
  ['fullName', 'Name', 'input'],
  ['fullName', 'Your name', 'input'],
  ['fullName', 'Legal name', 'input'],
  ['fullName', 'Candidate name', 'input'],
  ['fullName', 'Name and surname', 'input'],
  ['fullName', 'First and last name', 'input'],
  ['fullName', 'First & last name', 'input'],
  ['fullName', 'Jméno a příjmení', 'input'],
  ['fullName', 'Příjmení a jméno', 'input'],
  ['fullName', 'Celé jméno', 'input'],
  ['fullName', 'Meno a priezvisko', 'input'],

  // ── email, incl. abbreviations and the colloquial "mejl" ──
  ['email', 'E-mail', 'input'],
  ['email', 'Email address', 'input'],
  ['email', 'E-mailová adresa', 'input'],
  ['email', 'Váš e-mail', 'input'],
  ['email', 'Emailu', 'input'],
  ['email', 'Mail', 'input'],
  ['email', 'Mejl', 'input'],
  ['email', 'Elektronická pošta', 'input'],
  ['email', 'Zadejte e-mail', 'input'],

  // ── phone, incl. tel. / mob. / GSM and the Czech adjective+noun pairs ──
  ['phone', 'Phone', 'input'],
  ['phone', 'Phone number', 'input'],
  ['phone', 'Telephone', 'input'],
  ['phone', 'Mobile', 'input'],
  ['phone', 'Contact number', 'input'],
  ['phone', 'Tel.', 'input'],
  ['phone', 'Mob.', 'input'],
  ['phone', 'GSM', 'input'],
  ['phone', 'WhatsApp', 'input'],
  ['phone', 'Telefon', 'input'],
  ['phone', 'Mobilní telefon', 'input'],
  ['phone', 'Kontaktní telefon', 'input'],
  ['phone', 'Číslo telefonu', 'input'],
  ['phone', 'Pevná linka', 'input'],
  ['phone', 'Telefónne číslo', 'input'],

  // ── linkedin / github ──
  ['linkedin', 'LinkedIn', 'input'],
  ['linkedin', 'LinkedIn profil', 'input'],
  ['linkedin', 'Linked In URL', 'input'],
  ['github', 'GitHub', 'input'],
  ['github', 'Github profil', 'input'],

  // ── website: the gap that made `Vaše webová stránka` invisible ──
  ['website', 'Website', 'input'],
  ['website', 'Personal website', 'input'],
  ['website', 'Homepage', 'input'],
  ['website', 'Portfolio', 'input'],
  ['website', 'Blog', 'input'],
  ['website', 'Web', 'input'],
  ['website', 'Vaše webová stránka', 'input'],
  ['website', 'Webová stránka', 'input'],
  ['website', 'Webovka', 'input'],
  ['website', 'Osobní web', 'input'],
  ['website', 'Osobní stránky', 'input'],
  ['website', 'Vlastní web', 'input'],
  ['website', 'Internetová stránka', 'input'],

  // ── salary ──
  ['salary', 'Salary', 'input'],
  ['salary', 'Salary expectations', 'input'],
  ['salary', 'Expected salary', 'input'],
  ['salary', 'Desired compensation', 'input'],
  ['salary', 'Hourly rate', 'input'],
  ['salary', 'Mzda', 'input'],
  ['salary', 'Plat', 'input'],
  ['salary', 'Platové očekávání', 'input'],
  ['salary', 'Mzdové očekávání', 'input'],
  ['salary', 'Požadovaná mzda', 'input'],
  ['salary', 'Finanční očekávání', 'input'],
  ['salary', 'Odměna', 'input'],
  ['salary', 'Představa o platu', 'input'],
  ['salary', 'Hodinová sazba', 'input'],

  // ── city ──
  ['city', 'City', 'input'],
  ['city', 'Town', 'input'],
  ['city', 'City/Town', 'input'],
  ['city', 'Hometown', 'input'],
  ['city', 'Current location', 'input'],
  ['city', 'Your city', 'input'],
  ['city', 'Where do you live?', 'input'],
  ['city', 'Město', 'input'],
  ['city', 'Obec', 'input'],
  ['city', 'Bydliště', 'input'],
  ['city', 'Bydlisko', 'input'],
  ['city', 'Trvalé bydliště', 'input'],
  ['city', 'Místo bydliště', 'input'],
  ['city', 'Preferovaná lokalita', 'input'],
  ['city', 'Vaše lokalita', 'input'],
  ['city', 'Aktuální lokalita', 'input'],
  ['city', 'Kde bydlíte?', 'input'],

  // ── coverLetter ──
  ['coverLetter', 'Cover letter', 'textarea'],
  ['coverLetter', 'Covering letter', 'textarea'],
  ['coverLetter', 'Cover note', 'textarea'],
  ['coverLetter', 'Motivation letter', 'textarea'],
  ['coverLetter', 'Letter of interest', 'textarea'],
  ['coverLetter', 'Message to Hiring Manager', 'textarea'],
  ['coverLetter', 'Motivační dopis', 'textarea'],
  ['coverLetter', 'Průvodní dopis', 'textarea'],
  ['coverLetter', 'Přiložte motivační dopis', 'textarea'],
  ['coverLetter', 'Motivačný list', 'textarea'],
  ['coverLetter', 'Sprievodný list', 'textarea'],

  // ── availability ──
  ['availability', 'Availability', 'input'],
  ['availability', 'Available from', 'input'],
  ['availability', 'Start date', 'input'],
  ['availability', 'Earliest start date', 'input'],
  ['availability', 'Notice period', 'input'],
  ['availability', 'When can you start?', 'input'],
  ['availability', 'How soon can you start?', 'input'],
  ['availability', 'Kdy můžete nastoupit?', 'input'],
  ['availability', 'Nástup', 'input'],
  ['availability', 'Datum nástupu', 'input'],
  ['availability', 'Možný termín nástupu', 'input'],
  ['availability', 'Výpovědní lhůta', 'input'],
  ['availability', 'Dostupnost', 'input'],
  ['availability', 'K dispozici od', 'input'],

  // ── workPermit ──
  ['workPermit', 'Work permit', 'input'],
  ['workPermit', 'Visa status', 'input'],
  ['workPermit', 'Citizenship', 'input'],
  ['workPermit', 'Nationality', 'input'],
  ['workPermit', 'Right to work', 'input'],
  ['workPermit', 'Do you require sponsorship?', 'input'],
  ['workPermit', 'Are you legally authorized to work?', 'input'],
  ['workPermit', 'Pracovní povolení', 'input'],
  ['workPermit', 'Povolení k pobytu', 'input'],
  ['workPermit', 'Občanství', 'input'],
  ['workPermit', 'Státní příslušnost', 'input'],
  ['workPermit', 'Modrá karta', 'input'],
  ['workPermit', 'Zaměstnanecká karta', 'input'],
  ['workPermit', 'Víza', 'input'],

  // ── about ──
  ['about', 'About you', 'textarea'],
  ['about', 'About me', 'textarea'],
  ['about', 'Professional summary', 'textarea'],
  ['about', 'Personal statement', 'textarea'],
  ['about', 'Bio', 'textarea'],
  ['about', 'Introduction', 'textarea'],
  ['about', 'O sobě', 'textarea'],
  ['about', 'Něco o sobě', 'textarea'],
  ['about', 'Souhrn', 'textarea'],
  ['about', 'Shrnutí', 'textarea'],
  ['about', 'Krátké představení', 'textarea'],
  ['about', 'Profil', 'textarea'],
];

describe('vocabulary coverage — a label alone must be enough', () => {
  for (const [expected, label, tag] of COVERAGE) {
    it(`"${label}" → ${expected}`, () => {
      expect(fills(labelOnly(label, tag))).toBe(expected);
    });
  }

  it('covers at least 120 distinct phrasings across all 14 rules', () => {
    expect(new Set(COVERAGE.map(([, label]) => label)).size).toBeGreaterThanOrEqual(120);
    expect(new Set(COVERAGE.map(([type]) => type)).size).toBe(FIELD_RULES.length);
  });
});

/**
 * Attribute spellings. `extractSemanticName` does most of the work, but the raw
 * attribute is matched too and is worth 30 — the difference between `medium`
 * and `low` on a control that has nothing else.
 */
const ATTRIBUTE_COVERAGE: [FieldType, string][] = [
  ['firstName', 'first_name'],
  ['firstName', 'firstName'],
  ['firstName', 'fname'],
  ['firstName', 'given_name'],
  ['firstName', 'name_first'],
  ['firstName', 'candidate[first_name]'],
  ['firstName', 'applicant.firstName'],
  ['firstName', 'user[profile][first_name]'],
  ['lastName', 'last_name'],
  ['lastName', 'lastName'],
  ['lastName', 'lname'],
  ['lastName', 'surname'],
  ['lastName', 'name_last'],
  ['lastName', 'candidate[last_name]'],
  ['fullName', 'name'],
  ['fullName', 'full_name'],
  ['fullName', 'legal_name'],
  ['fullName', 'candidate[name]'],
  ['email', 'email'],
  ['email', 'emailAddress'],
  ['email', 'e_mail'],
  ['email', 'applicant.emailAddress'],
  ['phone', 'phone'],
  ['phone', 'phoneNumber'],
  ['phone', 'tel_number'],
  ['phone', 'mobile_phone'],
  ['linkedin', 'linkedinUrl'],
  ['linkedin', 'urls[LinkedIn]'],
  ['github', 'urls[GitHub]'],
  ['website', 'urls[Portfolio]'],
  ['website', 'personal_website'],
  ['salary', 'salary_expectation'],
  ['salary', 'mzda'],
  ['city', 'candidate_city'],
  ['city', 'bydliste'],
  ['coverLetter', 'coverLetter'],
  ['coverLetter', 'motivacni_dopis'],
  ['availability', 'termin_nastupu'],
  ['workPermit', 'obcanstvi'],
  ['about', 'o_sobe'],
];

describe('vocabulary coverage — attribute spellings', () => {
  for (const [expected, attr] of ATTRIBUTE_COVERAGE) {
    it(`name="${attr}" → ${expected}`, () => {
      expect(fills(`<input name="${attr}" />`)).toBe(expected);
    });
  }
});

/**
 * The half that matters more: a widened positive list must not start writing the
 * candidate's data into a field belonging to the employer, to a filter or to a
 * third party. Every row is recognised but never filled, or dropped outright.
 */
const NEVER_FILLED: [string, string, string][] = [
  // employer-owned fields — the Czech genitive word order is the new half
  ['fullName', 'Company name', 'input'],
  ['firstName', 'Jméno společnosti', 'input'],
  ['firstName', 'Jméno zaměstnavatele', 'input'],
  ['fullName', 'Název firmy', 'input'],
  ['website', 'Company website', 'input'],
  ['website', 'Firemní web', 'input'],
  ['website', 'Web společnosti', 'input'],
  ['linkedin', 'Company LinkedIn', 'input'],
  ['city', 'Lokalita pobočky', 'input'],
  // logins and other non-person names
  ['fullName', 'Username', 'input'],
  ['firstName', 'Uživatelské jméno', 'input'],
  ['fullName', 'Display name', 'input'],
  ['fullName', 'Preferred name', 'input'],
  ['lastName', 'Rodné příjmení', 'input'],
  // third parties
  ['fullName', 'Referral name', 'input'],
  ['firstName', 'Emergency contact first name', 'input'],
  ['lastName', 'Reference last name', 'input'],
  ['email', 'Referral email', 'input'],
  ['phone', 'Emergency contact phone', 'input'],
  ['phone', 'Telefon kontaktní osoby', 'input'],
  // search filters and vacancy metadata
  ['city', 'Location', 'input'],
  ['city', 'Lokalita', 'input'],
  ['city', 'Job location', 'input'],
  ['city', 'Office location', 'input'],
  ['city', 'Místo výkonu práce', 'input'],
  ['city', 'Pracoviště', 'input'],
  ['availability', 'Available positions', 'input'],
  ['availability', 'Volné místo', 'input'],
  // fields that mean something else entirely
  ['city', 'Místo narození', 'input'],
  ['city', 'Place of birth', 'input'],
  ['city', 'Billing city', 'input'],
  ['city', 'Kraj', 'input'],
  ['availability', 'Project start date', 'input'],
  ['availability', 'Education end date', 'input'],
  ['availability', 'Datum narození', 'input'],
  ['availability', 'Interview date', 'input'],
  ['email', 'Newsletter email', 'input'],
  ['email', 'Odběr novinek', 'input'],
  ['email', 'Mailing list', 'input'],
  ['about', 'About the company', 'textarea'],
  ['about', 'O nás', 'textarea'],
  ['about', 'Order summary', 'input'],
  ['workPermit', 'Credit card type (Visa/Mastercard)', 'input'],
  // words that merely contain a rule token
  ['phone', 'Hotel', 'input'],
  ['phone', 'Telegram', 'input'],
  ['phone', 'Intel experience', 'input'],
  ['salary', 'Platforma', 'input'],
];

describe('vocabulary coverage — nothing on the other side of the form is filled', () => {
  for (const [notThis, label, tag] of NEVER_FILLED) {
    it(`"${label}" is never filled as ${notThis}`, () => {
      expect(fills(labelOnly(label, tag))).not.toBe(notThis);
    });
  }

  it('pins at least 40 negative phrasings', () => {
    expect(NEVER_FILLED.length).toBeGreaterThanOrEqual(40);
  });
});

/**
 * Recognised, outlined, never written. The `weak` tier exists for words that are
 * genuinely ambiguous alone: bare `Lokalita` is the Jobs.cz filter, bare
 * `Stránky` means "pages", bare `Motivace` introduces an essay as often as a box.
 */
const WEAK_BY_DESIGN: [FieldType, string, string][] = [
  ['city', 'Lokalita', 'input'],
  ['city', 'Location', 'input'],
  ['city', 'Místo', 'input'],
  ['city', 'Pracoviště', 'input'],
  ['website', 'Stránky', 'input'],
  ['coverLetter', 'Motivace', 'textarea'],
];

describe('vocabulary coverage — the deliberately weak tier', () => {
  for (const [type, label, tag] of WEAK_BY_DESIGN) {
    it(`"${label}" is recognised as ${type} but stays below the fill threshold`, () => {
      const match = classify(labelOnly(label, tag));
      expect(match?.fieldType).toBe(type);
      expect(match!.score).toBeLessThan(MEDIUM_THRESHOLD);
      expect(match?.confidence).toBe('low');
    });
  }
});

describe('the two phrasings this expansion was commissioned for', () => {
  it('"Jméno společnosti" no longer scores as the candidate\'s first name', () => {
    expect(classify(labelOnly('Jméno společnosti'))).toBeNull();
  });

  it('"Vaše webová stránka" is recognised at all — it used to match nothing', () => {
    const match = classify(labelOnly('Vaše webová stránka'));
    expect(match?.fieldType).toBe('website');
    expect(match?.confidence).toBe('medium');
  });

  it('the Czech genitive owner is what does it, in either word order', () => {
    expect(fills(labelOnly('Jméno firmy'))).toBeNull();
    expect(fills(labelOnly('Company first name'))).toBeNull();
  });
});

/**
 * The soft boundary has to know about Czech letters. `í` is not an ASCII
 * letter, so `(?<![a-z])jmen` matched *inside* `příjmení` the moment the
 * `jméno` stem was widened to cover its declension — and every surname field on
 * a Czech form scored as a given name.
 */
describe('diacritics-aware word boundaries', () => {
  const pairs: [string, FieldType][] = [
    ['Příjmení', 'lastName'],
    ['Vaše příjmení', 'lastName'],
    ['Jméno', 'firstName'],
    ['Křestní jméno', 'firstName'],
  ];
  for (const [label, expected] of pairs) {
    it(`"${label}" resolves to ${expected}, not to the stem buried inside it`, () => {
      expect(fills(labelOnly(label))).toBe(expected);
    });
  }

  it('no rule matches a token that only appears after an accented letter', () => {
    const firstName = FIELD_RULES.find((r) => r.type === 'firstName')!;
    expect(firstName.pattern.test('příjmení')).toBe(false);
    expect(firstName.pattern.test('náměstí')).toBe(false);
  });
});

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


