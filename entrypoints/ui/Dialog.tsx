import { useEffect, useRef } from 'react';

/**
 * Replacement for `confirm()` / `alert()`.
 *
 * Built on the native <dialog> element: focus trapping, Esc-to-close, inert
 * background and the top layer come from the platform, so no focus-management
 * code (or Radix dependency) is needed.
 */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Esc and backdrop dismissal both funnel through the dialog's own events.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancelEvent = (e: Event) => {
      e.preventDefault();
      onCancel();
    };
    el.addEventListener('cancel', onCancelEvent);
    return () => el.removeEventListener('cancel', onCancelEvent);
  }, [onCancel]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="jf-dialog-title"
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1.5">
          <h2 id="jf-dialog-title" className="section-title">
            {title}
          </h2>
          {description && <p className="section-desc">{description}</p>}
        </div>
        <div className="flex items-center justify-end gap-2">
          {/* Cancel is focused first on purpose: showModal() focuses the first
              focusable child, and the safe choice should be the default. */}
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger border border-line-strong' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
