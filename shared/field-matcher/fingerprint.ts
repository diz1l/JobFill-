import { MAX_CLASSIFY_FIELDS } from '../messages';

export type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export interface FieldFingerprint {
  element: FillableElement;
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  contextHeading: string;
  /** aria-describedby / help text — weak supporting signal */
  description: string;
  /** name/id (or data-* test hooks) stripped of framework noise and split by separators */
  semanticName: string;
  /** true when the control belongs to a search or filter widget, never to an application form */
  isSearchContext: boolean;
}

/** Strip diacritics and lowercase for cross-lingual matching */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Attributes that may carry a human-readable field identity, in priority order.
 * `data-automation-id` is Workday, `data-qa`/`data-testid` are Lever / SmartRecruiters,
 * `formcontrolname` is Angular, `ng-reflect-name` is Angular dev builds.
 */
const SEMANTIC_ATTRS = [
  'name',
  'id',
  'data-automation-id',
  'data-qa',
  'data-testid',
  'data-test',
  'data-field',
  'data-field-name',
  'formcontrolname',
  'ng-reflect-name',
] as const;

/** Extracted names that carry no meaning ("input 4", "field", "q 12345") */
const GENERIC_NAME = /^(?:input|field|text|textbox|value|control|element|item|q|question|answer)?[\s\d]*$/;

/**
 * Extract a human-readable token from obfuscated name/id attributes.
 * Examples:
 *   "_systemfield_name"            → "name"
 *   "job_application[first_name]"  → "first name"   (bracket content wins)
 *   "firstName"                    → "first name"
 *   "field-email_address"          → "email address"
 */
export function extractSemanticName(raw: string): string {
  if (!raw) return '';
  // PHP / Rails style `job_application[first_name]` — the identity lives inside the brackets
  const bracketed = raw.match(/\[([^\]]+)\]/g);
  const source = bracketed ? bracketed.map((b) => b.slice(1, -1)).join(' ') : raw;

  return source
    .replace(/^[\s_-]+/, '') // strip leading separators
    .replace(/^(?:systemfield|field|form|input|js|app|data|ctl\d*)[_-]/i, '') // common prefixes
    .replace(/[_\-.]+/g, ' ') // separators → space
    .replace(/([a-z\d])([A-Z])/g, '$1 $2') // camelCase → words
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** First attribute that yields a meaningful semantic name */
function pickSemanticName(el: Element): string {
  let fallback = '';
  for (const attr of SEMANTIC_ATTRS) {
    const raw = el.getAttribute(attr);
    if (!raw) continue;
    const extracted = extractSemanticName(raw);
    if (!extracted) continue;
    if (!GENERIC_NAME.test(extracted)) return extracted;
    if (!fallback) fallback = extracted;
  }
  return fallback;
}

/** Visible text of an element, with form controls and decorative markers removed */
function collectText(el: Element | null | undefined): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('input,textarea,select,button,script,style,svg,[aria-hidden="true"]')
    .forEach((child) => child.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * P1-5: `aria-labelledby` / `aria-describedby` hold a space separated *list* of IDs.
 * Resolving the whole attribute with getElementById returned null for the
 * `aria-labelledby="fieldLabel requiredMarker"` pattern used by Workday and
 * Greenhouse, silently losing the label on those forms.
 */
function textFromIdList(doc: Document, idList: string): string {
  return idList
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => collectText(doc.getElementById(id)))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function getLabelText(el: HTMLElement): string {
  const doc = el.ownerDocument;

  // 1. aria-labelledby — takes precedence per the accname spec
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = textFromIdList(doc, labelledBy);
    if (text) return text;
  }

  // 2. <label for="id"> — a control may be referenced by more than one label
  const id = el.getAttribute('id');
  if (id) {
    const labels = doc.querySelectorAll<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    const text = Array.from(labels).map(collectText).filter(Boolean).join(' ');
    if (text) return text;
  }

  // 3. Wrapping <label> (nested controls and decorations are stripped)
  const wrapper = el.closest('label');
  if (wrapper) {
    const text = collectText(wrapper);
    if (text) return text;
  }

  return '';
}

function getDescription(el: HTMLElement): string {
  const describedBy = el.getAttribute('aria-describedby');
  if (!describedBy) return '';
  return textFromIdList(el.ownerDocument, describedBy);
}

// ─── Context heading (P1-4) ──────────────────────────────────────────────────

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend', 'dt']);
const LABELISH_TAGS = new Set(['div', 'span', 'p', 'label', 'strong', 'b']);

/** How far up the ancestor chain we look for a heading */
const MAX_ANCESTOR_DEPTH = 5;
/**
 * How many previous siblings we inspect per level. Generous, because the check
 * is only a tagName/role comparison — a section heading typically sits above
 * several sibling field wrappers.
 */
