import { HttpError, type HttpErrorKind } from './http';
import { REMOTE_LOG_ERROR_MESSAGES, type RemoteLogErrorKind } from '../messages';

/**
 * Error raised by the Notion / Sheets clients: a UI-ready message plus a
 * `retryable` flag consumed by the retry queue.
 */
export class RemoteLogError extends Error {
  constructor(
    public readonly kind: RemoteLogErrorKind,
    /** Human-readable, actionable. Safe to render as-is. */
    message: string,
    /** Raw backend text — logged, never shown. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'RemoteLogError';
  }

  /** Only transport-level failures are worth a second attempt. */
  get retryable(): boolean {
    return (
      this.kind === 'TIMEOUT' ||
      this.kind === 'NETWORK_ERROR' ||
      this.kind === 'RATE_LIMITED' ||
      this.kind === 'BAD_RESPONSE'
    );
  }
}

const HTTP_TO_LOG_KIND: Record<HttpErrorKind, RemoteLogErrorKind> = {
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  BAD_REQUEST: 'SCHEMA_MISMATCH',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_ERROR: 'NETWORK_ERROR',
  BAD_RESPONSE: 'BAD_RESPONSE',
};

/**
 * Convert anything thrown inside a logging client into a `RemoteLogError`.
 * `overrides` replaces the generic copy with service-specific guidance.
 */
export function toRemoteLogError(
  err: unknown,
  service: string,
  overrides: Partial<Record<RemoteLogErrorKind, string>> = {},
): RemoteLogError {
  if (err instanceof RemoteLogError) return err;

  if (err instanceof HttpError) {
    const kind = HTTP_TO_LOG_KIND[err.kind];
    const message = overrides[kind] ?? `${service}: ${REMOTE_LOG_ERROR_MESSAGES[kind]}`;
    return new RemoteLogError(kind, message, err.body ?? err.message);
  }

  return new RemoteLogError(
    'NETWORK_ERROR',
    overrides.NETWORK_ERROR ?? `${service}: ${REMOTE_LOG_ERROR_MESSAGES.NETWORK_ERROR}`,
    err instanceof Error ? err.message : String(err),
  );
}
