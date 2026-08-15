import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { httpRequest, httpJson, HttpError } from '../shared/api/http';
import * as provider from '../shared/api/provider';
import { RemoteLogError, toRemoteLogError } from '../shared/api/remoteLog';
import {
  buildMapping,
  buildNotionProperties,
  clearNotionSchemaCache,
  describeMapping,
  inspectNotionDatabase,
  logToNotion,
  type NotionPropertyInfo,
} from '../shared/api/notion';
import { logToSheets, validateSheetsEndpoint } from '../shared/api/sheets';
import {
  answerOpenQuestions,
  chooseSelectOptions,
  listModels,
  planFieldTemplates,
  probeModel,
  generateMotivation,
  GroqApiError,
} from '../shared/api/groq';
import {
  buildOptionChoicePrompt,
  toOptionIndex,
  validateOptionChoices,
} from '../shared/api/optionChoice';
import {
  refusalReason,
  toValueTemplate,
  validateFieldTemplates,
} from '../shared/api/fieldTemplates';
import {
  buildEndpoint,
  identifyKeyOrigin,
  keyProviderMismatch,
  normalizeBaseUrl,
  originPattern,
  providerOf,
  validateBaseUrl,
  PROVIDERS,
  PROVIDER_IDS,
  type LlmEndpoint,
} from '../shared/api/provider';
import { resolveTemplate } from '../shared/filler/valueTemplate';
import { createApplicationEntry, createEmptyProfile, LLM_FIELD_CONFIDENCE } from '../shared/types';
import type { LlmFieldConfidence } from '../shared/types';
import {
  MAX_CLASSIFY_FIELDS,
  MAX_OPTION_SELECTS,
  MAX_SELECT_OPTIONS,
  type FromBackgroundMessage,
  type SelectQuestion,
} from '../shared/messages';

const groqEndpoint: LlmEndpoint = buildEndpoint({
  providerId: 'groq',
  apiKey: 'key',
  model: 'model',
});

async function rejection<T>(promise: Promise<unknown>): Promise<T> {
  let caught: unknown;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    caught = err;
  }
  if (resolved) throw new Error('expected the promise to reject, but it resolved');
  return caught as T;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(body: string, status = 200, contentType = 'text/html'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/**
 * Two things `new Response` will not do: omit `Content-Type` entirely (it
 * invents `text/plain` for a string body), and fail while the body is being
 * read. Both are states a proxy or a dropped connection can produce, and both
 * have a `??` / `.catch()` in the code that nothing else would exercise.
 */
function fakeResponse(init: {
  ok: boolean;
  status: number;
  contentType?: string;
  text?: () => Promise<string>;
}): Response {
  const headers = new Headers();
  if (init.contentType) headers.set('content-type', init.contentType);
  return {
    ok: init.ok,
    status: init.status,
    headers,
    text: init.text ?? (() => Promise.resolve('')),
  } as unknown as Response;
}

const entry = createApplicationEntry({
  jobInfo: { company: 'ACME', position: 'Frontend Engineer' },
  profileId: 'profile-1',
  url: 'https://jobs.example.com/123',
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  clearNotionSchemaCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── http.ts ──────────────────────────────────────────────────────────────────

describe('httpRequest', () => {
  it('maps HTTP statuses onto error kinds', async () => {
    const cases: Array<[number, string]> = [
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [500, 'SERVER_ERROR'],
      [418, 'BAD_REQUEST'],
    ];

    for (const [status, kind] of cases) {
      fetchMock.mockResolvedValueOnce(textResponse('nope', status, 'text/plain'));
      const err = await rejection<HttpError>(httpRequest('https://x.test', { service: 'X' }));
      expect(err).toBeInstanceOf(HttpError);
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
    }
  });

  it('flags only transport-level failures as retryable', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('', 503, 'text/plain'));
    const retryable = await rejection<HttpError>(httpRequest('https://x.test', { service: 'X' }));
    expect(retryable.retryable).toBe(true);

    fetchMock.mockResolvedValueOnce(textResponse('', 401, 'text/plain'));
    const permanent = await rejection<HttpError>(httpRequest('https://x.test', { service: 'X' }));
    expect(permanent.retryable).toBe(false);
  });

  it('converts an aborted request into TIMEOUT', async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const promise = httpRequest('https://x.test', { service: 'Groq', timeoutMs: 5 });
    await expect(promise).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('reports a malformed JSON body as BAD_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<html>', 200, 'application/json'));
    await expect(httpJson('https://x.test', { service: 'X' })).rejects.toMatchObject({
      kind: 'BAD_RESPONSE',
    });
  });

  it('passes a timeout budget through and does not leave the timer running', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(httpJson('https://x.test', { service: 'X', timeoutMs: 50 })).resolves.toEqual({
      ok: true,
    });
  });
});

// ─── remoteLog.ts ─────────────────────────────────────────────────────────────

describe('toRemoteLogError', () => {
  it('translates HTTP kinds into logging kinds', () => {
    expect(toRemoteLogError(new HttpError('FORBIDDEN', 'x'), 'Notion').kind).toBe('UNAUTHORIZED');
    expect(toRemoteLogError(new HttpError('BAD_REQUEST', 'x'), 'Notion').kind).toBe(
      'SCHEMA_MISMATCH',
    );
    expect(toRemoteLogError(new HttpError('SERVER_ERROR', 'x'), 'Notion').kind).toBe(
      'NETWORK_ERROR',
    );
  });

  it('keeps an existing RemoteLogError untouched', () => {
    const original = new RemoteLogError('NOT_CONFIGURED', 'set it up');
    expect(toRemoteLogError(original, 'Notion')).toBe(original);
  });

  it('marks schema and auth problems as non-retryable', () => {
    expect(new RemoteLogError('SCHEMA_MISMATCH', 'x').retryable).toBe(false);
    expect(new RemoteLogError('UNAUTHORIZED', 'x').retryable).toBe(false);
    expect(new RemoteLogError('NOT_CONFIGURED', 'x').retryable).toBe(false);
    expect(new RemoteLogError('TIMEOUT', 'x').retryable).toBe(true);
    expect(new RemoteLogError('NETWORK_ERROR', 'x').retryable).toBe(true);
  });
});

// ─── notion.ts — schema discovery ─────────────────────────────────────────────

const canonicalProps: NotionPropertyInfo[] = [
  { name: 'Name', type: 'title' },
  { name: 'Company', type: 'rich_text' },
  { name: 'URL', type: 'url' },
  { name: 'Date', type: 'date' },
  { name: 'Status', type: 'select' },
  { name: 'Profile', type: 'rich_text' },
];

describe('Notion schema mapping', () => {
  it('maps the canonical database', () => {
    const report = buildMapping(canonicalProps);
    expect(report.usable).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.mapping.title?.name).toBe('Name');
    expect(report.mapping.url?.name).toBe('URL');
  });

  it('maps a differently named database by property type (P1-13)', () => {
    const report = buildMapping([
      { name: 'Pozice', type: 'title' },
      { name: 'Firma', type: 'rich_text' },
      { name: 'Odkaz', type: 'url' },
      { name: 'Datum', type: 'date' },
    ]);

    expect(report.usable).toBe(true);
    expect(report.mapping.title?.name).toBe('Pozice');
    expect(report.mapping.company?.name).toBe('Firma');
    expect(report.mapping.url?.name).toBe('Odkaz');
    expect(report.mapping.date?.name).toBe('Datum');
  });

  it('never assigns the same property to two slots', () => {
    const report = buildMapping([
      { name: 'Name', type: 'title' },
      { name: 'Notes', type: 'rich_text' },
    ]);
    const used = Object.values(report.mapping).map((p) => p.name);
    expect(new Set(used).size).toBe(used.length);
  });

  it('reports a database with no title property as unusable', () => {
    const report = buildMapping([{ name: 'Company', type: 'rich_text' }]);
    expect(report.usable).toBe(false);
    expect(report.missing.join(' ')).toMatch(/Title property/i);
  });

  it('lists unmapped slots in human-readable form', () => {
    const lines = describeMapping(buildMapping([{ name: 'Name', type: 'title' }]));
    expect(lines.some((l) => l.includes('title → "Name" (title)'))).toBe(true);
    expect(lines.some((l) => /date → not mapped/.test(l))).toBe(true);
  });
});

