import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { httpRequest, httpJson, HttpError } from '../shared/api/http';
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
  classifyFields,
  generateMotivation,
  validateClassification,
  GroqApiError,
} from '../shared/api/groq';
import { createApplicationEntry, createEmptyProfile } from '../shared/types';
import { MAX_CLASSIFY_FIELDS } from '../shared/messages';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Capture the rejection value of a promise with a precise type. */
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

// ─── notion.ts — schema discovery (P1-13) ─────────────────────────────────────

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

// ─── sheets.ts (P0-7) ─────────────────────────────────────────────────────────

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
    // Apps Script always 302s to script.googleusercontent.com (P0-7).
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
    const err = await rejection<GroqApiError>(generateMotivation({}, profile, '', 'model'));
    expect(err.kind).toBe('MISSING_KEY');
    expect(err.message).toMatch(/Settings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 401 / 429 / 5xx onto distinct, actionable messages', async () => {
    const cases: Array<[number, string, RegExp]> = [
      [401, 'UNAUTHORIZED', /invalid or expired/i],
      [429, 'RATE_LIMITED', /rate limit/i],
      [500, 'NETWORK_ERROR', /network error/i],
    ];

    for (const [status, kind, copy] of cases) {
      fetchMock.mockResolvedValueOnce(textResponse('RAW_BACKEND_TEXT', status, 'text/plain'));
      const err = await rejection<GroqApiError>(generateMotivation({}, profile, 'key', 'model'));
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
    await expect(generateMotivation({}, profile, 'key', 'model')).resolves.toBe('Hello there.');
  });
});

describe('validateClassification (FR-5.3)', () => {
  it('keeps well-formed pairs', () => {
    expect(validateClassification({ '0': 'email', '1': 'firstName' }, 2)).toEqual({
      '0': 'email',
      '1': 'firstName',
    });
  });

  it('drops out-of-range indices, unknown types and non-objects', () => {
    expect(validateClassification({ '5': 'email' }, 2)).toEqual({});
    expect(validateClassification({ '0': 'socialSecurityNumber' }, 2)).toEqual({});
    expect(validateClassification({ '0': 42 }, 2)).toEqual({});
    expect(validateClassification({ notAnIndex: 'email' }, 2)).toEqual({});
    expect(validateClassification(['email'], 2)).toEqual({});
    expect(validateClassification(null, 2)).toEqual({});
  });

  it('treats "unknown" as no classification', () => {
    expect(validateClassification({ '0': 'unknown', '1': 'city' }, 2)).toEqual({ '1': 'city' });
  });

  it('leaves fields unclassified when the model returns invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: 'not json at all' } }] }),
    );
    await expect(classifyFields(['a', 'b'], 'key', 'model')).resolves.toEqual({});
  });

  it('does not call the API for an empty fingerprint list', async () => {
    await expect(classifyFields([], 'key', 'model')).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to make a request without a key', async () => {
    const err = await rejection<GroqApiError>(classifyFields(['a'], '', 'model'));
    expect(err.kind).toBe('MISSING_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** The egress point enforces the cap too — a caller cannot talk past it. */
  it('never sends more than MAX_CLASSIFY_FIELDS fingerprints', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: '{"0":"email"}' } }] }),
    );
    const many = Array.from({ length: MAX_CLASSIFY_FIELDS + 30 }, (_, i) => `fp_${i}`);

    await classifyFields(many, 'key', 'model');

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as {
      messages: { content: string }[];
    };
    const prompt = body.messages[0].content;
    expect(prompt).toContain('fp_0');
    expect(prompt).toContain(`fp_${MAX_CLASSIFY_FIELDS - 1}`);
    expect(prompt).not.toContain(`fp_${MAX_CLASSIFY_FIELDS}`);
  });

  it('validates the reply against the truncated batch, not the original list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: `{"0":"email","${MAX_CLASSIFY_FIELDS}":"phone"}` } }],
      }),
    );
    const many = Array.from({ length: MAX_CLASSIFY_FIELDS + 30 }, (_, i) => `fp_${i}`);

    // Index 40 was never sent, so an answer about it is a hallucination.
    await expect(classifyFields(many, 'key', 'model')).resolves.toEqual({ '0': 'email' });
  });

  /**
   * S-3 on the actual wire. The fingerprints below are what
   * `serializeFingerprint` produces for a filled form; the profile that filled it
   * must appear nowhere in the request.
   */
  it('puts nothing but the fingerprints in the request body (S-3)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const profile = createEmptyProfile({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+420123456789',
      about: 'I build things that work.',
    });

    await classifyFields(['||op|op||Preferred name|||', '|||||Start date|||'], 'key', 'model');

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = String(request.body);
    for (const value of Object.values(profile)) {
      if (value && value !== profile.id) expect(body).not.toContain(value);
    }
    expect(body).toContain('Preferred name');
    // The key travels in the header, as it must — not in the payload.
    expect(body).not.toContain('key');
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer key');
  });
});
