import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  isSensitiveControl,
  isFillableControl,
  isVisibleControl,
  isInsideAuthForm,
  looksLikeAuthPage,
  isInlineButtonAnchor,
  hasFillableControls,
  countFillableControls,
} from '../shared/filler/fillable';

/**
 * happy-dom has no layout engine: `getBoundingClientRect()` always returns an
 * all-zero rect, so `isVisibleControl` — and therefore `isInlineButtonAnchor` —
 * would call *every* control invisible. Tests that care about geometry stub the
 * rect explicitly; the rest get a default "normal sized control" rect. Stubbed
 * on `Element.prototype`, the same API production calls, so nothing is bypassed.
 */
const VISIBLE_RECT = { x: 50, y: 100, width: 180, height: 32, top: 100, left: 50, right: 230, bottom: 132 };

function stubRect(rect: Partial<typeof VISIBLE_RECT> = {}): void {
  const full = { ...VISIBLE_RECT, ...rect };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...full, toJSON: () => full }) as DOMRect,
  );
}

function mount<T extends Element = HTMLInputElement>(html: string, selector = 'input,textarea,select'): T {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error('fragment contains no matching element');
  return el;
}

beforeEach(() => {
  stubRect();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('isSensitiveControl — a password box must never be touched (P0-4)', () => {
  it('rejects type="password" written as an attribute', () => {
    expect(isSensitiveControl(mount('<input type="password" name="pw" />'))).toBe(true);
  });

  it('rejects type set as a property after creation', () => {
    const el = document.createElement('input');
    el.type = 'password';
    expect(isSensitiveControl(el)).toBe(true);
  });

  it('rejects an upper-case type attribute', () => {
    expect(isSensitiveControl(mount('<input type="PASSWORD" name="pw" />'))).toBe(true);
  });

  it('rejects a mixed-case type attribute', () => {
    expect(isSensitiveControl(mount('<input type="PassWord" name="pw" />'))).toBe(true);
  });

  const autocompleteTokens = [
    'current-password',
    'new-password',
    'one-time-code',
    'webauthn',
    'cc-number',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
    'cc-csc',
    'cc-type',
    'cc-name',
  ];
  for (const token of autocompleteTokens) {
    it(`rejects autocomplete="${token}"`, () => {
      expect(isSensitiveControl(mount(`<input type="text" autocomplete="${token}" />`))).toBe(true);
    });
  }

  it('rejects a multi-token autocomplete such as "section-login current-password"', () => {
    expect(
      isSensitiveControl(mount('<input type="text" autocomplete="section-login current-password" />')),
    ).toBe(true);
  });

  it('rejects an upper-case autocomplete token', () => {
    expect(isSensitiveControl(mount('<input type="text" autocomplete="CURRENT-PASSWORD" />'))).toBe(true);
  });

  it('accepts autocomplete="email" — not every token is a secret', () => {
    expect(isSensitiveControl(mount('<input type="text" autocomplete="email" />'))).toBe(false);
  });

  it('accepts autocomplete="cc-given-name"-like tokens that are not in the secret list', () => {
    expect(isSensitiveControl(mount('<input type="text" autocomplete="given-name" />'))).toBe(false);
  });

  // "Show password" flips the input to type=text — the only remaining evidence
  // is the name / id / aria-label / placeholder.
  const revealedByName: [string, string][] = [
    ['name', '<input type="text" name="password" />'],
    ['name (Czech-ish spelling)', '<input type="text" name="passwrd" />'],
    ['name (passphrase)', '<input type="text" name="user_passphrase" />'],
    ['id', '<input type="text" id="login-password" />'],
    ['aria-label', '<input type="text" aria-label="Password" />'],
    ['placeholder', '<input type="text" placeholder="Enter your password" />'],
    ['OTP name', '<input type="text" name="otp" />'],
    ['one-time name', '<input type="text" name="one_time_token" />'],
    ['verification code', '<input type="text" name="verification_code" />'],
    ['security code', '<input type="text" name="security-code" />'],
    ['CVV', '<input type="text" name="cvv" />'],
    ['CVC', '<input type="number" name="cvc" />'],
    ['card number', '<input type="text" name="card_number" />'],
  ];
  for (const [what, html] of revealedByName) {
    it(`rejects a revealed credential detected via ${what}`, () => {
      expect(isSensitiveControl(mount(html))).toBe(true);
    });
  }

  it('rejects a "show password" toggle regardless of the visible type', () => {
    const el = mount<HTMLInputElement>('<input type="password" name="pw" aria-label="Password" />');
    expect(isSensitiveControl(el)).toBe(true);
    el.type = 'text';
    expect(isSensitiveControl(el)).toBe(true);
  });

  it('accepts an ordinary application field', () => {
    expect(isSensitiveControl(mount('<input type="text" name="first_name" aria-label="First name" />'))).toBe(
      false,
    );
  });

  it('does not treat "Passport number" as a credential', () => {
    expect(isSensitiveControl(mount('<input type="text" name="passport_number" />'))).toBe(false);
  });

  it('does not treat a bare textarea as a credential', () => {
    expect(isSensitiveControl(mount('<textarea name="cover_letter"></textarea>', 'textarea'))).toBe(false);
  });

  it('works on a <select> (no placeholder property)', () => {
    expect(isSensitiveControl(mount('<select name="country"></select>', 'select'))).toBe(false);
  });
});

describe('isFillableControl', () => {
  const allowed = ['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'week', 'time', 'datetime-local'];
  for (const type of allowed) {
    it(`accepts input[type="${type}"]`, () => {
      expect(isFillableControl(mount(`<input type="${type}" name="f" />`))).toBe(true);
    });
  }

  it('accepts an input with no type attribute at all', () => {
    expect(isFillableControl(mount('<input name="f" />'))).toBe(true);
  });

  const refused = [
    'password',
    'search',
    'file',
    'checkbox',
    'radio',
    'hidden',
    'submit',
    'button',
    'reset',
    'image',
    'range',
    'color',
  ];
  for (const type of refused) {
    it(`refuses input[type="${type}"] — allowlist, not denylist`, () => {
      expect(isFillableControl(mount(`<input type="${type}" name="f" />`))).toBe(false);
    });
  }

  it('accepts a textarea', () => {
    expect(isFillableControl(mount('<textarea name="f"></textarea>', 'textarea'))).toBe(true);
  });

  it('accepts a select', () => {
    expect(isFillableControl(mount('<select name="f"></select>', 'select'))).toBe(true);
  });

  it('refuses a non-control element', () => {
    expect(isFillableControl(mount('<div contenteditable="true"></div>', 'div'))).toBe(false);
  });

  it('refuses null', () => {
    expect(isFillableControl(null)).toBe(false);
  });

  it('refuses a disabled input', () => {
    expect(isFillableControl(mount('<input name="f" disabled />'))).toBe(false);
  });

  it('refuses a disabled select', () => {
    expect(isFillableControl(mount('<select name="f" disabled></select>', 'select'))).toBe(false);
  });

  it('refuses a readonly input', () => {
    expect(isFillableControl(mount('<input name="f" readonly />'))).toBe(false);
  });

  it('refuses a readonly textarea', () => {
    expect(isFillableControl(mount('<textarea name="f" readonly></textarea>', 'textarea'))).toBe(false);
  });

  it('refuses a sensitive control even when its type is allowed', () => {
    expect(isFillableControl(mount('<input type="text" name="cvv" />'))).toBe(false);
  });
});

describe('isVisibleControl', () => {
  it('accepts a normally sized control', () => {
    expect(isVisibleControl(mount('<input name="f" />'))).toBe(true);
  });

  it('refuses an element with the hidden attribute', () => {
    expect(isVisibleControl(mount('<input name="f" hidden />'))).toBe(false);
  });

  it('refuses an element inside aria-hidden', () => {
    expect(isVisibleControl(mount('<div aria-hidden="true"><input name="f" /></div>'))).toBe(false);
  });

  it('refuses an element inside an inert subtree', () => {
    expect(isVisibleControl(mount('<div inert><input name="f" /></div>'))).toBe(false);
  });

  it('refuses a zero-area control', () => {
    stubRect({ width: 0, height: 0 });
    expect(isVisibleControl(mount('<input name="f" />'))).toBe(false);
  });

  it('refuses a sliver-thin control (offscreen trick)', () => {
    stubRect({ width: 180, height: 1 });
    expect(isVisibleControl(mount('<input name="f" />'))).toBe(false);
  });

  it('refuses a control narrower than the minimum', () => {
    stubRect({ width: 5, height: 32 });
    expect(isVisibleControl(mount('<input name="f" />'))).toBe(false);
  });

  it('accepts a control exactly at the minimum size', () => {
    stubRect({ width: 6, height: 6 });
    expect(isVisibleControl(mount('<input name="f" />'))).toBe(true);
  });
});

function textInputs(n: number): string {
  return Array.from({ length: n }, (_, i) => `<input type="text" name="f${i}" />`).join('');
}

describe('isInsideAuthForm — the ≤5 control threshold', () => {
  it('treats a classic email + password login form as auth', () => {
    const el = mount('<form><input type="email" name="email" /><input type="password" name="pw" /></form>');
    expect(isInsideAuthForm(el)).toBe(true);
  });

  it('treats a login form with a "remember me" checkbox as auth', () => {
    const el = mount(
      '<form><input type="email" name="email" /><input type="password" name="pw" />' +
        '<input type="checkbox" name="remember" /></form>',
    );
    expect(isInsideAuthForm(el)).toBe(true);
  });

  it('treats a signup form with password + confirmation as auth', () => {
    const el = mount(
      '<form><input type="email" name="email" /><input type="password" name="pw" />' +
        '<input type="password" name="pw2" /></form>',
    );
    expect(isInsideAuthForm(el)).toBe(true);
  });

  it('detects the password by autocomplete when the type is flipped to text', () => {
    const el = mount(
      '<form><input type="email" name="email" />' +
        '<input type="text" autocomplete="current-password" name="pw" /></form>',
    );
    expect(isInsideAuthForm(el)).toBe(true);
  });

  it('does not count hidden CSRF tokens or buttons towards the threshold', () => {
    // 5 user-facing controls + noise that must be ignored → still auth
    const el = mount(
      '<form><input type="hidden" name="csrf" /><input type="submit" value="Sign in" />' +
        '<input type="button" value="x" /><input type="reset" value="y" />' +
        '<input type="image" src="a.png" />' +
        '<input type="password" name="pw" />' +
        textInputs(4) +
        '</form>',
    );
    expect(isInsideAuthForm(el)).toBe(true);
  });

  it('exactly 5 user-facing controls with a password is still a login form', () => {
    const el = mount(`<form><input type="password" name="pw" />${textInputs(4)}</form>`);
    expect(el.closest('form')!.querySelectorAll('input,textarea,select')).toHaveLength(5);
    expect(isInsideAuthForm(el)).toBe(true);
  });

  it('6 user-facing controls with a password is an application form, not a login form', () => {
    const el = mount(`<form><input type="password" name="pw" />${textInputs(5)}</form>`);
    expect(el.closest('form')!.querySelectorAll('input,textarea,select')).toHaveLength(6);
    expect(isInsideAuthForm(el)).toBe(false);
  });

  it('an ATS "create an account while you apply" form is not a login form', () => {
    // Password + CV upload + consent checkboxes is the signature of a real
    // application: the surrounding name / email fields stay ours.
    const el = mount(
      '<form>' +
        '<input type="text" name="first_name" />' +
        '<input type="text" name="last_name" />' +
        '<input type="email" name="email" />' +
        '<input type="password" name="account_password" />' +
        '<input type="file" name="resume" />' +
        '<input type="checkbox" name="gdpr_consent" />' +
        '<textarea name="cover_letter"></textarea>' +
        '</form>',
    );
    expect(isInsideAuthForm(el)).toBe(false);
  });

  it('a file input counts towards the threshold — it is evidence of an application', () => {
    const el = mount(
      `<form><input type="password" name="pw" />${textInputs(4)}<input type="file" name="cv" /></form>`,
    );
    expect(isInsideAuthForm(el)).toBe(false);
  });

  it('a big form without any password is never an auth form', () => {
    const el = mount(`<form>${textInputs(3)}</form>`);
    expect(isInsideAuthForm(el)).toBe(false);
  });

  it('a tiny form without a password is not an auth form either', () => {
    const el = mount('<form><input type="email" name="newsletter" /></form>');
    expect(isInsideAuthForm(el)).toBe(false);
  });

  it('a control with no <form> ancestor is not inside an auth form', () => {
    const el = mount('<div><input type="text" name="f" /></div>');
    expect(isInsideAuthForm(el)).toBe(false);
  });

  it('only the control\'s own form counts, not a sibling login form', () => {
    mount(
      '<div>' +
        '<form id="login"><input type="email" name="e" /><input type="password" name="pw" /></form>' +
        '<form id="apply"><input id="target" type="text" name="first_name" /></form>' +
        '</div>',
    );
    const target = document.getElementById('target') as HTMLInputElement;
    expect(isInsideAuthForm(target)).toBe(false);
  });
});

describe('looksLikeAuthPage — SPA login screens without a <form>', () => {
  it('is true for a bare login screen', () => {
    document.body.innerHTML =
      '<div><input type="email" name="email" /><input type="password" name="pw" /></div>';
    expect(looksLikeAuthPage(document)).toBe(true);
  });

  it('is false for a page with no password anywhere', () => {
    document.body.innerHTML = `<div>${textInputs(2)}</div>`;
    expect(looksLikeAuthPage(document)).toBe(false);
  });

  it('is false for an application page that happens to contain a password field', () => {
    document.body.innerHTML = `<div><input type="password" name="pw" />${textInputs(8)}</div>`;
    expect(looksLikeAuthPage(document)).toBe(false);
  });

  it('defaults to the live document', () => {
    document.body.innerHTML = '<input type="password" name="pw" /><input type="email" name="e" />';
    expect(looksLikeAuthPage()).toBe(true);
  });
});

describe('isInlineButtonAnchor — P0-4 end to end', () => {
  it('accepts a plain visible application field', () => {
    expect(isInlineButtonAnchor(mount('<form><input type="text" name="first_name" />' + textInputs(6) + '</form>'))).toBe(
      true,
    );
  });

  it('accepts a standalone field with no form at all', () => {
    expect(isInlineButtonAnchor(mount('<input type="text" name="first_name" />'))).toBe(true);
  });

  it('refuses null', () => {
    expect(isInlineButtonAnchor(null)).toBe(false);
  });

  it('refuses a non-element event target', () => {
    expect(isInlineButtonAnchor(new EventTarget())).toBe(false);
  });

  it('refuses a detached element', () => {
    const el = document.createElement('input');
    expect(el.isConnected).toBe(false);
    expect(isInlineButtonAnchor(el)).toBe(false);
  });

  it('refuses a non-fillable element type', () => {
    expect(isInlineButtonAnchor(mount('<div contenteditable="true"></div>', 'div'))).toBe(false);
  });

  it('refuses an invisible field', () => {
    stubRect({ width: 0, height: 0 });
    expect(isInlineButtonAnchor(mount('<input type="text" name="first_name" />'))).toBe(false);
  });

  it('never appears next to input[type=password]', () => {
    expect(isInlineButtonAnchor(mount('<input type="password" name="pw" />'))).toBe(false);
  });

  it('never appears next to a password field declared in upper case', () => {
    expect(isInlineButtonAnchor(mount('<input type="PASSWORD" name="pw" />'))).toBe(false);
  });

  it('never appears next to a password field typed via the property', () => {
    const el = mount<HTMLInputElement>('<input name="pw" />');
    el.type = 'password';
    expect(isInlineButtonAnchor(el)).toBe(false);
  });

  it('never appears next to autocomplete="current-password"', () => {
    expect(isInlineButtonAnchor(mount('<input type="text" autocomplete="current-password" />'))).toBe(false);
  });

  it('never appears next to a revealed "show password" field', () => {
    expect(isInlineButtonAnchor(mount('<input type="text" name="password" aria-label="Password" />'))).toBe(
      false,
    );
  });

  it('never appears next to a one-time code box', () => {
    expect(isInlineButtonAnchor(mount('<input type="text" name="otp" inputmode="numeric" />'))).toBe(false);
  });

  it('never appears on the email field of a login form', () => {
    const el = mount('<form><input type="email" name="email" /><input type="password" name="pw" /></form>');
    expect(isInlineButtonAnchor(el)).toBe(false);
  });

  it('does appear on the email field of a real application form', () => {
    const el = mount(
      '<form><input type="email" name="email" /><input type="password" name="pw" />' +
        textInputs(6) +
        '</form>',
    );
    expect(isInlineButtonAnchor(el)).toBe(true);
  });
});

describe('hasFillableControls / countFillableControls', () => {
  it('reports nothing on an empty page', () => {
    expect(hasFillableControls(document)).toBe(false);
    expect(countFillableControls(document)).toBe(0);
  });

  it('reports nothing on a page made only of refused controls', () => {
    document.body.innerHTML =
      '<input type="password" name="pw" /><input type="file" name="cv" />' +
      '<input type="checkbox" name="c" /><input type="hidden" name="h" />' +
      '<input type="text" name="cvv" /><input type="text" name="q" disabled />';
    expect(hasFillableControls(document)).toBe(false);
    expect(countFillableControls(document)).toBe(0);
  });

  it('finds the one fillable control among many refused ones', () => {
    document.body.innerHTML =
      '<input type="password" name="pw" /><input type="file" name="cv" />' +
      '<input type="text" name="first_name" />';
    expect(hasFillableControls(document)).toBe(true);
    expect(countFillableControls(document)).toBe(1);
  });

  it('counts inputs, textareas and selects', () => {
    document.body.innerHTML =
      '<input type="text" name="a" /><textarea name="b"></textarea><select name="c"></select>' +
      '<input type="password" name="pw" />';
    expect(countFillableControls(document)).toBe(3);
  });

  it('scopes to the given root', () => {
    document.body.innerHTML =
      '<form id="a"><input type="text" name="x" /></form>' +
      '<form id="b"><input type="text" name="y" /><input type="text" name="z" /></form>';
    expect(countFillableControls(document.getElementById('b')!)).toBe(2);
    expect(hasFillableControls(document.getElementById('a')!)).toBe(true);
  });

  it('defaults to the whole document', () => {
    document.body.innerHTML = '<input type="text" name="a" />';
    expect(hasFillableControls()).toBe(true);
    expect(countFillableControls()).toBe(1);
  });
});
