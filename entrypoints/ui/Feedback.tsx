import type { ReactNode } from 'react';
import { IconAlert, IconCheck } from './Icons';

/**
 * The three states every screen owes the user (PROJECT_AUDIT §7.2 rule 6):
 * loading (skeleton) / empty (explanation + call to action) / error.
 */

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line text-center ${
        compact ? 'px-4 py-6' : 'px-6 py-10'
      }`}
    >
      <span className="text-fg-subtle">{icon}</span>
      <p className="font-medium text-fg">{title}</p>
      {description && <p className="max-w-prose text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="banner-error" role="alert">
      <IconAlert className="mt-px size-4" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Transient "Saved" acknowledgement. Announced politely, never stealing focus. */
export function SavedFlag({ show, label = 'Saved' }: { show: boolean; label?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1 text-base text-success transition-opacity ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <IconCheck className="size-4" />
      {show ? label : ''}
    </span>
  );
}

/** Fixed-height placeholder so the surface never reflows when data lands. */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
