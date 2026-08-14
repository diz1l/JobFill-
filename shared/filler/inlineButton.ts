/**
 * The floating "Fill" button and the result toast.
 *
 * Everything lives inside a **closed shadow root** on a single `<jobfill-ui>`
 * host, so no stylesheet is injected into the page, page CSS cannot restyle our
 * UI, and page JS cannot reach into it. The host is mounted lazily on first use
 * and removed as soon as nothing is visible — a page you never focus a field on
 * never receives a single node from us.
 */

const HOST_TAG = 'jobfill-ui';

/** Scoped to the shadow root, so short class names are safe. */
const UI_CSS = `
.btn {
  position: fixed;
  z-index: 2147483646;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 3px 9px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font: 600 11px/1.6 system-ui, sans-serif;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(37,99,235,.45);
  user-select: none;
  white-space: nowrap;
  transition: background .12s, transform .08s;
}
.btn:hover { background: #1d4ed8; }
.btn:active { transform: scale(.95); }
.btn:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
.btn svg { width: 11px; height: 11px; display: block; fill: currentColor; }
.toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  padding: 9px 14px;
  max-width: 320px;
  background: #1e293b;
  color: #f1f5f9;
  border-radius: 8px;
  font: 500 12px/1.5 system-ui, sans-serif;
  /* Counters on one line, the "what to do about it" hint on the next. */
  white-space: pre-line;
  box-shadow: 0 4px 20px rgba(0,0,0,.35);
  pointer-events: none;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity .2s, transform .2s;
}
.toast.visible { opacity: 1; transform: translateY(0); }
`;

/** Lucide "zap" outline, drawn as a filled path so it needs no stroke rules. */
const BOLT_PATH =
  'M13.5 1.2 3.3 12.6c-.5.6-.1 1.4.7 1.4h4.1l-1.6 7.8c-.2.8.8 1.3 1.3.7L18 11.1c.5-.6.1-1.4-.7-1.4h-4.1l1.6-7.8c.2-.8-.8-1.3-1.3-.7z';

const TOAST_FADE_MS = 220;
/** `pointerdown` + `click` both fire for one press — collapse them. */
const PRESS_DEBOUNCE_MS = 700;

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let button: HTMLButtonElement | null = null;
let toast: HTMLDivElement | null = null;
let onFill: (() => void) | null = null;
let lastPressAt = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastRemoveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * True when an event target is (or is retargeted to) our own UI.
 * With a closed shadow root the page only ever sees the host element, so
 * `focusout.relatedTarget` pointing at the host means focus moved to our button.
 */
export function isInlineButtonTarget(target: EventTarget | null): boolean {
  if (!host || !(target instanceof Node)) return false;
  return target === host || host.contains(target);
}

function mount(): ShadowRoot | null {
  if (shadow && host?.isConnected) return shadow;

  // Attach to <html>, not <body>: <body> may not exist yet at document_idle on
  // streaming pages, gets replaced by document.write(), and is far more likely
  // than <html> to carry a `transform` (which would break `position: fixed`).
  const parent = document.documentElement ?? document.body;
  if (!parent) return null;

  host = document.createElement(HOST_TAG);
  host.setAttribute('data-jobfill', 'ui');
  // Zero-area, non-interactive anchor; children position themselves against the viewport.
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;';

  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = UI_CSS;
  shadow.appendChild(style);
  parent.appendChild(host);

  return shadow;
}

/** Remove the host once nothing of ours is on screen (NFR-4). */
function unmountIfIdle(): void {
  if (button || toast) return;
  host?.remove();
  host = null;
  shadow = null;
}

function handlePress(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  const now = Date.now();
  if (now - lastPressAt < PRESS_DEBOUNCE_MS) return;
  lastPressAt = now;
  onFill?.();
}

function createButton(root: ShadowRoot): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.setAttribute('aria-label', 'Fill this form with JobFill');
  btn.title = 'Fill this form with JobFill';

  // No innerHTML in a content script, even for a constant string.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 22 23');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', BOLT_PATH);
  svg.appendChild(path);

  const label = document.createElement('span');
  label.textContent = 'Fill';

  btn.append(svg, label);
  // Pointer events are more reliable than click on pages that aggressively manage focus.
  btn.addEventListener('pointerdown', handlePress);
  btn.addEventListener('click', handlePress);
  root.appendChild(btn);
  return btn;
}

export function showInlineButton(anchor: HTMLElement, onClick: () => void): void {
  const root = mount();
  if (!root) return;

  onFill = onClick;
  // Reused across focus changes — no clone-per-focusin churn.
  if (!button || !button.isConnected) button = createButton(root);
  placeButton(button, anchor);
}

function placeButton(btn: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const btnW = btn.offsetWidth || 56;
  const btnH = btn.offsetHeight || 24;

  let left = r.right + 6;
  if (left + btnW > window.innerWidth - 6) left = r.left - btnW - 6;
  if (left < 4) left = 4;

  const top = Math.max(4, Math.min(r.top + (r.height - btnH) / 2, window.innerHeight - btnH - 4));

  btn.style.left = `${Math.round(left)}px`;
  btn.style.top = `${Math.round(top)}px`;
}

export function repositionButton(anchor: HTMLElement): void {
  if (button?.isConnected) placeButton(button, anchor);
}

export function hideInlineButton(): void {
  button?.remove();
  button = null;
  onFill = null;
  unmountIfIdle();
}

export function showToast(message: string, durationMs = 3500): void {
  const root = mount();
  if (!root) return;

  if (!toast || !toast.isConnected) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    root.appendChild(toast);
  }
  toast.textContent = message;

  if (toastTimer) clearTimeout(toastTimer);
  if (toastRemoveTimer) clearTimeout(toastRemoveTimer);

  const el = toast;
  el.classList.remove('visible');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));

  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
    toastRemoveTimer = setTimeout(() => {
      el.remove();
      if (toast === el) toast = null;
      unmountIfIdle();
    }, TOAST_FADE_MS);
  }, durationMs);
}

/** Tear everything down — called when the content script context is invalidated. */
export function destroyInlineUi(): void {
  if (toastTimer) clearTimeout(toastTimer);
  if (toastRemoveTimer) clearTimeout(toastRemoveTimer);
  toastTimer = null;
  toastRemoveTimer = null;
  button?.remove();
  toast?.remove();
  button = null;
  toast = null;
  onFill = null;
  host?.remove();
  host = null;
  shadow = null;
}