describe('Notion property values', () => {
  it('builds the correct payload shape per property type', () => {
    const props = buildNotionProperties(entry, buildMapping(canonicalProps).mapping);
    expect(props.Name).toEqual({ title: [{ text: { content: 'Frontend Engineer' } }] });
    expect(props.Company).toEqual({ rich_text: [{ text: { content: 'ACME' } }] });
    expect(props.URL).toEqual({ url: entry.url });
    expect(props.Date).toEqual({ date: { start: entry.timestamp } });
    expect(props.Status).toEqual({ select: { name: 'submitted' } });
  });

  it('skips a Status property whose options do not include our value', () => {
    // Status options cannot be created through the API — writing one would 400.
    const props = buildNotionProperties(entry, {
      title: { name: 'Name', type: 'title' },
      status: { name: 'Status', type: 'status', options: ['Not started', 'Done'] },
    });
    expect(props.Status).toBeUndefined();
  });

  it('reuses an existing status option case-insensitively', () => {
    const props = buildNotionProperties(entry, {
      title: { name: 'Name', type: 'title' },
      status: { name: 'Status', type: 'status', options: ['Submitted'] },
    });
    expect(props.Status).toEqual({ status: { name: 'Submitted' } });
  });
});

describe('logToNotion', () => {
  const dbResponse = {
    properties: {
      Name: { name: 'Name', type: 'title' },
      Company: { name: 'Company', type: 'rich_text' },
    },
  };

  it('discovers the schema, then creates the page', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(dbResponse))
      .mockResolvedValueOnce(jsonResponse({ id: 'page-1' }));

    await logToNotion(entry, 'secret_token', 'db-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [schemaUrl, schemaInit] = fetchMock.mock.calls[0];
    expect(schemaUrl).toContain('/v1/databases/db-1');
    expect(schemaInit.method).toBe('GET');

    const [pageUrl, pageInit] = fetchMock.mock.calls[1];
    expect(pageUrl).toContain('/v1/pages');
    const body = JSON.parse(pageInit.body as string);
    expect(body.parent).toEqual({ database_id: 'db-1' });
    expect(body.properties.Name).toBeDefined();
  });

  it('caches the schema between writes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(dbResponse))
      // A fresh Response per call — a body can only be consumed once.
      .mockImplementation(() => Promise.resolve(jsonResponse({ id: 'page' })));

    await logToNotion(entry, 'secret_token', 'db-cache');
    await logToNotion(entry, 'secret_token', 'db-cache');

    // 1 schema read + 2 page creations
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('explains an unusable database instead of sending a doomed request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ properties: { Company: { name: 'Company', type: 'rich_text' } } }),
    );

    const err = await rejection<RemoteLogError>(logToNotion(entry, 'secret_token', 'db-bad'));
    expect(err).toBeInstanceOf(RemoteLogError);
    expect(err.kind).toBe('SCHEMA_MISMATCH');
    expect(err.message).toMatch(/no Title property/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns a 401 into actionable guidance, not raw Notion text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'unauthorized', message: 'API token is invalid.' }, 401),
    );

    const err = await rejection<RemoteLogError>(inspectNotionDatabase('bad', 'db-401'));
    expect(err.kind).toBe('UNAUTHORIZED');
    expect(err.message).toMatch(/share the database with the integration/i);
    expect(err.detail).toBe('API token is invalid.');
    expect(err.retryable).toBe(false);
  });

  it('surfaces a 400 validation message from Notion', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(dbResponse))
      .mockResolvedValueOnce(
        jsonResponse({ code: 'validation_error', message: 'Company is not a property.' }, 400),
      );

    const err = await rejection<RemoteLogError>(logToNotion(entry, 'secret_token', 'db-400'));
    expect(err.kind).toBe('SCHEMA_MISMATCH');
    expect(err.message).toMatch(/Company is not a property/);
  });

  it('rejects an empty configuration without a request', async () => {
    const err = await rejection<RemoteLogError>(inspectNotionDatabase('', ''));
    expect(err.kind).toBe('NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── sheets.ts ────────────────────────────────────────────────────────────────

describe('validateSheetsEndpoint', () => {
  it('accepts a proper Apps Script deployment URL', () => {
    expect(
      validateSheetsEndpoint('https://script.google.com/macros/s/AKfy123/exec'),
    ).toBeUndefined();
  });

  it('rejects http, unrelated hosts, /dev URLs and empty values', () => {
    expect(validateSheetsEndpoint('')).toMatch(/no Web App URL/i);
    expect(validateSheetsEndpoint('not a url')).toMatch(/not a valid URL/i);
    expect(validateSheetsEndpoint('http://script.google.com/macros/s/x/exec')).toMatch(/https/);
    expect(validateSheetsEndpoint('https://evil.example.com/exec')).toMatch(/Apps Script/i);
    expect(validateSheetsEndpoint('https://script.google.com/macros/s/x/dev')).toMatch(/\/exec/);
  });
});

describe('logToSheets', () => {
  const endpoint = 'https://script.google.com/macros/s/AKfy123/exec';

  it('POSTs the entry and follows the Apps Script redirect', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('OK', 200, 'text/plain'));

    await logToSheets(entry, endpoint);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init.method).toBe('POST');
    // Apps Script always 302s to script.googleusercontent.com.
    expect(init.redirect).toBe('follow');
    expect(JSON.parse(init.body as string)).toMatchObject({ id: entry.id, company: 'ACME' });
  });

  it('applies a timeout — there was none before', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('OK', 200, 'text/plain'));
    await logToSheets(entry, endpoint);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('detects the sign-in page returned with HTTP 200', async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse('<html><body>Sign in to continue to accounts.google.com</body></html>'),
    );

    const err = await rejection<RemoteLogError>(logToSheets(entry, endpoint));
    expect(err.kind).toBe('UNAUTHORIZED');
    expect(err.message).toMatch(/Who has access: Anyone/);
  });

  it('explains a network failure by naming the redirect target', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const err = await rejection<RemoteLogError>(logToSheets(entry, endpoint));
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.message).toMatch(/script\.googleusercontent\.com/);
    expect(err.retryable).toBe(true);
  });

  it('refuses an unconfigured endpoint without a request', async () => {
    const err = await rejection<RemoteLogError>(logToSheets(entry, ''));
    expect(err.kind).toBe('NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── groq.ts ──────────────────────────────────────────────────────────────────

describe('Groq error mapping (FR-5.4)', () => {
  const profile = createEmptyProfile({ firstName: 'Ada', about: 'Engineer' });

  it('rejects a missing key before touching the network', async () => {
    const err = await rejection<GroqApiError>(generateMotivation({}, profile, { ...groqEndpoint, apiKey: '' }));
    expect(err.kind).toBe('MISSING_KEY');
    expect(err.message).toMatch(/Settings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 / 429 / 5xx onto distinct, actionable messages', async () => {
    const cases: Array<[number, string, RegExp]> = [
      [401, 'UNAUTHORIZED', /rejected the API key/i],
      [429, 'RATE_LIMITED', /rate[- ]limit/i],
      [500, 'NETWORK_ERROR', /network error/i],
    ];

    for (const [status, kind, copy] of cases) {
      fetchMock.mockResolvedValueOnce(textResponse('RAW_BACKEND_TEXT', status, 'text/plain'));
      const err = await rejection<GroqApiError>(generateMotivation({}, profile, groqEndpoint));
      expect(err.kind).toBe(kind);
      expect(err.message).toMatch(copy);
      // Raw backend text must never leak into the UI (the old code used String(err)).
      expect(err.message).not.toContain('RAW_BACKEND_TEXT');
    }
  });

  it('returns the completion text on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '  Hello there.  ' } }] }),
    );
    await expect(generateMotivation({}, profile, groqEndpoint)).resolves.toBe('Hello there.');
  });
});

describe('value templates — the FR-5.3 answer contract', () => {
  const profile = createEmptyProfile({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    salaryExpectation: '80000 CZK',
    availability: 'From 1 March',
  });
  const ctx = { profile };
  /** A fingerprint with no signal in it — every rule below is off by default. */
  const plain = ['|preferred_name||preferred name||Preferred name|||'];

  it('accepts a composition, which is the whole reason templates exist', () => {
    expect(validateFieldTemplates({ '0': '{firstName} {lastName}' }, plain)).toEqual({
      '0': '{firstName} {lastName}',
    });
    expect(resolveTemplate('{firstName} {lastName}', ctx)).toBe('Ada Lovelace');
    expect(resolveTemplate('{lastName}, {firstName}', ctx)).toBe('Lovelace, Ada');
  });

  it('drops a template naming an atom that does not exist — whole, not partly', () => {
    // `maidenName` is not a profile atom. Filling in the parts that do exist
    // would answer a different question than the one the field asked.
    expect(validateFieldTemplates({ '0': '{firstName} {maidenName}' }, plain)).toEqual({});
    expect(toValueTemplate('{socialSecurityNumber}')).toBeNull();
    // Defence in depth: even if one got through, substitution refuses it too.
    expect(resolveTemplate('{firstName} {maidenName}', ctx)).toBe('');
  });

  /**
   * The digits in `addressLine1` are the reason the placeholder grammar admits
   * them at all. A letters-only pattern dropped both address lines whole — a
   * safe failure, and a permanently unreachable one.
   */
  it('accepts the two placeholder names that carry a digit', () => {
    expect(toValueTemplate('{addressLine1}')).toBe('{addressLine1}');
    expect(validateFieldTemplates({ '0': '{addressLine2}' }, plain)).toEqual({
      '0': '{addressLine2}',
    });
    // …without admitting a bare number, which is literal text however it is
    // wrapped: no leading letter, so it is not a placeholder at all.
    expect(toValueTemplate('{1990}')).toBeNull();
  });

  it('refuses literal text — the model may reference values, never write them', () => {
    expect(toValueTemplate('I confirm that I have read the terms')).toBeNull();
    expect(toValueTemplate('{firstName} the Great')).toBeNull();
    expect(toValueTemplate('1990-01-01')).toBeNull();
    expect(toValueTemplate('ada@example.com')).toBeNull();
    // Separators are the only literals allowed, so real compositions still pass.
    expect(toValueTemplate('{lastName}, {firstName}')).toBe('{lastName}, {firstName}');
    expect(toValueTemplate('{linkedin} / {github}')).toBe('{linkedin} / {github}');
  });

  it('still understands the old contract — a bare field-type name', () => {
    // Small models regress to classification however the prompt is worded, and a
    // correct answer must not be thrown away over its formatting.
    expect(validateFieldTemplates({ '0': 'email' }, plain)).toEqual({ '0': '{email}' });
    expect(toValueTemplate('fullName')).toBe('{firstName} {lastName}');
    expect(toValueTemplate('coverLetter')).toBe('{coverLetter}');
    expect(toValueTemplate('maritalStatus')).toBeNull();
  });

  it('treats every flavour of "I do not know" as no answer', () => {
    expect(validateFieldTemplates({ '0': '', '1': 'unknown', '2': 'n/a', '3': '-' }, [
      ...plain,
      ...plain,
      ...plain,
      ...plain,
    ])).toEqual({});
  });

  it('drops out-of-range indices, non-strings and non-objects', () => {
    expect(validateFieldTemplates({ '5': '{email}' }, plain)).toEqual({});
    expect(validateFieldTemplates({ '0': 42 }, plain)).toEqual({});
    expect(validateFieldTemplates({ notAnIndex: '{email}' }, plain)).toEqual({});
    expect(validateFieldTemplates(['{email}'], plain)).toEqual({});
    expect(validateFieldTemplates(null, plain)).toEqual({});
  });

  it('refuses to empty the profile into one box, or to mangle a placeholder', () => {
    expect(toValueTemplate('{firstName} {lastName} {email} {phone}')).toBeNull();
    expect(toValueTemplate('{first name}')).toBeNull();
    expect(toValueTemplate('{firstName')).toBeNull();
  });
});

describe('fields the model is not allowed to answer', () => {
  /** `serializeFingerprint` order: autocomplete|name|id|semantic|aria|label|placeholder|heading|desc */
  const fp = (label: string, name = '') => `|${name}||${name}||${label}|||`;

  it.each([
    ['a consent checkbox', fp('I agree to the processing of my personal data', 'gdpr_consent')],
    ['a Czech consent', fp('Souhlasím se zpracováním osobních údajů', 'souhlas')],
    ['an employer field', fp('Current employer', 'employer_name')],
    ['a company field', fp('Company', 'company')],
    ['a reference', fp('Reference contact e-mail', 'reference_email')],
    ['an emergency contact', fp('Emergency contact phone', 'emergency_contact')],
    ['a date of birth', fp('Date of birth', 'dob')],
    ['a Czech birth number', fp('Rodné číslo', 'rodne_cislo')],
    ['a bank account', fp('IBAN', 'iban')],
  ])('refuses %s even when the model answered confidently', (_case, fingerprint) => {
    expect(refusalReason(fingerprint)).not.toBeNull();
    expect(validateFieldTemplates({ '0': '{email}' }, [fingerprint])).toEqual({});
    expect(validateFieldTemplates({ '0': '{firstName} {lastName}' }, [fingerprint])).toEqual({});
  });

  /**
   * The template path can only copy the applicant's own stored values, which is
   * usually what makes it safe — and is exactly what makes these fields unsafe:
   * `{workPermit}` resolves to "Yes", and "Yes" in "Have you ever been
   * convicted?" is a statement the applicant never made.
   */
  it.each([
    ['a criminal record', fp('Have you ever been convicted of a felony?', 'conviction')],
    ['military service', fp('Are you a protected veteran?', 'veteran_status')],
    ['a disability', fp('Do you have a disability?', 'disability_status')],
    ['a protected characteristic', fp('Gender identity', 'gender')],
    ['an attestation', fp('Is your work experience included on your resume?', 'resume_ok')],
  ])('refuses %s as a declaration no stored value can make', (_case, fingerprint) => {
    expect(refusalReason(fingerprint)).toBe('declaration');
    expect(validateFieldTemplates({ '0': '{workPermit}' }, [fingerprint])).toEqual({});
  });

  /**
   * The counterpart: a field the user has a profile entry for stays answerable,
   * because filling it in is them answering. The dropdown path refuses these
   * anyway — there the model would be picking Yes or No itself.
   */
  it.each([
    ['Do you need a work permit?', 'work_permit'],
    ['Highest level of education', 'education'],
    ['Nationality', 'nationality'],
  ])('leaves "%s" to the profile rather than refusing it', (label, name) => {
    expect(refusalReason(fp(label, name))).toBeNull();
  });

  it('lets money fields take the salary the user wrote, and nothing else', () => {
    const salaryField = [fp('Expected salary', 'salary_expectation')];
    expect(validateFieldTemplates({ '0': '{salary}' }, salaryField)).toEqual({ '0': '{salary}' });
    // Anything else in a money box is the model inventing a number.
    expect(validateFieldTemplates({ '0': '{about}' }, salaryField)).toEqual({});
    expect(validateFieldTemplates({ '0': '{salary} {city}' }, salaryField)).toEqual({});
  });

  it('lets date fields take the availability, and nothing else', () => {
    const startField = [fp('Preferred start date', 'start_date')];
    expect(validateFieldTemplates({ '0': '{availability}' }, startField)).toEqual({
      '0': '{availability}',
    });
    expect(validateFieldTemplates({ '0': '{firstName}' }, startField)).toEqual({});
  });

  it('still answers an ordinary field the dictionary has no rule for', () => {
    // There is no fixed list of supported field types any more.
    const nickname = [fp('How should we call you?', 'preferred_name')];
    expect(validateFieldTemplates({ '0': '{firstName}' }, nickname)).toEqual({ '0': '{firstName}' });
  });

  /**
   * The refusal rules are drawn generously, which is only safe while they stay
   * off the ordinary fields. This is the guard against a pattern quietly
   * swallowing half the form.
   */
  it.each([
    ['Full name', 'full_name'],
    ['Jméno a příjmení', 'jmeno_prijmeni'],
    ['E-mail address', 'email'],
    ['Phone number', 'phone'],
    ['LinkedIn profile', 'linkedin'],
    ['City', 'city'],
    ['Cover letter', 'cover_letter'],
    ['Tell us about yourself', 'about'],
    ['Portfolio URL', 'website'],
    ['Do you need a work permit?', 'work_permit'],
  ])('leaves %s answerable', (label, name) => {
    expect(refusalReason(fp(label, name))).toBeNull();
  });

  it('composes the Czech one-box name, end to end', () => {
    const profile = createEmptyProfile({ firstName: 'Dias', lastName: 'Nurgaliyev' });
    const plan = validateFieldTemplates({ '0': '{firstName} {lastName}' }, [
      fp('Jméno a příjmení', 'jmeno_prijmeni'),
    ]);
    expect(resolveTemplate(plan['0'], { profile })).toBe('Dias Nurgaliyev');
  });
});

describe('planFieldTemplates (FR-5.3)', () => {
  it('leaves fields untouched when the model returns invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: 'not json at all' } }] }),
    );
    await expect(planFieldTemplates(['a', 'b'], groqEndpoint)).resolves.toEqual({});
  });

  it('does not call the API for an empty fingerprint list', async () => {
    await expect(planFieldTemplates([], groqEndpoint)).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Silent, not thrown. This is an unattended pass over fields nothing was
   * written into; there is no one waiting for it and nothing to report to.
   */
  it('declines without a key, without a request and without an error', async () => {
    await expect(planFieldTemplates(['a'], { ...groqEndpoint, apiKey: '' })).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines when the key belongs to another provider — before any request', async () => {
    const foreign = { ...groqEndpoint, apiKey: 'sk-or-v1-abcdef' };
    await expect(planFieldTemplates(['a'], foreign)).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** The egress point enforces the cap too — a caller cannot talk past it. */
  it('never sends more than MAX_CLASSIFY_FIELDS fingerprints', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '{"0":"{email}"}' } }] }),
    );
    const many = Array.from({ length: MAX_CLASSIFY_FIELDS + 30 }, (_, i) => `fp_${i}`);

    await planFieldTemplates(many, groqEndpoint);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
      messages: { content: string }[];
    };
    const prompt = body.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('fp_0');
    expect(prompt).toContain(`fp_${MAX_CLASSIFY_FIELDS - 1}`);
    expect(prompt).not.toContain(`fp_${MAX_CLASSIFY_FIELDS}`);
  });

  it('treats an empty completion as "no answer", not as a parse failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '   ' } }] }));
    await expect(planFieldTemplates(['a'], groqEndpoint)).resolves.toEqual({});
  });

  it('validates the reply against the truncated batch, not the original list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [
          { message: { content: `{"0":"{email}","${MAX_CLASSIFY_FIELDS}":"{phone}"}` } },
        ],
      }),
    );
    const many = Array.from({ length: MAX_CLASSIFY_FIELDS + 30 }, (_, i) => `fp_${i}`);

    // An index past the batch was never sent: an answer about it is invented.
    await expect(planFieldTemplates(many, groqEndpoint)).resolves.toEqual({ '0': '{email}' });
  });

  it('offers the model the atom names — and only the names (S-3)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    await planFieldTemplates(['|||||Full name|||'], groqEndpoint);
    const prompt = String(fetchMock.mock.calls[0][1].body);
    expect(prompt).toContain('firstName');
    expect(prompt).toContain('lastName');
  });

  /**
   * The fingerprints below are what `serializeFingerprint` produces for a filled
   * form; the profile that filled it must appear nowhere in the request — which
   * is what makes it safe to ask the model to *compose* a value it never sees.
   */
  it('puts nothing but the fingerprints in the request body (S-3)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const profile = createEmptyProfile({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+420123456789',
      city: 'Praha',
      salaryExpectation: '80000',
      about: 'I build things that work.',
    });
    const secret = 'gsk_supersecretkeyvalue';

    await planFieldTemplates(
      ['||op|op||Preferred name|||', '|||||Start date|||'],
      { ...groqEndpoint, apiKey: secret },
    );

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = String(request.body);
    for (const value of Object.values(profile)) {
      if (value && value !== profile.id) expect(body).not.toContain(value);
    }
    expect(body).toContain('Preferred name');
    // The key travels in the header, as it must — not in the payload.
    expect(body).not.toContain(secret);
    expect((request.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
  });
});