const MAX_SIBLING_SCAN = 8;
/** Deeper than this a "div that looks like a label" is somebody else's label */
const MAX_FALLBACK_DEPTH = 2;
const MAX_HEADING_LENGTH = 80;
/** Text made only of punctuation / digits carries no signal */
const JUNK_TEXT = /^[\s*:•·|/\\\-–—+()[\]0-9]*$/;

function usableText(el: Element): string {
  const text = collectText(el);
  if (text.length < 2 || text.length > MAX_HEADING_LENGTH) return '';
  if (JUNK_TEXT.test(text)) return '';
  return text;
}

function isHeading(el: Element): boolean {
  return HEADING_TAGS.has(el.tagName.toLowerCase()) || el.getAttribute('role') === 'heading';
}

/**
 * P1-4: the old implementation walked every ancestor and accepted the text of
 * *any* previous div/span/p under 80 characters — on real ATS markup that is
 * usually the label of the neighbouring field or a breadcrumb, and it handed
 * a random rule +10 points. It was also O(ancestors × siblings) per field.
 *
 * Now: real headings (h1-h6 / legend / dt / role=heading) win at any of the
 * first `MAX_ANCESTOR_DEPTH` levels; a label-like sibling is only accepted when
 * it is the *immediately* preceding sibling, close to the field, holds no form
 * control of its own and is not a <label for> pointing at another control.
 * Text identical to the label is dropped — it is already scored as the label
 * and must not be counted a second time.
 * Bounded to `MAX_ANCESTOR_DEPTH × MAX_SIBLING_SCAN` node visits per field.
 */
function getContextHeading(el: HTMLElement, labelText: string): string {
  const body = el.ownerDocument.body;
  const ownId = el.getAttribute('id') ?? '';
  const alreadyKnown = labelText.toLowerCase();
  const isNew = (text: string) => (text && text.toLowerCase() !== alreadyKnown ? text : '');
  let node: Element | null = el;
  let fallback = '';

  for (let depth = 0; node && node !== body && depth < MAX_ANCESTOR_DEPTH; depth++) {
    // A <fieldset> ancestor labels everything inside it
    const parent = node.parentElement;
    if (parent && parent.tagName.toLowerCase() === 'fieldset') {
      const legend = Array.from(parent.children).find(
        (child) => child.tagName.toLowerCase() === 'legend',
      );
      if (legend) {
        const text = isNew(usableText(legend));
        if (text) return text;
      }
    }

    let prev: Element | null = node.previousElementSibling;
    for (let scanned = 0; prev && scanned < MAX_SIBLING_SCAN; scanned++) {
      if (isHeading(prev)) {
        const text = isNew(usableText(prev));
        if (text) return text;
      } else if (
        !fallback &&
        scanned === 0 &&
        depth <= MAX_FALLBACK_DEPTH &&
        LABELISH_TAGS.has(prev.tagName.toLowerCase()) &&
        !prev.querySelector('input,textarea,select,button') &&
        // a <label for="other-field"> belongs to a different control
        !(prev.tagName.toLowerCase() === 'label' && (prev.getAttribute('for') ?? ownId) !== ownId)
      ) {
        fallback = isNew(usableText(prev));
      }
      prev = prev.previousElementSibling;
    }

    node = node.parentElement;
  }

  return fallback;
}

// ─── Search / filter widgets ─────────────────────────────────────────────────

const SEARCH_NAME = /(?:^|[_\-\s[])(?:search|query|keyword|filter)|^q$/i;

/**
 * A search box is never an application field, but "Location" filters on job
 * boards look exactly like a city field (P1-2). Detect and skip them.
 */
function isSearchContext(el: Element): boolean {
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'search') return true;
  const role = el.getAttribute('role');
  if (role === 'searchbox' || role === 'search') return true;
  if (el.closest('[role="search"]')) return true;
  const name = (el.getAttribute('name') ?? '').toLowerCase();
  const id = (el.getAttribute('id') ?? '').toLowerCase();
  return SEARCH_NAME.test(name) || SEARCH_NAME.test(id);
}

// ─── Visibility ──────────────────────────────────────────────────────────────

const MAX_STYLE_ANCESTORS = 6;

/**
 * Cheap hidden-element test. Deliberately avoids `getBoundingClientRect` /
 * `offsetParent`: both force a layout pass, and doing that for 200 controls
 * would blow the 300 ms budget of NFR-3.
 */
function isHidden(el: FillableElement): boolean {
  if (el.hidden) return true;
  if (el.closest('[hidden],[aria-hidden="true"],[inert]')) return true;

  // Inline display/visibility on the element or its nearest ancestors.
  // getComputedStyle does not inherit `display:none` from a parent, so the
  // ancestor walk is what catches collapsed sections and closed accordions.
  let node: HTMLElement | null = el;
  for (let i = 0; node && i < MAX_STYLE_ANCESTORS; i++) {
    const style = node.style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    node = node.parentElement;
  }

  if (el.isConnected) {
    const computed = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return true;
  }

  return false;
}

