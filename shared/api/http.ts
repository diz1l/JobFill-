/**
 * Single fetch wrapper for every outbound request of the extension (S-2: all
 * network traffic originates in the background worker).
 *
 * It guarantees three things that were previously copy-pasted or missing:
 *   1. a hard timeout via `AbortController` (no request can hang forever);
 *   2. a uniform status → {@link HttpErrorKind} mapping, so callers branch on an
 *      enum instead of on raw numbers;
 *   3. a `retryable` flag, which the remote-logging retry queue uses to decide
 *      whether a second attempt makes sense (FR-6.3).
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