// ─── Picking an option out of a dropdown ─────────────────────────────────────

describe('the option-choice answer contract', () => {
  /** `serializeFingerprint` order: autocomplete|name|id|semantic|aria|label|placeholder|heading|desc */
  const fp = (label: string, name = '') => `|${name}||${name}||${label}|||`;
  const phoneType: SelectQuestion = {
    fingerprint: fp('Phone Type', 'phone_type'),
    options: ['Mobile', 'Home', 'Work'],
  };

  it('takes an index into the options that were offered', () => {
    expect(validateOptionChoices({ '0': 1 }, [phoneType])).toEqual({ '0': 1 });
  });

  it('takes a label too, and resolves it to that option index', () => {
    // Small models answer with the label however the prompt is worded; a correct
    // answer must not be thrown away over its formatting.
    expect(validateOptionChoices({ '0': 'Work' }, [phoneType])).toEqual({ '0': 2 });
    expect(validateOptionChoices({ '0': ' mobile ' }, [phoneType])).toEqual({ '0': 0 });
    // A quoted index is a formatting habit, not a different answer.
    expect(validateOptionChoices({ '0': '1' }, [phoneType])).toEqual({ '0': 1 });
    // …but a quoted index still has to address an option that exists.
    expect(toOptionIndex('9', phoneType.options)).toBeNull();
  });

  it('refuses a label the page never offered — the model cannot invent one', () => {
    expect(validateOptionChoices({ '0': 'Landline' }, [phoneType])).toEqual({});
    expect(validateOptionChoices({ '0': 'Mobile phone' }, [phoneType])).toEqual({});
  });

  it('treats every flavour of "I do not know" as no answer', () => {
    for (const decline of ['', 'unknown', 'none', 'n/a', '-', '?']) {
      expect(validateOptionChoices({ '0': decline }, [phoneType])).toEqual({});
    }
    expect(toOptionIndex(null, phoneType.options)).toBeNull();
    expect(toOptionIndex(true, phoneType.options)).toBeNull();
    // A string that normalizes away is two absences agreeing, not a match.
    expect(toOptionIndex('???', phoneType.options)).toBeNull();
  });

  it('drops indices that address nothing — in either direction', () => {
    expect(validateOptionChoices({ '0': 9 }, [phoneType])).toEqual({});
    expect(validateOptionChoices({ '0': -1 }, [phoneType])).toEqual({});
    expect(validateOptionChoices({ '0': 1.5 }, [phoneType])).toEqual({});
    expect(validateOptionChoices({ '5': 0 }, [phoneType])).toEqual({});
    expect(validateOptionChoices({ notAnIndex: 0 }, [phoneType])).toEqual({});
    expect(validateOptionChoices([0], [phoneType])).toEqual({});
    expect(validateOptionChoices(null, [phoneType])).toEqual({});
  });

  /**
   * The rule the whole feature stands on. The batch these answers arrive against
   * should never have contained a protected question — this is the check on the
   * *other* side of the network, and it holds even if it did.
   */
  it.each([
    ['an age question', fp('Are you at least 18 years of age or older?', 'age_18')],
    ['a drinking-age question', fp('Are you of required legal drinking age?', 'drinking_age')],
    ['a work-authorisation question', fp('Are you authorized to work in the US?', 'work_auth')],
    ['a criminal record', fp('Have you ever been convicted of a felony?', 'conviction')],
    ['military service', fp('Are you a protected veteran?', 'veteran')],
    ['a disability', fp('Do you have a disability?', 'disability')],
    ['a protected characteristic', fp('Gender', 'gender')],
    ['a consent', fp('Human Resources may contact me regarding other positions', 'hr_contact')],
    ['an attestation', fp('Is your work experience included on your resume?', 'resume_ok')],
    ['a level of education', fp('Please list your highest level of education achieved', 'edu')],
  ])('ignores a model that answered %s', (_case, fingerprint) => {
    const question: SelectQuestion = { fingerprint, options: ['Alpha', 'Beta', 'Gamma'] };
    expect(validateOptionChoices({ '0': 1 }, [question])).toEqual({});
    expect(validateOptionChoices({ '0': 'Beta' }, [question])).toEqual({});
  });

  it('ignores an answer to a yes/no list even when the wording says nothing', () => {
    const question: SelectQuestion = {
      fingerprint: fp('Položka 42', 'q_42'),
      options: ['Ano', 'Ne'],
    };
    expect(validateOptionChoices({ '0': 0 }, [question])).toEqual({});
  });

  it('states the refusals in the prompt as well, and shows the options numbered', () => {
    const prompt = buildOptionChoicePrompt([phoneType]);
    expect(prompt).toContain('0: "Mobile"');
    expect(prompt).toContain('2: "Work"');
    expect(prompt).toContain('Phone Type');
  });
});

