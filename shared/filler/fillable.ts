/**
 * Which page controls JobFill is allowed to touch — and which it must never
 * touch. Two rules drive everything here:
 *
 *  1. Never write into, and never surface UI next to, a credential or payment
 *     field. A blue extension button floating next to a password box is an
 *     instant trust killer and a red flag in store review.
 *  2. Never surface UI on pages that plainly are not job applications (sign-in
 *     screens), so the on-page footprint stays at zero there.
 *
 * DOM-only and side-effect free, so the content script's inline button and
 * `fillPage()` can share them.
 */

export type FillableControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Input types we are willing to type into. Allowlist, not denylist: anything the
 * platform adds later, or anything exotic a site invents, is excluded by default
 * instead of silently becoming a fill target.
 *
 * Notable exclusions: `password`; `search` (site search boxes are not
 * application fields); `file` (highlighted, never filled); `checkbox` / `radio`
 * (consent controls are never touched).
 */
const ALLOWED_INPUT_TYPES = new Set([
  '',
  'text',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
]);

/** `autocomplete` tokens that mark a control as a credential or payment secret. */
const SENSITIVE_AUTOCOMPLETE =
  /(?:^|[\s-])(?:current-password|new-password|one-time-code|webauthn|cc-(?:number|exp|exp-month|exp-year|csc|type|name))(?:[\s-]|$)/i;

/**
 * Credential fields that are *not* `type="password"`: "show password" toggles
 * flip the input to `type="text"`, and OTP / CVC boxes are usually
 * `type="text"` or `type="number"` to keep the numeric keypad.
 */
const SENSITIVE_NAME =
  /pass(?:wo?rd|phrase)|\botp\b|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code|\bcvv\b|\bcvc\b|card[-_ ]?number/i;

/** Any form control, before any of our own rules are applied. */
const CONTROL_SELECTOR = 'input,textarea,select';

/**
 * Everything the user can actually see and interact with — including file
 * inputs and checkboxes, which we never fill but which are a strong signal that
 * a form is a real application rather than a sign-in box. Hidden inputs (CSRF
 * tokens) and buttons are excluded so they cannot inflate the count.
 */
const USER_FACING_CONTROL_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),textarea,select';

/** A form with a password box and no more than this many controls is a login / signup form. */
const AUTH_SCOPE_MAX_CONTROLS = 5;

/** Controls smaller than this in either axis are decorative or hidden. */
const MIN_CONTROL_SIZE_PX = 6;

/** Credential / payment control — never filled, never decorated with our UI. */
export function isSensitiveControl(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') return true;

  const autocomplete = el.getAttribute('autocomplete') ?? '';
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;

  const hints = [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('aria-label'),
    (el as HTMLInputElement).placeholder,
  ]
    .filter(Boolean)
    .join(' ');

  return SENSITIVE_NAME.test(hints);
}

/**
 * Is this element something we may type into at all?  Type / state checks only —
 * no layout is read, so this is cheap enough to run over every control on a page.
 */
export function isFillableControl(el: Element | null): el is FillableControl {
  if (
    !(
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    )
  ) {
    return false;
  }
  if (el.disabled) return false;
  if ('readOnly' in el && el.readOnly) return false;
  if (el instanceof HTMLInputElement && !ALLOWED_INPUT_TYPES.has(el.type.toLowerCase())) return false;
  return !isSensitiveControl(el);
}

/** Reads layout — only call this for a single element (e.g. the focused one). */
export function isVisibleControl(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.closest('[aria-hidden="true"],[inert]')) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= MIN_CONTROL_SIZE_PX && rect.height >= MIN_CONTROL_SIZE_PX;
}

function looksLikeAuthScope(scope: ParentNode): boolean {
  const hasPassword = scope.querySelector('input[type="password"],input[autocomplete*="password"]');
  if (!hasPassword) return false;

  // A password box in a small form is a login / signup screen: hands off.
  // A password box in a large form is the "create an account while you apply"
  // step of an ATS — the surrounding name / email / CV fields are still ours
  // (the password itself is refused separately by `isSensitiveControl`).
  return scope.querySelectorAll(USER_FACING_CONTROL_SELECTOR).length <= AUTH_SCOPE_MAX_CONTROLS;
}

/** True when the control belongs to a `<form>` that looks like a login / signup form. */
export function isInsideAuthForm(el: Element): boolean {
  const form = el.closest('form');
  return form ? looksLikeAuthScope(form) : false;
}

/**
 * True when the whole document looks like a sign-in screen.  Covers the common
 * SPA case where the login fields are not wrapped in a `<form>` at all.
 */
export function looksLikeAuthPage(doc: Document = document): boolean {
  return looksLikeAuthScope(doc);
}

/**
 * Full check used by the inline button: type, state, sensitivity, visibility and
 * surrounding form all have to pass.
 */
export function isInlineButtonAnchor(el: EventTarget | null): el is FillableControl {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (!isFillableControl(el)) return false;
  if (!isVisibleControl(el)) return false;
  return !isInsideAuthForm(el);
}

/** Cheap "is there anything here worth filling" probe — exits on the first hit. */
export function hasFillableControls(root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll(CONTROL_SELECTOR)) {
    if (isFillableControl(el)) return true;
  }
  return false;
}

/** Number of controls `fillPage()` would consider. Used for diagnostics and tests. */
export function countFillableControls(root: ParentNode = document): number {
  let count = 0;
  for (const el of root.querySelectorAll(CONTROL_SELECTOR)) {
    if (isFillableControl(el)) count++;
  }
  return count;
}
