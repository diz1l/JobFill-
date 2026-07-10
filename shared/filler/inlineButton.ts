const BTN_ID = '__jobfill-inline-btn';
const TOAST_ID = '__jobfill-toast';
const STYLE_ID = '__jobfill-inline-styles';

export function isInlineButtonTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.id === BTN_ID || Boolean(target.closest(`#${BTN_ID}`));
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BTN_ID} {
      position: fixed;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 3px 9px;
      background: #2563eb;
      color: #fff;
      border-radius: 6px;
      font: 600 11px/1.6 system-ui,sans-serif;
      cursor: pointer;
      border: none;
      outline: none;
      box-shadow: 0 2px 10px rgba(37,99,235,.45);
      user-select: none;
      white-space: nowrap;
      pointer-events: all;
      transition: background .12s, transform .08s;
    }
    #${BTN_ID}:hover { background: #1d4ed8; }
    #${BTN_ID}:active { transform: scale(.95); }
    #${TOAST_ID} {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      padding: 9px 14px;
      background: #1e293b;
      color: #f1f5f9;
      border-radius: 8px;
      font: 500 12px/1.5 system-ui,sans-serif;
      box-shadow: 0 4px 20px rgba(0,0,0,.35);
      pointer-events: none;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .2s, transform .2s;
      max-width: 320px;
    }
    #${TOAST_ID}.visible {
      opacity: 1;
      transform: translateY(0);
    }
  `;
  document.head.appendChild(style);
}

export function showInlineButton(anchor: HTMLElement, onClick: () => void): void {
  ensureStyles();

  // Reuse or create the button
  let btn = document.getElementById(BTN_ID) as HTMLButtonElement | null;
  if (!btn) {
    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Fill with JobFill');
    btn.innerHTML = '⚡ Fill';
    document.body.appendChild(btn);
  }

  // Replace to reset listeners
  const fresh = btn.cloneNode(true) as HTMLButtonElement;
  btn.replaceWith(fresh);

  let invoked = false;
  const handlePress = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (invoked) return;
    invoked = true;
    onClick();
  };

  // Pointer events are more reliable than click on pages that aggressively manage focus.
  fresh.addEventListener('pointerdown', handlePress);
  fresh.addEventListener('click', handlePress);

  placeButton(fresh, anchor);
}

function placeButton(btn: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const btnW = 60;
  const btnH = 24;

  let left = r.right + 6;
  let top = r.top + (r.height - btnH) / 2;

  if (left + btnW > window.innerWidth - 6) left = r.left - btnW - 6;
  if (left < 4) left = 4;
  top = Math.max(4, Math.min(top, window.innerHeight - btnH - 4));

  btn.style.left = `${Math.round(left)}px`;
  btn.style.top = `${Math.round(top)}px`;
}

export function repositionButton(anchor: HTMLElement): void {
  const btn = document.getElementById(BTN_ID);
  if (btn) placeButton(btn, anchor);
}

export function hideInlineButton(): void {
  document.getElementById(BTN_ID)?.remove();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string, durationMs = 3500): void {
  ensureStyles();

  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    document.body.appendChild(toast);
  }

  toast.textContent = message;

  if (toastTimer) clearTimeout(toastTimer);
  // Force reflow before adding class so transition plays
  toast.classList.remove('visible');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      (toast as HTMLElement).classList.add('visible');
    });
  });

  toastTimer = setTimeout(() => {
    (toast as HTMLElement).classList.remove('visible');
  }, durationMs);
}
