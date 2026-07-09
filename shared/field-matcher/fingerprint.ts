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
}

/** Strip diacritics and lowercase for cross-lingual matching */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function getLabelText(el: HTMLElement): string {
  // 1. <label for="id">
  const id = el.getAttribute('id');
  if (id) {
    const label = el.ownerDocument.querySelector<HTMLLabelElement>(
      `label[for="${CSS.escape(id)}"]`,
    );
    if (label) return label.textContent?.trim() ?? '';
  }

  // 2. Wrapping <label>
  const ancestor = el.closest('label');
  if (ancestor) {
    const clone = ancestor.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input,textarea,select').forEach((c) => c.remove());
    return clone.textContent?.trim() ?? '';
  }

  // 3. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = el.ownerDocument.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() ?? '';
  }

  return '';
}

function getContextHeading(el: HTMLElement): string {
  let node: Element | null = el;
  while (node && node !== el.ownerDocument.body) {
    let prev: Element | null = node.previousElementSibling;
    while (prev) {
      const tag = prev.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag) || tag === 'legend' || tag === 'dt') {
        return prev.textContent?.trim() ?? '';
      }
      // Some forms put label-like text in a sibling div
      if (tag === 'div' || tag === 'span' || tag === 'p') {
        const text = prev.textContent?.trim() ?? '';
        if (text.length > 0 && text.length < 80) return text;
      }
      prev = prev.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

export function buildFingerprint(el: FillableElement): FieldFingerprint {
  return {
    element: el,
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '',
    placeholder: (el as HTMLInputElement).placeholder ?? '',
    ariaLabel: el.getAttribute('aria-label') ?? '',
    labelText: getLabelText(el),
    contextHeading: getContextHeading(el),
  };
}

/** Serialize a fingerprint for transmission (no DOM references) */
export function serializeFingerprint(fp: FieldFingerprint): string {
  return [fp.autocomplete, fp.name, fp.id, fp.ariaLabel, fp.labelText, fp.placeholder].join('|');
}

/** Enumerate all fillable elements on the page */
export function enumerateFillable(root: Document | Element = document): FillableElement[] {
  const selector = [
    'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="checkbox"]):not([type="radio"])',
    'textarea',
    'select',
  ].join(',');

  return Array.from(root.querySelectorAll<FillableElement>(selector)).filter((el) => {
    // Skip disabled / readonly (optional: might want to highlight but not fill)
    if ((el as HTMLInputElement).disabled) return false;
    // Skip consent-like fields (never touch)
    const consentPattern = /consent|gdpr|agree|privacy|terms/i;
    const fp = buildFingerprint(el);
    const combined = [fp.name, fp.id, fp.ariaLabel, fp.labelText].join(' ');
    if (consentPattern.test(combined)) return false;
    return true;
  });
}