/** Consent / GDPR controls are never touched (FR-2.6) */
const CONSENT_PATTERN = /consent|gdpr|agree|privacy|terms|souhlas/i;

function isConsentControl(el: FillableElement): boolean {
  const combined = [
    el.getAttribute('name') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('aria-label') ?? '',
    getLabelText(el),
  ].join(' ');
  return CONSENT_PATTERN.test(combined);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function buildFingerprint(el: FillableElement): FieldFingerprint {
  const name = el.getAttribute('name') ?? '';
  const id = el.getAttribute('id') ?? '';
  const labelText = getLabelText(el);
  return {
    element: el,
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name,
    id,
    placeholder: (el as HTMLInputElement).placeholder ?? '',
    ariaLabel: el.getAttribute('aria-label') ?? '',
    labelText,
    contextHeading: getContextHeading(el, labelText),
    description: getDescription(el),
    semanticName: pickSemanticName(el),
    isSearchContext: isSearchContext(el),
  };
}

/**
 * Serialize a fingerprint for transmission (no DOM references).
 *
 * S-3: this is the *complete* list of what a classification request may contain.
 * Note what is absent — the element, its `value`, the surrounding markup and any
 * profile data. Everything here is an attribute of the control or the text that
 * labels it, which is precisely the "field fingerprints only" of FR-5.3.
 *
 * `semanticName` is included even though it is derived rather than read: it is
 * `extractSemanticName` applied to `name` / `id` / `data-automation-id` / … , so
 * it discloses nothing the attributes do not already contain, and on obfuscated
 * ATS markup ("a7f3c91e" with `data-automation-id="preferredName"`) it is
 * frequently the only readable identity the field has. Leaving it out sent the
 * classifier fingerprints that were empty but for the label.
 */
export function serializeFingerprint(fp: FieldFingerprint): string {
  return [
    fp.autocomplete,
    fp.name,
    fp.id,
    fp.semanticName,
    fp.ariaLabel,
    fp.labelText,
    fp.placeholder,
    fp.contextHeading,
    fp.description,
  ].join('|');
}

/** A fingerprint with nothing but separators in it gives the model no signal. */
function hasSignal(fp: FieldFingerprint): boolean {
  return serializeFingerprint(fp).replace(/\|/g, '').trim().length > 0;
}

/**
 * What one FR-5.3 classification request is made of: the fields that were
 * selected, and the strings that describe them on the wire. The two arrays are
 * index-aligned, which is the contract the model answers against ("index → field
 * type") and the only way back from a reply to a DOM element.
 */
export interface ClassificationBatch {
  /** The selected fingerprints, in payload order. Never leaves the page. */
  fields: FieldFingerprint[];
  /** Exactly what is sent (S-3). */
  payload: string[];
}

/**
 * Pick the fingerprints worth classifying and serialize them.
 *
 * Two filters, both cheap: a control whose fingerprint is empty carries nothing
 * the model could reason about (it would burn a slot to be told "unknown"), and
 * the batch is capped at {@link MAX_CLASSIFY_FIELDS} — see there for why 40.
 */
export function buildClassificationBatch(
  fingerprints: readonly FieldFingerprint[],
): ClassificationBatch {
  const fields = fingerprints.filter(hasSignal).slice(0, MAX_CLASSIFY_FIELDS);
  return { fields, payload: fields.map(serializeFingerprint) };
}

/**
 * Input types that can never receive profile data.
 * `password` (P0-4) is the important one: it used to be enumerated, scored and
 * decorated with the inline fill button on every login form on the internet.
 * `search` goes with it — a search box is not an application field.
 */
const EXCLUDED_INPUT_TYPES = [
  'file',
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
  'checkbox',
  'radio',
  'password',
  'search',
  'color',
  'range',
];

const FILLABLE_SELECTOR = [
  `input${EXCLUDED_INPUT_TYPES.map((t) => `:not([type="${t}"])`).join('')}`,
  'textarea',
  'select',
].join(',');

/** Enumerate all fillable elements on the page */
export function enumerateFillable(root: Document | Element = document): FillableElement[] {
  return Array.from(root.querySelectorAll<FillableElement>(FILLABLE_SELECTOR)).filter((el) => {
    // Defence in depth: the selector filters by attribute, `type` reflects the
    // live property (and normalises unknown values to "text")
    if (el instanceof HTMLInputElement && EXCLUDED_INPUT_TYPES.includes(el.type.toLowerCase())) {
      return false;
    }
    // Disabled / read-only controls cannot meaningfully receive a value.
    // Read-only inputs on ATS forms are usually proxies for custom widgets.
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if ('readOnly' in el && el.readOnly) return false;
    if (el.hasAttribute('readonly')) return false;
    if (isHidden(el)) return false;
    if (isSearchContext(el)) return false;
    if (isConsentControl(el)) return false;
    return true;
  });
}
