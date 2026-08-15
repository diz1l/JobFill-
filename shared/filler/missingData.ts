/**
 * Turning "recognised, but we have nothing to write" into something the user can
 * act on.
 *
 * The first live run ended with the Czech "Přiložte motivační dopis" textarea
 * empty and a counter that said *skipped*. Nothing was broken — the user had
 * simply never written a cover-letter template — but the extension had no
 * vocabulary for saying so, so the outcome was indistinguishable from failing to
 * understand the field.
 *
 * Deliberately DOM-free, `chrome.*`-free and dependency-free, so the popup can
 * import it as a leaf without pulling the filler — and with it the whole field
 * matcher — into the extension UI bundle.
 */

/** The one missing "field" that is not a profile entry — it lives in templates. */
export const COVER_LETTER_FIELD = 'coverLetter';

/**
 * Human names for the field types `resolveValue()` can come up empty on.
 *
 * Keys are the matcher's field types; anything absent here is skipped rather
 * than shown raw, because "salaryExpectation" in a toast reads like a bug.
 */
export const MISSING_DATA_LABELS: Readonly<Record<string, string>> = {
  firstName: 'first name',
  middleName: 'middle name',
  lastName: 'last name',
  fullName: 'name',
  preferredName: 'preferred name',
  nameSuffix: 'name suffix',
  email: 'email',
  phone: 'phone',
  linkedin: 'LinkedIn URL',
  github: 'GitHub URL',
  website: 'website',
  addressLine1: 'street address',
  addressLine2: 'second address line',
  city: 'city',
  state: 'state or region',
  postalCode: 'postcode',
  country: 'country',
  nationality: 'nationality',
  dateOfBirth: 'date of birth',
  workPermit: 'work permit',
  education: 'education',
  drivingLicence: 'driving licence',
  preferredLanguage: 'preferred language',
  currentTitle: 'current job title',
  currentEmployer: 'current employer',
  yearsOfExperience: 'years of experience',
  salary: 'salary expectation',
  availability: 'availability',
  about: 'about text',
};

/** Beyond this many names the sentence stops being readable. */
const MAX_NAMED = 3;

/** `a`, `a and b`, `a, b and c`, `a, b, c and 2 more`. */
function joinList(items: readonly string[]): string {
  // `join` rather than `items[0] ?? ''`: same answer for none and for one, and
  // no branch that no caller can reach.
  if (items.length <= 1) return items.join('');
  const named = items.slice(0, MAX_NAMED);
  const rest = items.length - named.length;
  const tail = rest > 0 ? `${rest} more` : named.pop()!;
  return `${named.join(', ')} and ${tail}`;
}

export interface MissingDataBreakdown {
  /** No cover-letter template exists (or the first one resolved to nothing). */
  coverLetter: boolean;
  /** Human labels of the blank profile entries, in the order they were hit. */
  profileFields: string[];
}

/** Split raw field types into the two things the user has to do about them. */
export function splitMissingData(fieldTypes: readonly string[]): MissingDataBreakdown {
  const seen = new Set<string>();
  const profileFields: string[] = [];
  let coverLetter = false;

  for (const type of fieldTypes) {
    if (seen.has(type)) continue;
    seen.add(type);
    if (type === COVER_LETTER_FIELD) {
      coverLetter = true;
      continue;
    }
    const label = MISSING_DATA_LABELS[type];
    if (label) profileFields.push(label);
  }

  return { coverLetter, profileFields };
}

/**
 * One or two sentences naming what is missing and where to fix it, or `''` when
 * there is nothing to say.
 *
 * The cover letter gets its own sentence with two exits, because it has two:
 * write a template once, or generate a letter for this posting from the popup.
 * Neither happens on its own — a form that goes to an employer never receives
 * text the user has not seen (an empty field beats invented prose), but staying
 * silent about it is what produced the original bug report.
 */
export function describeMissingData(fieldTypes: readonly string[]): string {
  const { coverLetter, profileFields } = splitMissingData(fieldTypes);
  const sentences: string[] = [];

  if (coverLetter) {
    sentences.push(
      'No cover letter template yet — add one in JobFill settings, or open JobFill to generate a letter for this job.',
    );
  }
  if (profileFields.length > 0) {
    const verb = profileFields.length === 1 ? 'it' : 'them';
    sentences.push(
      `Your profile has no ${joinList(profileFields)} — add ${verb} in JobFill settings.`,
    );
  }

  return sentences.join(' ');
}
