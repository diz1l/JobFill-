import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveCoverTarget,
  rememberFocusedField,
  rememberRecognizedCoverField,
  forgetCoverTargets,
} from '../shared/filler/coverTarget';

function render(html: string): void {
  document.body.innerHTML = html;
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

beforeEach(() => {
  forgetCoverTargets();
});

afterEach(() => {
  forgetCoverTargets();
  document.body.innerHTML = '';
});

describe('resolveCoverTarget — never guesses (P1-12)', () => {
  it('returns null on a page with no textareas at all', () => {
    render('<main><input id="q" name="first_name" /></main>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('returns null rather than falling back to the first textarea on the page', () => {
    // The old implementation dropped the motivation letter into whichever
    // textarea came first — a support chat box, in this case.
    render('<div id="widget"><textarea id="chat" name="chat_message"></textarea></div>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('returns null when the only textarea is a site search box', () => {
    render('<form role="search"><textarea id="q" name="search_query"></textarea></form>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('returns null when the only textarea belongs to a login form', () => {
    render(
      '<form><input type="password" name="pw" />' +
        '<textarea id="cl" name="cover_letter"></textarea></form>',
    );
    expect(resolveCoverTarget()).toBeNull();
  });

  it('returns null when the only textarea is read-only', () => {
    render('<textarea id="cl" name="cover_letter" readonly></textarea>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('returns null when the only textarea is disabled', () => {
    render('<textarea id="cl" name="cover_letter" disabled></textarea>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('returns null on a completely empty document', () => {
    render('');
    expect(resolveCoverTarget()).toBeNull();
  });
});

describe('rememberFocusedField', () => {
  it('is the strongest signal — it wins over everything else', () => {
    render(
      '<textarea id="focused" name="notes_field"></textarea>' +
        '<textarea id="cl" name="cover_letter"></textarea>',
    );
    rememberRecognizedCoverField(byId('cl'));
    rememberFocusedField(byId('focused'));
    expect(resolveCoverTarget()).toBe(byId('focused'));
  });

  it('ignores a focused <input> — a cover letter never goes into one line', () => {
    render('<input id="one-liner" name="cover_letter" /><textarea id="cl" name="cover_letter"></textarea>');
    rememberFocusedField(byId('one-liner'));
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('ignores a focused non-control element', () => {
    render('<div id="d"></div><textarea id="cl" name="cover_letter"></textarea>');
    rememberFocusedField(byId('d'));
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('falls through when the remembered field left the DOM (SPA re-render)', () => {
    render('<textarea id="gone" name="notes"></textarea><textarea id="cl" name="cover_letter"></textarea>');
    rememberFocusedField(byId('gone'));
    byId('gone').remove();
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('falls through when the remembered field became read-only', () => {
    render('<textarea id="ro" name="notes"></textarea><textarea id="cl" name="cover_letter"></textarea>');
    const ro = byId<HTMLTextAreaElement>('ro');
    rememberFocusedField(ro);
    ro.readOnly = true;
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('falls through when the remembered field became disabled', () => {
    render('<textarea id="dis" name="notes"></textarea><textarea id="cl" name="cover_letter"></textarea>');
    const dis = byId<HTMLTextAreaElement>('dis');
    rememberFocusedField(dis);
    dis.disabled = true;
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('accepts a textarea the matcher would never have found', () => {
    render('<textarea id="opaque" name="x7f3a91"></textarea>');
    rememberFocusedField(byId('opaque'));
    expect(resolveCoverTarget()).toBe(byId('opaque'));
  });
});

describe('rememberRecognizedCoverField', () => {
  it('wins over the highlight scan and the matcher', () => {
    render(
      '<textarea id="remembered" name="x1"></textarea>' +
        '<textarea id="highlighted" class="__jobfill-ai" name="x2"></textarea>',
    );
    rememberRecognizedCoverField(byId('remembered'));
    expect(resolveCoverTarget()).toBe(byId('remembered'));
  });

  it('accepts an <input>, unlike the focus hint', () => {
    render('<input id="cl" name="cover_letter" />');
    rememberRecognizedCoverField(byId('cl'));
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('ignores anything that is not a text control', () => {
    render('<select id="s"></select><textarea id="cl" name="cover_letter"></textarea>');
    rememberRecognizedCoverField(byId('s'));
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('falls through when the remembered field left the DOM', () => {
    render('<textarea id="gone" name="x"></textarea><textarea id="cl" name="cover_letter"></textarea>');
    rememberRecognizedCoverField(byId('gone'));
    byId('gone').remove();
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });
});

describe('highlighted-textarea fallback', () => {
  const classes = ['__jobfill-ai', '__jobfill-high', '__jobfill-medium', '__jobfill-empty'];
  for (const cls of classes) {
    it(`picks up a textarea still marked ${cls}`, () => {
      render(`<textarea id="hit" class="${cls}" name="x9f2"></textarea>`);
      expect(resolveCoverTarget()).toBe(byId('hit'));
    });
  }

  /**
   * First run, name the matcher cannot read: `fillPage()` recognised the letter
   * field, had no template for it, and left it outlined `empty`. That outline is
   * the only evidence of the match once the WeakRef hints are gone — and this is
   * exactly where the popup's "Generate motivation → Insert" must land.
   */
  it('picks up an opaque letter textarea left empty by a template-less fill', () => {
    render('<textarea id="dopis" class="__jobfill-empty" data-automation-id="a91f"></textarea>');
    expect(resolveCoverTarget()).toBe(byId('dopis'));
  });

  it('still ignores a textarea marked empty inside a login form', () => {
    render(
      '<form><input type="password" name="pw" />' +
        '<textarea id="hit" class="__jobfill-empty" name="x9f2"></textarea></form>',
    );
    expect(resolveCoverTarget()).toBeNull();
  });

  it('ignores a textarea marked as unrecognised', () => {
    render('<textarea id="miss" class="__jobfill-none" name="x9f2"></textarea>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('ignores a highlighted textarea inside a login form', () => {
    render(
      '<form><input type="password" name="pw" />' +
        '<textarea id="hit" class="__jobfill-ai" name="x9f2"></textarea></form>',
    );
    expect(resolveCoverTarget()).toBeNull();
  });

  it('ignores a highlighted textarea that became read-only', () => {
    render('<textarea id="hit" class="__jobfill-ai" name="x9f2" readonly></textarea>');
    expect(resolveCoverTarget()).toBeNull();
  });

  /**
   * The selector reads `ai,high,medium` as if that were a priority order, but
   * `querySelectorAll` always yields document order regardless of selector
   * order. Pinned so a change to it has to be a deliberate one.
   */
  it('takes the first highlighted textarea in document order, not in selector order', () => {
    render(
      '<textarea id="medium" class="__jobfill-medium" name="x1"></textarea>' +
        '<textarea id="ai" class="__jobfill-ai" name="x2"></textarea>',
    );
    expect(resolveCoverTarget()).toBe(byId('medium'));
  });

  it('picks the AI-marked textarea when it comes first', () => {
    render(
      '<textarea id="ai" class="__jobfill-ai" name="x2"></textarea>' +
        '<textarea id="medium" class="__jobfill-medium" name="x1"></textarea>',
    );
    expect(resolveCoverTarget()).toBe(byId('ai'));
  });
});

describe('matcher fallback (popup used before "Fill Form")', () => {
  it('finds the cover-letter textarea by its name', () => {
    render('<textarea id="cl" name="cover_letter"></textarea>');
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('finds a Czech cover-letter textarea', () => {
    render('<label for="cl">Motivační dopis</label><textarea id="cl" name="motivacni_dopis"></textarea>');
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('accepts an open-ended question as a target', () => {
    render('<label for="q1">Why do you want to work here?</label><textarea id="q1" name="q_1"></textarea>');
    expect(resolveCoverTarget()).toBe(byId('q1'));
  });

  it('never targets a textarea whose id is the canonical search parameter "q"', () => {
    render('<label for="q">Why do you want to work here?</label><textarea id="q" name="q_1"></textarea>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('skips a textarea the matcher is only lukewarm about', () => {
    render('<textarea id="meh" name="notes"></textarea>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('skips a textarea the matcher confidently classified as something else', () => {
    // "About you" is a real, high-confidence match — but it is not where a
    // cover letter belongs.
    render('<label for="ab">About you</label><textarea id="ab" name="about"></textarea>');
    expect(resolveCoverTarget()).toBeNull();
  });

  it('walks past a confidently-classified textarea to the cover-letter one', () => {
    render(
      '<label for="ab">About you</label><textarea id="ab" name="about"></textarea>' +
        '<textarea id="cl" name="cover_letter"></textarea>',
    );
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('skips the chat box and picks the cover-letter field further down', () => {
    render(
      '<textarea id="chat" name="chat_message"></textarea>' +
        '<textarea id="cl" name="cover_letter"></textarea>',
    );
    expect(resolveCoverTarget()).toBe(byId('cl'));
  });

  it('skips a cover-letter textarea sitting in a login form', () => {
    render(
      '<form><input type="password" name="pw" /><textarea id="cl" name="cover_letter"></textarea></form>' +
        '<textarea id="ok" name="cover_letter"></textarea>',
    );
    expect(resolveCoverTarget()).toBe(byId('ok'));
  });

  it('works against a document passed in explicitly', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><textarea id="cl" name="cover_letter"></textarea></body></html>',
      'text/html',
    );
    expect(resolveCoverTarget(doc)).toBe(doc.getElementById('cl'));
  });
});

describe('forgetCoverTargets', () => {
  it('drops both hints', () => {
    render('<textarea id="a" name="x1"></textarea><textarea id="b" name="x2"></textarea>');
    rememberFocusedField(byId('a'));
    rememberRecognizedCoverField(byId('b'));
    expect(resolveCoverTarget()).toBe(byId('a'));

    forgetCoverTargets();
    expect(resolveCoverTarget()).toBeNull();
  });
});
