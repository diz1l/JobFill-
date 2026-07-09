/**
 * Bilingual (English + Czech) rule dictionary for field classification.
 * Add new rules here without touching engine code.
 */

export type FieldType =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'linkedin'
  | 'github'
  | 'website'
  | 'salary'
  | 'city'
  | 'coverLetter'
  | 'availability'
  | 'workPermit'
  | 'about';

export interface FieldRule {
  type: FieldType;
  /** Exact autocomplete attribute values that unambiguously identify this field */
  autocomplete: string[];
  /** Regex tested against name / id / label / placeholder / aria-label / heading */
  pattern: RegExp;
}

export const FIELD_RULES: FieldRule[] = [
  {
    type: 'firstName',
    autocomplete: ['given-name'],
    pattern: /first[.\s_-]?name|given[.\s_-]?name|forename|jm[eé]no|jmeno|křestn[ií]|krestni/i,
  },
  {
    type: 'lastName',
    autocomplete: ['family-name'],
    pattern: /last[.\s_-]?name|family[.\s_-]?name|surname|příjmen[ií]|prijmeni/i,
  },
  {
    type: 'fullName',
    autocomplete: ['name'],
    pattern: /\bfull[.\s_-]?name\b|\bname\b|cel[eé][.\s_-]?jm[eé]no/i,
  },
  {
    type: 'email',
    autocomplete: ['email'],
    pattern: /e-?mail/i,
  },
  {
    type: 'phone',
    autocomplete: ['tel', 'tel-national'],
    pattern: /phone|tel(?!l)[.\s_-]?|mobil|telefon/i,
  },
  {
    type: 'linkedin',
    autocomplete: [],
    pattern: /linkedin/i,
  },
  {
    type: 'github',
    autocomplete: [],
    pattern: /github/i,
  },
  {
    type: 'website',
    autocomplete: ['url'],
    pattern: /website|portfolio|personal[.\s_-]?url|web[.\s_-]?page|osobn[ií][.\s_-]?web/i,
  },
  {
    type: 'salary',
    autocomplete: [],
    pattern: /salary|compensation|mzda|plat[.\s_-]|odm[eě]na/i,
  },
  {
    type: 'city',
    autocomplete: ['address-level2'],
    pattern: /\bcity\b|location|m[eě]sto|adresa|bydlišt[eě]/i,
  },
  {
    type: 'coverLetter',
    autocomplete: [],
    pattern: /cover[.\s_-]?letter|motivat|průvodn[ií]|motivačn[ií]/i,
  },
  {
    type: 'availability',
    autocomplete: [],
    pattern: /availab|notice[.\s_-]?period|start[.\s_-]?date|nastup|dostupnost/i,
  },
  {
    type: 'workPermit',
    autocomplete: [],
    pattern: /work[.\s_-]?permit|visa|citizen|authoriz|pracovn[ií][.\s_-]?povolen[ií]/i,
  },
  {
    type: 'about',
    autocomplete: [],
    pattern: /\babout\b|\bsummary\b|\bbio\b|profil[.\s_-]|souhrn|o[.\s_-]sob[eě]/i,
  },
];