describe('chooseSelectOptions (the dropdown request)', () => {
  const fp = (label: string, name = '') => `|${name}||${name}||${label}|||`;
  const phoneType: SelectQuestion = {
    fingerprint: fp('Phone Type', 'phone_type'),
    options: ['Mobile', 'Home', 'Work'],
  };

  function reply(content: string): Response {
    return jsonResponse({ choices: [{ message: { content } }] });
  }

  it('asks, and answers with the option index', async () => {
    fetchMock.mockResolvedValueOnce(reply('{"0": 0}'));
    await expect(chooseSelectOptions([phoneType], groqEndpoint)).resolves.toEqual({ '0': 0 });
  });

  it('leaves the dropdowns alone when the model returns invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(reply('not json at all'));
    await expect(chooseSelectOptions([phoneType], groqEndpoint)).resolves.toEqual({});
  });

  it('treats an empty completion as "no answer", not as a parse failure', async () => {
    fetchMock.mockResolvedValueOnce(reply('   '));
    await expect(chooseSelectOptions([phoneType], groqEndpoint)).resolves.toEqual({});
  });

  it('makes no request at all when there is nothing askable', async () => {
    await expect(chooseSelectOptions([], groqEndpoint)).resolves.toEqual({});
    // A yes/no list is not askable, so a batch of one is a batch of none.
    await expect(
      chooseSelectOptions([{ fingerprint: fp('Anything'), options: ['Yes', 'No'] }], groqEndpoint),
    ).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines without a key, and without a request or an error', async () => {
    await expect(
      chooseSelectOptions([phoneType], { ...groqEndpoint, apiKey: '' }),
    ).resolves.toEqual({});
    await expect(
      chooseSelectOptions([phoneType], { ...groqEndpoint, baseUrl: '' }),
    ).resolves.toEqual({});
    await expect(
      chooseSelectOptions([phoneType], { ...groqEndpoint, apiKey: 'sk-or-v1-abcdef' }),
    ).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The egress point applies the policy itself. A caller that assembled a batch
   * without it — a stale content script, a message forged from elsewhere —
   * cannot make this function put a protected question on the wire.
   */
  it('filters the batch again before the bytes leave the browser', async () => {
    fetchMock.mockResolvedValueOnce(reply('{"0": 0}'));

    await chooseSelectOptions(
      [
        { fingerprint: fp('Are you at least 18 years of age or older?'), options: ['Yes', 'No'] },
        { fingerprint: fp('Do you have a disability?'), options: ['I do', 'I do not', 'Decline'] },
        phoneType,
      ],
      groqEndpoint,
    );

    // The batch itself, not the rules: the system prompt names these categories
    // on purpose, and it is the user half that says what is on this page.
    const { messages } = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
      messages: { content: string }[];
    };
    const batch = messages[1].content;
    expect(batch).not.toContain('18 years');
    expect(batch).not.toContain('disability');
    expect(batch).not.toContain('I do not');
    expect(batch).toContain('Phone Type');
  });

  it('validates the reply against the filtered batch, not the caller list', async () => {
    // Index 0 in the caller's list is the refused question; index 0 in what was
    // actually sent is `Phone Type`, and that is what an answer of "0" means.
    fetchMock.mockResolvedValueOnce(reply('{"0": 1}'));

    const choices = await chooseSelectOptions(
      [{ fingerprint: fp('Are you at least 18?'), options: ['Yes', 'No'] }, phoneType],
      groqEndpoint,
    );

    expect(choices).toEqual({ '0': 1 });
  });

  it('never sends more than MAX_OPTION_SELECTS dropdowns', async () => {
    fetchMock.mockResolvedValueOnce(reply('{}'));
    const many = Array.from({ length: MAX_OPTION_SELECTS + 5 }, (_, i) => ({
      fingerprint: fp(`Category ${i}`),
      options: ['Alpha', 'Beta'],
    }));

    await chooseSelectOptions(many, groqEndpoint);

    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('Category 0');
    expect(body).toContain(`Category ${MAX_OPTION_SELECTS - 1}`);
    expect(body).not.toContain(`Category ${MAX_OPTION_SELECTS}`);
  });

  it('never sends a list long enough to be a country dropdown', async () => {
    fetchMock.mockResolvedValueOnce(reply('{}'));
    const countries = Array.from({ length: MAX_SELECT_OPTIONS + 200 }, (_, i) => `Country ${i}`);

    await chooseSelectOptions(
      [{ fingerprint: fp('Country', 'country'), options: countries }, phoneType],
      groqEndpoint,
    );

    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).not.toContain('Country 0');
    expect(body).toContain('Phone Type');
  });

  /**
   * What one request contains: the dropdowns' own identities and their own
   * option labels. Not the profile — the model is not told who is filling the
   * form in, only what the form offers.
   */
  it('puts nothing but the fingerprints and the option labels in the body (S-3)', async () => {
    fetchMock.mockResolvedValueOnce(reply('{}'));
    const profile = createEmptyProfile({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+420123456789',
      city: 'Praha',
      about: 'I build things that work.',
    });
    const secret = 'gsk_supersecretkeyvalue';

    await chooseSelectOptions([phoneType], { ...groqEndpoint, apiKey: secret });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = String(request.body);
    for (const value of Object.values(profile)) {
      if (value && value !== profile.id) expect(body).not.toContain(value);
    }
    expect(body).toContain('Phone Type');
    expect(body).toContain('Mobile');
    expect(body).not.toContain(secret);
    expect((request.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`);
  });
});

describe('the medium ceiling (FR-5.3)', () => {
  it('is the only confidence an LLM-derived field can have', () => {
    expect(LLM_FIELD_CONFIDENCE).toBe('medium');
    // @ts-expect-error — `LlmFieldConfidence` has exactly one inhabitant, so
    // there is no expression anywhere that can raise a model-derived match to
    // `high`. This line failing to error is the regression.
    const raised: LlmFieldConfidence = 'high';
    expect(raised).toBe('high');
  });

  it('gives the model no channel to ask for a confidence at all', () => {
    const reply: FromBackgroundMessage = { type: 'CLASSIFY_RESULT', templates: { '0': '{email}' } };
    expect(Object.keys(reply).sort()).toEqual(['templates', 'type']);
    // The wire carries templates and nothing else — there is no field on it
    // through which a model could ask to be trusted more.
    // @ts-expect-error — no `confidence` field exists on the wire, by design.
    const smuggled: FromBackgroundMessage = { type: 'CLASSIFY_RESULT', templates: {}, confidence: 'high' };
    expect(smuggled).toBeTruthy();
  });
});

describe('provider selection', () => {
  it('recognises the four key prefixes that matter, before any request', () => {
    expect(identifyKeyOrigin('gsk_abc123')?.id).toBe('groq');
    expect(identifyKeyOrigin('sk-or-v1-abc123')?.id).toBe('openrouter');
    expect(identifyKeyOrigin('sk-proj-abc123')?.id).toBe('openai');
    expect(identifyKeyOrigin('sk-abc123')?.id).toBe('openai');
    expect(identifyKeyOrigin('sk-ant-abc123')?.id).toBe('anthropic');
    // Together's keys are bare hex: unknown is a normal answer, not a warning.
    expect(identifyKeyOrigin('a'.repeat(64))).toBeNull();
    expect(identifyKeyOrigin('')).toBeNull();
  });

  /** The hour this cost: an OpenRouter key, a Groq endpoint, "Invalid API Key". */
  it('names both sides of a mismatch and says how to fix it', () => {
    const warning = keyProviderMismatch('groq', 'sk-or-v1-abc');
    expect(warning).toMatch(/OpenRouter/);
    expect(warning).toMatch(/Groq/);
    expect(warning).toMatch(/Switch Provider to OpenRouter/);

    expect(keyProviderMismatch('groq', 'gsk_abc')).toBeNull();
    expect(keyProviderMismatch('openrouter', 'sk-or-v1-abc')).toBeNull();
    // Nothing is known about a self-hosted endpoint's keys, so nothing is said.
    expect(keyProviderMismatch('custom', 'sk-or-v1-abc')).toBeNull();
    expect(keyProviderMismatch('groq', 'whatever')).toBeNull();
  });

  it('says so plainly when the key is for a service we cannot use at all', () => {
    expect(keyProviderMismatch('groq', 'sk-ant-abc')).toMatch(/not an OpenAI-compatible provider/);
  });

  it('refuses to post a foreign key to the wrong company', async () => {
    const err = await rejection<GroqApiError>(
      generateMotivation({}, createEmptyProfile(), { ...groqEndpoint, apiKey: 'sk-or-v1-x' }),
    );
    expect(err.kind).toBe('WRONG_PROVIDER');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('means Groq, with its old URL and old default model, when nothing is stored', () => {
    const endpoint = buildEndpoint({ apiKey: 'gsk_x' });
    expect(endpoint.providerId).toBe('groq');
    expect(endpoint.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(endpoint.model).toBe('llama-3.3-70b-versatile');
    // Junk in storage is not a reason to change where requests go.
    expect(buildEndpoint({ providerId: 'nonsense' }).baseUrl).toBe(endpoint.baseUrl);
    expect(providerOf(undefined).id).toBe('groq');
  });

  it('gives each provider its own default model', () => {
    expect(buildEndpoint({ providerId: 'openrouter' }).model).toBe(
      'meta-llama/llama-3.3-70b-instruct',
    );
    expect(buildEndpoint({ providerId: 'openai' }).model).toBe('gpt-4o-mini');
  });

  it('sends the request to the selected provider, with its headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const endpoint = buildEndpoint({ providerId: 'openrouter', apiKey: 'sk-or-v1-x' });

    await generateMotivation({}, createEmptyProfile(), endpoint);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>)['X-Title']).toBe('JobFill');
  });

  it('only lets an https URL reach fetch', () => {
    expect(validateBaseUrl('https://example.com/v1')).toBeUndefined();
    expect(validateBaseUrl('http://example.com/v1')).toMatch(/https/);
    expect(validateBaseUrl('')).toMatch(/No API URL/);
    expect(validateBaseUrl('not a url')).toMatch(/not a valid URL/);
    expect(validateBaseUrl('https://user:pw@example.com/v1')).toMatch(/username and password/);
    expect(validateBaseUrl('https://example.com/v1?key=1')).toMatch(/after the path/);
  });

  it('normalises what people actually paste', () => {
    expect(normalizeBaseUrl('https://example.com/v1/')).toBe('https://example.com/v1');
    expect(normalizeBaseUrl('https://example.com/v1/chat/completions')).toBe(
      'https://example.com/v1',
    );
    expect(normalizeBaseUrl('  https://example.com/v1  ')).toBe('https://example.com/v1');
  });

  it('never sends a custom-provider request to a leftover URL', () => {
    // Switching to a named provider must not keep the custom endpoint alive.
    expect(buildEndpoint({ providerId: 'groq', customBaseUrl: 'https://evil.test/v1' }).baseUrl).toBe(
      'https://api.groq.com/openai/v1',
    );
    expect(buildEndpoint({ providerId: 'custom', customBaseUrl: '' }).baseUrl).toBe('');
    expect(buildEndpoint({ providerId: 'custom' }).baseUrl).toBe('');
  });

  it('reduces a base URL to the host permission it needs', () => {
    expect(originPattern('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/*');
    expect(originPattern('https://llm.internal:8443/v1')).toBe('https://llm.internal:8443/*');
    // A URL that does not parse yields no permission rather than a wildcard —
    // this feeds `chrome.permissions.request`, so guessing would be a grant.
    expect(originPattern('not a url')).toBeNull();
    expect(originPattern('')).toBeNull();
  });

  it('gives every built-in provider a requestable origin', () => {
    for (const id of PROVIDER_IDS) {
      const provider = PROVIDERS[id];
      // `custom` has no built-in URL; the user supplies one and it is validated.
      if (!provider.baseUrl) {
        expect(provider.id).toBe('custom');
        continue;
      }
      expect(originPattern(provider.baseUrl)).toMatch(/^https:\/\/[^/]+\/\*$/);
      expect(validateBaseUrl(provider.baseUrl)).toBeUndefined();
      expect(provider.defaultModel).not.toBe('');
    }
  });
});

// ─── groq.ts — the rest of the failure taxonomy ───────────────────────────────

describe('the LLM client at its edges', () => {
  const profile = createEmptyProfile({ firstName: 'Ada', about: 'Engineer' });

  it('says an endpoint has no URL instead of fetching the empty string', async () => {
    // `custom` with nothing typed yet. Requesting "" would be a same-origin GET
    // against the extension itself, which fails in a way that reads like a bug.
    const unconfigured = buildEndpoint({ providerId: 'custom', apiKey: 'k' });

    const chat = await rejection<GroqApiError>(generateMotivation({}, profile, unconfigured));
    expect(chat.kind).toBe('BAD_REQUEST');
    expect(chat.message).toMatch(/No API URL is configured for your endpoint/);

    const list = await rejection<GroqApiError>(listModels(unconfigured));
    expect(list.kind).toBe('BAD_REQUEST');
    expect(list.message).toMatch(/No API URL is configured/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 408 onto TIMEOUT rather than "the request was bad"', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('RAW_TIMEOUT_TEXT', 408, 'text/plain'));
    const err = await rejection<GroqApiError>(generateMotivation({}, profile, groqEndpoint));
    expect(err.kind).toBe('TIMEOUT');
    expect(err.message).toMatch(/timed out/i);
    expect(err.message).not.toContain('RAW_TIMEOUT_TEXT');
  });

  it('reads a transport failure — which carries no body at all — as a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = await rejection<GroqApiError>(generateMotivation({}, profile, groqEndpoint));
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.detail).toBeUndefined();
  });

  it('does not crash when the provider answers a bare `null`', async () => {
    // A proxy that answers `null` with a JSON content type used to throw a raw
    // TypeError out of the client, past every translation this file exists for.
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    const err = await rejection<GroqApiError>(generateMotivation({}, profile, groqEndpoint));
    expect(err).toBeInstanceOf(GroqApiError);
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.message).not.toMatch(/undefined|TypeError/);
  });

  it('returns an empty string when the choice carries no content', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{}] }));
    await expect(generateMotivation({}, profile, groqEndpoint)).resolves.toBe('');
  });

  it('quotes error.message only when it is actually a string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: { nested: 'oops' } } }, 401));
    const err = await rejection<GroqApiError>(generateMotivation({}, profile, groqEndpoint));
    expect(err.kind).toBe('UNAUTHORIZED');
    expect(err.detail).toBeUndefined();
    expect(err.message).not.toMatch(/said:/);
    expect(err.message).not.toContain('oops');
  });

  it('does not invent a model name when the endpoint has none configured', async () => {
    // `custom` has no default model, so a bad-model error has nothing to quote.
    const custom = buildEndpoint({ providerId: 'custom', apiKey: 'k', customBaseUrl: 'https://llm.test/v1' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'no such model' } }, 404));

    const err = await rejection<GroqApiError>(generateMotivation({}, profile, custom));
    expect(err.kind).toBe('BAD_MODEL');
    expect(err.message).toMatch(/does not serve the configured model/);
    expect(err.message).not.toMatch(/“”/);
  });

  it('keeps a 400 with an unreadable body as BAD_REQUEST, not BAD_MODEL', async () => {
    // Nothing says "model", so the only honest answer is the generic one — the
    // opposite mistake (guessing BAD_MODEL) sends the user to change a setting
    // that is fine.
    fetchMock.mockResolvedValueOnce(textResponse('<html>Bad Request</html>', 400));
    const err = await rejection<GroqApiError>(generateMotivation({}, profile, groqEndpoint));
    expect(err.kind).toBe('BAD_REQUEST');
    expect(err.detail).toBeUndefined();
    expect(err.message).not.toContain('<html>');
  });

  it('writes the motivation in the language of the posting', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] })),
    );

    await generateMotivation({ description: 'Hledáme vývojáře se zkušeností.' }, profile, groqEndpoint);
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('in Czech');

    await generateMotivation({ description: 'We are looking for a developer.' }, profile, groqEndpoint);
    expect(String(fetchMock.mock.calls[1][1].body)).toContain('in English');
  });
});

/**
 * A key is a credential, so the check that it is addressed to the right company
 * has to happen on *every* path that puts it on the wire — not just the one the
 * first bug report came through.
 */
describe('WRONG_PROVIDER never reaches the network', () => {
  it.each([
    ['generateMotivation', (e: LlmEndpoint) => generateMotivation({}, createEmptyProfile(), e)],
    ['probeModel', (e: LlmEndpoint) => probeModel(e)],
    ['listModels', (e: LlmEndpoint) => listModels(e)],
  ])('%s refuses a foreign key before opening a socket', async (_name, call) => {
    const foreign = { ...groqEndpoint, apiKey: 'sk-or-v1-notgroqs' };
    const err = await rejection<GroqApiError>(call(foreign));
    expect(err.kind).toBe('WRONG_PROVIDER');
    expect(err.message).toMatch(/Switch Provider to OpenRouter/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so plainly for a key no provider here can use', async () => {
    const anthropic = { ...groqEndpoint, apiKey: 'sk-ant-abc' };
    const err = await rejection<GroqApiError>(listModels(anthropic));
    expect(err.kind).toBe('WRONG_PROVIDER');
    expect(err.message).toMatch(/not an OpenAI-compatible provider/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listModels across the two catalogue modes', () => {
  it('asks an account-scoped provider what this key may use', async () => {
    expect(PROVIDERS.groq.catalogue).toBe('account');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 42 }, { id: '' }, {}] }),
    );

    const endpoint = buildEndpoint({ providerId: 'groq', apiKey: 'gsk_x' });
    await expect(listModels(endpoint)).resolves.toEqual(['alpha', 'zeta']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_x');
  });

  it('asks a catalogue-scoped provider the same question, with its headers', async () => {
    expect(PROVIDERS.openrouter.catalogue).toBe('catalogue');
    expect(PROVIDERS.openrouter.modelsPageUrl).toMatch(/^https:/);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'z/one' }, { id: 'a/two' }] }));

    const endpoint = buildEndpoint({ providerId: 'openrouter', apiKey: 'sk-or-v1-x' });
    await expect(listModels(endpoint)).resolves.toEqual(['a/two', 'z/one']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    expect((init.headers as Record<string, string>)['X-Title']).toBe('JobFill');
  });

  it('treats an answer with no data array as an empty list, not a failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(listModels(buildEndpoint({ providerId: 'groq', apiKey: 'gsk_x' }))).resolves.toEqual(
      [],
    );
  });

  it('reports a rate-limited catalogue read like any other failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'Rate limit reached' } }, 429),
    );
    const err = await rejection<GroqApiError>(
      listModels(buildEndpoint({ providerId: 'together', apiKey: 'beefcafe' })),
    );
    expect(err.kind).toBe('RATE_LIMITED');
    expect(err.detail).toBe('Rate limit reached');
  });

  it('probes the configured model over the very URL a fill would use', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const endpoint = buildEndpoint({ providerId: 'openai', apiKey: 'sk-proj-x' });

    await probeModel(endpoint);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 1 });
  });
});

describe('answerOpenQuestions (FR-5.2)', () => {
  const profile = createEmptyProfile({ firstName: 'Ada', lastName: 'Lovelace', about: 'Engineer' });

  it('returns one answer per question, in the order they were asked', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '["first","second"]' } }] }),
    );
    await expect(
      answerOpenQuestions(['Why us?', 'When can you start?'], profile, {}, groqEndpoint),
    ).resolves.toEqual(['first', 'second']);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(String(body.messages[1].content)).toContain('1. Why us?');
  });

  it('unwraps the object that json_object mode insists on', async () => {
    for (const content of [
      '{"answers":["a","b"]}',
      '{"responses":["a","b"]}',
      '{"q1":"a","q2":"b"}',
    ]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content } }] }));
      await expect(answerOpenQuestions(['x', 'y'], profile, {}, groqEndpoint)).resolves.toEqual([
        'a',
        'b',
      ]);
    }
  });

  /**
   * A short or malformed answer leaves *blanks*, never a shifted set — an answer
   * landing under the wrong question is worse than no answer at all.
   */
  it('pads with empty strings rather than shifting answers up', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '["only"]' } }] }));
    await expect(answerOpenQuestions(['a', 'b', 'c'], profile, {}, groqEndpoint)).resolves.toEqual([
      'only',
      '',
      '',
    ]);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['a bare number', '42'],
    ['a literal null', 'null'],
    ['nothing at all', ''],
  ])('answers blanks when the model returns %s', async (_case, content) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content } }] }));
    await expect(answerOpenQuestions(['a', 'b'], profile, {}, groqEndpoint)).resolves.toEqual([
      '',
      '',
    ]);
  });

  it('drops a non-string entry instead of writing "[object Object]" into a form', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '["ok",{"a":1}]' } }] }),
    );
    await expect(answerOpenQuestions(['a', 'b'], profile, {}, groqEndpoint)).resolves.toEqual([
      'ok',
      '',
    ]);
  });

  it('introduces the applicant by name when the profile has no summary', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '[]' } }] }));
    await answerOpenQuestions(
      ['Why us?'],
      createEmptyProfile({ firstName: 'Ada', lastName: 'Lovelace' }),
      {},
      groqEndpoint,
    );
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('Ada Lovelace');
  });

  it('refuses without a key, and asks nothing for an empty question list', async () => {
    const err = await rejection<GroqApiError>(
      answerOpenQuestions(['a'], profile, {}, { ...groqEndpoint, apiKey: '' }),
    );
    expect(err.kind).toBe('MISSING_KEY');

    await expect(answerOpenQuestions([], profile, {}, groqEndpoint)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the questions themselves to pick a language', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ choices: [{ message: { content: '[]' } }] })),
    );

    // No description — the questions are the only evidence there is.
    await answerOpenQuestions(['Proč chcete pracovat u nás?'], profile, {}, groqEndpoint);
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('in Czech');

    // A description outranks them when there is one.
    await answerOpenQuestions(
      ['Proč chcete pracovat u nás?'],
      profile,
      { description: 'An English posting.' },
      groqEndpoint,
    );
    expect(String(fetchMock.mock.calls[1][1].body)).toContain('in English');
  });
});

// ─── http.ts — the paths a healthy server never takes ─────────────────────────

describe('httpRequest at its edges', () => {
  it('maps 408 and 410 the way the client needs them', async () => {
    for (const [status, kind] of [
      [408, 'TIMEOUT'],
      [410, 'NOT_FOUND'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(textResponse('', status, 'text/plain'));
      const err = await rejection<HttpError>(httpRequest('https://x.test', { service: 'X' }));
      expect(err.kind).toBe(kind);
    }
  });

  it('survives a response whose body cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 500, text: () => Promise.reject(new Error('stream died')) }),
    );
    const err = await rejection<HttpError>(httpRequest('https://x.test', { service: 'X' }));
    expect(err.kind).toBe('SERVER_ERROR');
    expect(err.body).toBe('');
    // No Content-Type header at all is `undefined`, not the string "null".
    expect(err.contentType).toBeUndefined();
  });

  it('still names the service when fetch rejects with nothing useful', async () => {
    fetchMock.mockRejectedValueOnce(undefined);
    const err = await rejection<HttpError>(httpRequest('https://x.test', { service: 'Notion' }));
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.message).toBe('Could not reach Notion: network error.');
  });
});

// ─── notion.ts — schema details and error translation ─────────────────────────

describe('Notion schema discovery details', () => {
  it('reads select/status options off the database and ignores nameless ones', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        properties: {
          Name: { name: 'Name', type: 'title' },
          Stav: { name: 'Stav', type: 'status', status: { options: [{ name: 'Submitted' }, { name: '' }, {}] } },
          Kind: { type: 'select', select: { options: [] } },
          Weird: { name: 'Weird' },
        },
      }),
    );

    const report = await inspectNotionDatabase('secret_token', 'db-options');

    expect(report.mapping.status).toEqual({ name: 'Stav', type: 'status', options: ['Submitted'] });
    // An empty option list is not an option list — the key is left off entirely.
    expect(report.available.find((p) => p.name === 'Kind')).toEqual({ name: 'Kind', type: 'select' });
    // A property with no declared type still has to be listed, or the hint the
    // options page shows would be missing the very column that is in the way.
    expect(report.available.find((p) => p.name === 'Weird')?.type).toBe('unknown');
  });

  it('translates a 404 on the database read', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'object_not_found', message: 'Could not find database with ID.' }, 404),
    );
    const err = await rejection<RemoteLogError>(inspectNotionDatabase('secret_token', 'db-404'));
    expect(err.kind).toBe('NOT_FOUND');
    expect(err.message).toMatch(/Check the database ID/);
    expect(err.detail).toBe('Could not find database with ID.');
    expect(err.retryable).toBe(false);
  });

  it('reports a database with no properties at all as unusable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const report = await inspectNotionDatabase('secret_token', 'db-empty');
    expect(report.usable).toBe(false);
    expect(report.available).toEqual([]);
    expect(report.missing.join(' ')).toMatch(/Title property/i);
  });

  it('keeps an HTML error page out of the sentence it shows', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<html>Access denied</html>', 401));
    const err = await rejection<RemoteLogError>(inspectNotionDatabase('secret_token', 'db-html'));
    expect(err.kind).toBe('UNAUTHORIZED');
    // Nothing parseable to quote → nothing is quoted, rather than the raw page.
    expect(err.detail).toBeUndefined();
    expect(err.message).not.toContain('<html>');
  });

  it('quotes `message` only when it is a string', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'unauthorized', message: { nested: 'oops' } }, 401),
    );
    const err = await rejection<RemoteLogError>(inspectNotionDatabase('secret_token', 'db-odd'));
    expect(err.kind).toBe('UNAUTHORIZED');
    expect(err.detail).toBeUndefined();
  });

  it('explains a rejected write even when Notion sends no message with it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ properties: { Name: { name: 'Name', type: 'title' } } }),
      )
      .mockResolvedValueOnce(textResponse('Bad Request', 400, 'text/plain'));

    const err = await rejection<RemoteLogError>(logToNotion(entry, 'secret_token', 'db-400-bare'));
    expect(err.kind).toBe('SCHEMA_MISMATCH');
    expect(err.message).toMatch(/do not match what JobFill sends/);
  });

  it('falls back to the shared copy for a status it has no advice for', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<html>502</html>', 502));
    const err = await rejection<RemoteLogError>(inspectNotionDatabase('secret_token', 'db-502'));
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('explains a transport failure, which arrives with no body at all', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = await rejection<RemoteLogError>(inspectNotionDatabase('secret_token', 'db-offline'));
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.detail).toMatch(/Failed to fetch/);
  });
});

describe('Notion properties for a sparse entry', () => {
  it('omits every slot the entry has nothing for', () => {
    const blank = createApplicationEntry({ profileId: '', url: '' });
    const props = buildNotionProperties(blank, buildMapping(canonicalProps).mapping);

    expect(props.Company).toBeUndefined();
    expect(props.URL).toBeUndefined();
    expect(props.Profile).toBeUndefined();
    // The title always has something to say — that is what its fallback is for.
    expect(props.Name).toEqual({ title: [{ text: { content: 'Job application' } }] });
  });

  it('skips a property whose type JobFill does not know how to write', () => {
    const props = buildNotionProperties(entry, {
      title: { name: 'Name', type: 'title' },
      company: { name: 'Owner', type: 'people' },
    });
    expect(props.Name).toBeDefined();
    expect(props.Owner).toBeUndefined();
  });
});

// ─── sheets.ts — error translation ────────────────────────────────────────────

describe('logToSheets error translation', () => {
  const endpoint = 'https://script.google.com/macros/s/AKfy123/exec';

  it('reads a 401/403 as a deployment sharing problem', async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValueOnce(textResponse('denied', status, 'text/plain'));
      const err = await rejection<RemoteLogError>(logToSheets(entry, endpoint));
      expect(err.kind).toBe('UNAUTHORIZED');
      expect(err.message).toMatch(/Execute as: Me/);
      expect(err.retryable).toBe(false);
    }
  });

  it('reads a 404 as a stale deployment URL', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('', 404, 'text/plain'));
    const err = await rejection<RemoteLogError>(logToSheets(entry, endpoint));
    expect(err.kind).toBe('NOT_FOUND');
    expect(err.message).toMatch(/copy the new \/exec URL/);
  });

  it('falls back to the shared copy for anything else', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('slow down', 429, 'text/plain'));
    const err = await rejection<RemoteLogError>(logToSheets(entry, endpoint));
    expect(err.kind).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
  });

  /** A wrong URL is a different fix from a missing one, so it is a different kind. */
  it('rejects a syntactically wrong URL as NOT_FOUND, without a request', async () => {
    const err = await rejection<RemoteLogError>(logToSheets(entry, 'https://evil.example.com/exec'));
    expect(err.kind).toBe('NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets an HTML answer that is not a sign-in page through', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<html><body>Logged</body></html>'));
    await expect(logToSheets(entry, endpoint)).resolves.toBeUndefined();
  });

  it('accepts a response that declares no content type at all', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
    await expect(logToSheets(entry, endpoint)).resolves.toBeUndefined();
  });

  it('does not turn an unreadable body into a sign-in accusation', async () => {
    // The body is only read to *recognise* the sign-in page; failing to read it
    // is not evidence that it was one.
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        ok: true,
        status: 200,
        contentType: 'text/html',
        text: () => Promise.reject(new Error('stream died')),
      }),
    );
    await expect(logToSheets(entry, endpoint)).resolves.toBeUndefined();
  });
});

// ─── remoteLog.ts — the non-HTTP fallback ─────────────────────────────────────

describe('toRemoteLogError for things that are not HTTP failures', () => {
  it('keeps the thrown message as detail and never as the message', () => {
    const err = toRemoteLogError(new Error('ReferenceError deep inside'), 'Notion');
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.detail).toBe('ReferenceError deep inside');
    expect(err.message).toBe(`Notion: ${'Could not reach the logging backend. The entry is saved locally.'}`);
  });

  it('stringifies a non-Error throwable', () => {
    expect(toRemoteLogError('a bare string', 'Notion').detail).toBe('a bare string');
    expect(toRemoteLogError(undefined, 'Notion').detail).toBe('undefined');
  });

  it('lets a client override the copy without losing the evidence', () => {
    const err = toRemoteLogError(new Error('boom'), 'Notion', {
      NETWORK_ERROR: 'Could not reach the Apps Script Web App.',
    });
    expect(err.message).toBe('Could not reach the Apps Script Web App.');
    expect(err.detail).toBe('boom');
  });
});

describe('key shape is checked before the key is used', () => {
  it('rejects an OpenRouter key that lost its leading character', () => {
    // Selecting a key in a browser and clipping the first character is ordinary.
    // `k-or-v1-…` matches no provider's prefix, so the mismatch check said
    // nothing, OpenRouter's public catalogue answered anyway, and the UI reported
    // the key as accepted right before the first real request failed.
    const problem = provider.keyFormatProblem('openrouter', 'k-or-v1-abcdef0123456789');
    expect(problem).toContain('sk-or-v1-');
    expect(problem).toContain('openrouter.ai/keys');
  });

  it('accepts a well-formed key for each provider that has a known prefix', () => {
    expect(provider.keyFormatProblem('openrouter', 'sk-or-v1-abcdef')).toBeNull();
    expect(provider.keyFormatProblem('groq', 'gsk_abcdef')).toBeNull();
    expect(provider.keyFormatProblem('openai', 'sk-proj-abcdef')).toBeNull();
  });

  it('says nothing about providers whose key format is not fixed', () => {
    // Together issues bare hex; a self-hosted endpoint can want anything.
    expect(provider.keyFormatProblem('together', 'deadbeef')).toBeNull();
    expect(provider.keyFormatProblem('custom', 'whatever')).toBeNull();
  });

  it('leaves a recognisable key from elsewhere to the mismatch check', () => {
    // Two different failures deserve two different sentences: this one is a real
    // OpenRouter key, and the useful advice is "switch provider", not "recopy it".
    expect(provider.keyFormatProblem('groq', 'sk-or-v1-abcdef')).toBeNull();
    expect(provider.keyProviderMismatch('groq', 'sk-or-v1-abcdef')).toContain('OpenRouter');
  });

  it('ignores an empty field — that is the missing-key message, not a format one', () => {
    expect(provider.keyFormatProblem('openrouter', '   ')).toBeNull();
  });
});
