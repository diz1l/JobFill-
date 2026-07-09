import type { FieldConfidence } from '../types';

const STYLE_ID = '__jobfill-styles';
const DISMISS_ATTR = 'data-jobfill-dismiss';

const HIGHLIGHT_CSS = `
.__jobfill-high {
  outline: 2px solid #22c55e !important;
  outline-offset: 1px !important;
  background-color: rgba(34,197,94,0.08) !important;
}
.__jobfill-medium {
  outline: 2px solid #eab308 !important;
  outline-offset: 1px !important;
  background-color: rgba(234,179,8,0.08) !important;
}
.__jobfill-low, .__jobfill-none {
  outline: 2px dashed #9ca3af !important;
  outline-offset: 1px !important;
}
.__jobfill-file {
  outline: 2px dashed #3b82f6 !important;
  outline-offset: 1px !important;
}
.__jobfill-badge {
  position: absolute;
  z-index: 2147483647;
  font-size: 10px;
  font-family: system-ui, sans-serif;
  padding: 2px 5px;
  border-radius: 3px;
  pointer-events: none;
  white-space: nowrap;
  background: #1e293b;
  color: #f1f5f9;
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(style);
}

export function highlightField(
  el: HTMLElement,
  confidence: FieldConfidence | 'file',
  durationMs: number,
): void {
  ensureStyles();
  const cls = `__jobfill-${confidence}`;
  el.classList.add(cls);
  el.setAttribute(DISMISS_ATTR, '1');

  const dismiss = () => removeHighlight(el, cls);
  el.addEventListener('click', dismiss, { once: true });
  setTimeout(dismiss, durationMs);
}

function removeHighlight(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  el.removeAttribute(DISMISS_ATTR);
}

export function removeAllHighlights(): void {
  document.querySelectorAll<HTMLElement>(`[${DISMISS_ATTR}]`).forEach((el) => {
    ['high', 'medium', 'low', 'none', 'file'].forEach((c) =>
      el.classList.remove(`__jobfill-${c}`),
    );
    el.removeAttribute(DISMISS_ATTR);
  });
}

export function removeStyles(): void {
  document.getElementById(STYLE_ID)?.remove();
}
