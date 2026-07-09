/**
 * Strategy for filling native <select> elements.
 * Chooses the option whose text or value best matches the profile datum
 * (normalized, diacritics-folded, case-insensitive).
 *
 * Returns true if an option was selected, false if none matched.
 */

const SIMILARITY_THRESHOLD = 0.5;

function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, '')
    .trim();
}

function containsScore(source: string, target: string): number {
  if (!source || !target) return 0;
  const s = normalize(source);
  const t = normalize(target);
  if (s === t) return 1;
  if (s.includes(t) || t.includes(s)) return 0.8;
  // Word overlap
  const sWords = new Set(s.split(/\s+/));
  const tWords = t.split(/\s+/);
  const overlap = tWords.filter((w) => sWords.has(w)).length;
  return overlap / Math.max(sWords.size, tWords.length);
}

export function fillSelect(el: HTMLSelectElement, value: string): boolean {
  let bestIndex = -1;
  let bestScore = 0;

  for (let i = 0; i < el.options.length; i++) {
    const opt = el.options[i];
    const scoreByText = containsScore(opt.text, value);
    const scoreByValue = containsScore(opt.value, value);
    const score = Math.max(scoreByText, scoreByValue);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestScore >= SIMILARITY_THRESHOLD && bestIndex >= 0) {
    el.selectedIndex = bestIndex;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  return false;
}
