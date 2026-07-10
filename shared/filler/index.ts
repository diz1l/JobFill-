import type { Profile, FillSummary } from '../types';
import { buildFingerprint, enumerateFillable } from '../field-matcher/fingerprint';
import { scoreField } from '../field-matcher/scorer';
import { setNativeValue } from './setNativeValue';
import { fillSelect } from './selectStrategy';
import { highlightField } from './highlight';

/** Map a matched field type to the corresponding profile value */
function resolveValue(fieldType: string, profile: Profile, coverLetterText: string): string {
  const map: Record<string, string> = {
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: `${profile.firstName} ${profile.lastName}`.trim(),
    email: profile.email,
    phone: profile.phone,
    linkedin: profile.linkedin,
    github: profile.github,
    website: profile.website,
    salary: profile.salaryExpectation,
    city: profile.city,
    coverLetter: coverLetterText,
    availability: profile.availability,
    workPermit: profile.workPermit,
    about: profile.about,
  };
  return map[fieldType] ?? '';
}

export interface FillOptions {
  highlightDurationMs?: number;
  /** Pre-resolved cover letter text (placeholders already substituted) */
  coverLetterText?: string;
}

/**
 * Main fill entry point.  Enumerates the page, scores each field,
 * fills high/medium confidence ones, highlights everything.
 */
export function fillPage(profile: Profile, opts: FillOptions = {}): FillSummary {
  const durationMs = opts.highlightDurationMs ?? 3000;
  const coverLetterText = opts.coverLetterText ?? '';
  const elements = enumerateFillable();

  const summary: FillSummary = {
    total: elements.length,
    high: 0,
    medium: 0,
    unrecognized: 0,
    fileInputs: 0,
    aiQuestions: 0,
  };

  // Highlight file inputs separately (never fill)
  document
    .querySelectorAll<HTMLInputElement>('input[type="file"]')
    .forEach((el) => {
      summary.fileInputs++;
      highlightField(el, 'file', durationMs);
    });

  for (const el of elements) {
    const fp = buildFingerprint(el);
    const match = scoreField(fp);

    if (!match || match.confidence === 'low' || match.confidence === 'none') {
      summary.unrecognized++;
      highlightField(el, 'none', durationMs);
      continue;
    }

    // Open-ended question — skip fill, highlight as AI-needed
    if (match.fieldType === 'openQuestion') {
      summary.aiQuestions++;
      highlightField(el, 'ai', durationMs);
      continue;
    }

    const value = resolveValue(match.fieldType, profile, coverLetterText);

    if (!value) {
      // Field type recognized but profile value is empty — skip silently
      summary.unrecognized++;
      continue;
    }

    if (el instanceof HTMLSelectElement) {
      const filled = fillSelect(el, value);
      if (filled) {
        if (match.confidence === 'high') {
          summary.high++;
        } else {
          summary.medium++;
        }
        highlightField(el, match.confidence, durationMs);
      } else {
        summary.unrecognized++;
        highlightField(el, 'none', durationMs);
      }
    } else {
      setNativeValue(el, value);
      if (match.confidence === 'high') {
        summary.high++;
      } else {
        summary.medium++;
      }
      highlightField(el, match.confidence, durationMs);
    }
  }

  return summary;
}

export { setNativeValue } from './setNativeValue';
export { fillSelect } from './selectStrategy';
export { highlightField, removeAllHighlights, removeStyles } from './highlight';
