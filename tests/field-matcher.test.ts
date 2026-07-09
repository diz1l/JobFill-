import { describe, it, expect, beforeEach } from 'vitest';
import { buildFingerprint, enumerateFillable } from '../shared/field-matcher/fingerprint';
import { scoreField } from '../shared/field-matcher/scorer';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadFixture(name: string): Document {
  const html = readFileSync(resolve(__dirname, `fixtures/${name}.html`), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

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

    document.body.removeChild(label);
    document.body.removeChild(input);
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
    document.body.removeChild(form);
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
    document.body.removeChild(form);
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
});
