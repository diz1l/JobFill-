import { useId } from 'react';
import { IconChevronDown } from './Icons';

/**
 * Form primitives.
 *
 * Every control is wired to its <label> through a generated id — before this
 * the options page rendered bare `<label>` elements next to `<input>`s with no
 * association at all, so screen readers announced the fields unlabelled.
 * Focus styling comes from the global `:focus-visible` rule in globals.css.
 */

interface BaseProps {
  label: string;
  hint?: string;
  /** Stretch to the container instead of the field grid's natural column. */
  className?: string;
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  hint,
  autoComplete,
  className,
}: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label className="label" htmlFor={id}>
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        aria-describedby={hintId}
        autoComplete={autoComplete ?? 'off'}
        className="input"
      />
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A labelled on/off switch for a single setting.
 *
 * Built on a real `<input type="checkbox">` rather than a `role="switch"` div,
 * so it is keyboard- and screen-reader-correct for free; the checkbox itself is
 * visually hidden and the track/knob are drawn by the sibling `<span>`s.
 * `disabled` carries a `reason`, because a switch that silently refuses to move
 * is indistinguishable from a broken one.
 */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
  disabledReason,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const id = useId();
  const describedBy = description || disabledReason ? `${id}-desc` : undefined;

  return (
    <div className={disabled ? 'opacity-60' : undefined}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <label
          htmlFor={id}
          className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-theme
            peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2
            peer-focus-visible:outline-focus
            ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
            ${checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-input'}`}
        >
          <span
            aria-hidden="true"
            className={`absolute size-3.5 rounded-full transition-theme
              ${checked ? 'translate-x-4 bg-on-accent' : 'translate-x-0.5 bg-fg-subtle'}`}
          />
        </label>
        <label htmlFor={id} className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}>
          <span className="text-sm text-fg">{label}</span>
        </label>
      </div>
      {describedBy && (
        <p id={describedBy} className="hint mt-1.5 ml-12">
          {disabled && disabledReason ? disabledReason : description}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 5,
  placeholder,
  hint,
  mono,
  className,
}: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {/* §5.2 — a 70ch measure instead of a 1076px, ~180-character line. */}
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        aria-describedby={hintId}
        className={`input max-w-editor resize-y ${mono ? 'font-mono' : ''}`}
      />
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  hideLabel,
  className,
}: BaseProps & {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  /** Visually hide the label but keep it for assistive tech. */
  hideLabel?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      <label className={hideLabel ? 'sr-only' : 'label'} htmlFor={id}>
        {label}
      </label>
      {/* §5.10 — the native chevron does not follow the theme, so the control
          is `appearance-none` with our own icon layered on top. */}
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          aria-describedby={hintId}
          className="input select"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <IconChevronDown className="pointer-events-none absolute inset-y-0 right-3 my-auto size-4 text-fg-muted" />
      </div>
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}
