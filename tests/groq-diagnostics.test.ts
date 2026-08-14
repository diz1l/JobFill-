/**
 * Groq failure taxonomy.
 *
 * These exist because a retired model and a dead network used to be the same
 * message: `toGroqError` folded BAD_REQUEST / NOT_FOUND / SERVER_ERROR into
 * NETWORK_ERROR, so a user whose model had been decommissioned was told to
 * "check your connection". Groq's own reason was in `HttpError.body` the whole
 * time — carried and never read.
 *
 * Kept out of api.test.ts, which installs its own fetch double.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateMotivation, listModels, probeModel, GroqApiError,
} from '../shared/api/groq';
import { buildEndpoint } from '../shared/api/provider';
import { createEmptyProfile } from '../shared/types';

const at = (apiKey: string, model: string) => buildEndpoint({ providerId: 'groq', apiKey, model });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const profile = createEmptyProfile({ firstName: 'Ada', about: 'Engineer' });
async function fail(p: Promise<unknown>): Promise<GroqApiError> {
  try { await p; throw new Error('expected rejection'); } catch (e) { return e as GroqApiError; }
}

describe('the decommissioned-model case', () => {
  it('400 model_decommissioned is BAD_MODEL, not NETWORK_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: {
      message: 'The model `llama-3.3-70b-versatile` has been decommissioned and is no longer supported. Please refer to https://console.groq.com/docs/deprecations for a recommendation on which model to use instead.',
      type: 'invalid_request_error', code: 'model_decommissioned',
    } }, 400));
    const err = await fail(generateMotivation({}, profile, at('gsk_x', 'llama-3.3-70b-versatile')));
    expect(err.kind).toBe('BAD_MODEL');
    console.log('  400 decommissioned →', err.kind, '|', err.message);
  });

  it('404 model_not_found is BAD_MODEL and names the model', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: {
      message: 'The model `llama-9` does not exist or you do not have access to it.',
      code: 'model_not_found',
    } }, 404));
    const err = await fail(generateMotivation({}, profile, at('gsk_x', 'llama-9')));
    expect(err.kind).toBe('BAD_MODEL');
    expect(err.message).toContain('llama-9');
    console.log('  404 model_not_found →', err.kind, '|', err.message);
  });

  it('400 that is not about a model stays BAD_REQUEST', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: {
      message: "'temperature' must be <= 2", type: 'invalid_request_error',
    } }, 400));
    const err = await fail(generateMotivation({}, profile, at('gsk_x', 'llama-3.3-70b-versatile')));
    expect(err.kind).toBe('BAD_REQUEST');
    console.log('  400 other      →', err.kind, '|', err.message);
  });

  it('401 stays UNAUTHORIZED and now quotes Groq', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }, 401));
    const err = await fail(generateMotivation({}, profile, at('bad', 'llama-3.3-70b-versatile')));
    expect(err.kind).toBe('UNAUTHORIZED');
    console.log('  401            →', err.kind, '|', err.message);
  });

  it('5xx is still a network error, and never leaks the body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('RAW', { status: 503 }));
    const err = await fail(generateMotivation({}, profile, at('gsk_x', 'm')));
    expect(err.kind).toBe('NETWORK_ERROR');
    expect(err.message).not.toContain('RAW');
  });

  it('listModels sorts ids and maps a 401 to UNAUTHORIZED', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: 'zeta' }, { id: 'alpha' }, {}] }));
    await expect(listModels(at('gsk_x', 'm'))).resolves.toEqual(['alpha', 'zeta']);

    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Invalid API Key' } }, 401));
    expect((await fail(listModels(at('gsk_x', 'm')))).kind).toBe('UNAUTHORIZED');

    expect((await fail(listModels(at('', 'm')))).kind).toBe('MISSING_KEY');
  });

  it('probeModel sends exactly one token to the completions endpoint', async () => {
    fetchMock.mockResolvedValueOnce(json({ choices: [{ message: { content: 'ok' } }] }));
    await probeModel(at('gsk_x', 'llama-3.3-70b-versatile'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ max_tokens: 1, model: 'llama-3.3-70b-versatile' });
  });
});
