import type { ApplicationEntry } from '../types';
import { httpRequest, HttpError } from './http';
import { RemoteLogError, toRemoteLogError } from './remoteLog';

/** Apps Script cold starts are slow — allow more than the Groq budget. */
const TIMEOUT_MS = 20_000;

/**
 * Validate the endpoint before spending a request on it.
 * Returns a user-facing problem description, or `undefined` when it looks fine.
 */
export function validateSheetsEndpoint(endpoint: string): string | undefined {
  if (!endpoint) return 'Google Sheets is selected as the logging backend, but no Web App URL is set.';

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'The Google Sheets Web App URL is not a valid URL.';
  }

  if (url.protocol !== 'https:') return 'The Web App URL must start with https://.';

  if (url.hostname !== 'script.google.com' && url.hostname !== 'script.googleusercontent.com') {
    return 'The URL does not look like an Apps Script Web App (expected https://script.google.com/macros/s/…/exec).';
  }

  if (!url.pathname.endsWith('/exec')) {
    return 'Use the deployment URL that ends with /exec (not /dev — that one is private to you).';
  }

  return undefined;
}

/**
 * POST an application entry to a user-deployed Google Apps Script Web App.
 * The endpoint must accept a JSON POST with the `ApplicationEntry` shape.
 *
 * Apps Script *always* answers a Web App POST with a 302 to
 * `script.googleusercontent.com`, so `redirect: 'follow'` is required — and so is
 * `https://script.googleusercontent.com/*` in `host_permissions`, otherwise the
 * followed request is blocked and surfaces as an opaque network failure (P0-7).
 */
export async function logToSheets(entry: ApplicationEntry, endpoint: string): Promise<void> {
  const problem = validateSheetsEndpoint(endpoint);
  if (problem) {
    throw new RemoteLogError(endpoint ? 'NOT_FOUND' : 'NOT_CONFIGURED', problem);
  }

  let response: Response;
  try {
    response = await httpRequest(endpoint, {
      service: 'Google Sheets',
      method: 'POST',
      timeoutMs: TIMEOUT_MS,
      // text/plain avoids the CORS preflight that Apps Script cannot answer;
      // the script reads the raw body via e.postData.contents either way.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(entry),
      redirect: 'follow',
    });
  } catch (err) {
    throw toSheetsError(err);
  }

  // A Web App that is not shared with "Anyone" answers 200 with a Google sign-in
  // page instead of an error status. Detect it so the user gets a real hint.
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    const body = await response.text().catch(() => '');
    if (/sign in|accounts\.google\.com|Access denied|authorization/i.test(body)) {
      throw new RemoteLogError(
        'UNAUTHORIZED',
        'The Apps Script Web App requires sign-in. Re-deploy it with "Who has access: Anyone".',
        body.slice(0, 300),
      );
    }
  }
}

function toSheetsError(err: unknown): RemoteLogError {
  if (err instanceof HttpError) {
    if (err.kind === 'UNAUTHORIZED' || err.kind === 'FORBIDDEN') {
      return new RemoteLogError(
        'UNAUTHORIZED',
        'The Apps Script Web App denied the request. Re-deploy it with "Execute as: Me" and "Who has access: Anyone".',
        err.body,
      );
    }
    if (err.kind === 'NOT_FOUND') {
      return new RemoteLogError(
        'NOT_FOUND',
        'The Apps Script Web App URL was not found. Re-deploy the script and copy the new /exec URL.',
        err.body,
      );
    }
    if (err.kind === 'NETWORK_ERROR') {
      return new RemoteLogError(
        'NETWORK_ERROR',
        'Could not reach the Apps Script Web App. Note that it redirects to script.googleusercontent.com, which must be allowed in the extension manifest.',
        err.message,
      );
    }
  }
  return toRemoteLogError(err, 'Google Sheets');
}
