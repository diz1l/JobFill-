/**
 * Single fetch wrapper for every outbound request; all network traffic originates
 * in the background worker. It centralises a hard timeout via `AbortController`
 * so no request can hang forever, a uniform status → {@link HttpErrorKind} mapping
 * so callers branch on an enum instead of raw numbers, and a `retryable` flag the
 * remote-log retry queue uses to decide whether a second attempt makes sense.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

export type HttpErrorKind =
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'BAD_RESPONSE';

/** Kinds where a second attempt can plausibly succeed. */
const RETRYABLE: ReadonlySet<HttpErrorKind> = new Set<HttpErrorKind>([
  'TIMEOUT',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'SERVER_ERROR',
]);

export class HttpError extends Error {
  constructor(
    public readonly kind: HttpErrorKind,
    message: string,
    /** HTTP status, when the failure happened after a response was received. */
    public readonly status?: number,
    /** First 500 chars of the response body — for diagnostics, never for the UI. */
    public readonly body?: string,
    /** Response `Content-Type`, used to detect HTML error pages. */
    public readonly contentType?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/**
 * Status → kind. `BAD_REQUEST` is the deliberate fall-through: "understood the
 * request and refused it" covers 400 and every other unlisted 4xx (405, 409, …).
 * A 400 does not carry the *reason*, though — Groq answers both a retired model
 * (`{"error":{"code":"model_decommissioned"}}`) and a malformed request with one
 * — so that discrimination belongs in the service client, reading
 * {@link HttpError.body}, which is why the body is attached to every failure.
 * Do not flatten `BAD_REQUEST` into "network error": `api/groq.ts` used to, and
 * it masked every model error.
 */
function statusToKind(status: number): HttpErrorKind {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'BAD_REQUEST';
}

export interface HttpRequestOptions {
  /** Display name of the remote service, used verbatim in error messages. */
  service: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  redirect?: RequestRedirect;
}

/**
 * Perform a request and throw {@link HttpError} on anything that is not a 2xx.
 * The response body is consumed only on failure; on success the caller owns it.
 */
export async function httpRequest(url: string, opts: HttpRequestOptions): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      redirect: opts.redirect ?? 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    const error = err as Error | undefined;
    if (error?.name === 'AbortError') {
      throw new HttpError(
        'TIMEOUT',
        `${opts.service} did not respond within ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    throw new HttpError(
      'NETWORK_ERROR',
      `Could not reach ${opts.service}: ${error?.message ?? 'network error'}.`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(
      statusToKind(response.status),
      `${opts.service} returned HTTP ${response.status}.`,
      response.status,
      body.slice(0, 500),
      response.headers.get('content-type') ?? undefined,
    );
  }

  return response;
}

/** {@link httpRequest} + JSON parsing, with a typed failure on malformed bodies. */
export async function httpJson<T>(url: string, opts: HttpRequestOptions): Promise<T> {
  const response = await httpRequest(url, opts);
  try {
    return (await response.json()) as T;
  } catch {
    throw new HttpError('BAD_RESPONSE', `${opts.service} returned a malformed JSON response.`);
  }
}
