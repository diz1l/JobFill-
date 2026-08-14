/**
 * Bilingual (English + Czech) rule dictionary for field classification.
 * Add new rules / languages here without touching engine code.
 *
 * ── How a rule is evaluated ──────────────────────────────────────────────────
 *  `pattern`  positive signal, scored at full weight (see scorer.ts).
 *  `weak`     supporting signal, scored at ~35% weight. For tokens that are
 *             genuinely ambiguous on their own ("location", "motivation") —
 *             they can push a field over the threshold together with a real
 *             signal, but never on their own.
 *  `negative` disqualifier. If it matches ANY fingerprint source the whole rule
 *             is dropped for that field.
 *
 * ── Boundary convention ──────────────────────────────────────────────────────
 * `\b` is useless here because `_` is a word character: `/\bname\b/` matches
 * `first_name`, and `/\btel\b/` does not match `tel_number`. Rules therefore use
 * "soft" boundaries `(?<![a-z])` … `(?![a-z])`, which treat `_ - . [ ] space`
 * as separators but still refuse to match inside a longer word
 * (`hotel`, `telegram`, `platform`).
 *
 * ── Cost model behind the negatives ──────────────────────────────────────────
 * A missed field costs the user one manual keystroke. A false positive writes
 * personal data into somebody else's field (and is submitted to an employer).
 * Negatives are therefore deliberately aggressive.
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
  /** Regex tested against name / id / semantic name / label / aria / placeholder / heading */
  pattern: RegExp;
  /** Ambiguous supporting tokens — scored at reduced weight */
  weak?: RegExp;
  /** If this matches any fingerprint source, the rule is disqualified */
  negative?: RegExp;
}

// ─── Shared vocabulary for negative contexts ─────────────────────────────────

/** Entities that own a field instead of the applicant */
const ORG = String.raw`compan(?:y|ies)|organi[sz]ations?|employers?|business|firms?|agenc(?:y|ies)|schools?|universit\w*|colleges?|institut\w*|teams?|departments?|brands?|products?|projects?|files?|folders?|documents?|domains?|accounts?|users?|logins?|display|nick|screen|pets?|child|bank|cards?|streets?|countr(?:y|ies)|events?|stores?|branch|spole[cč]nost\w*|firm\w*|n[aá]zev|[sš]kol\w*`;

/**
 * People who are not the applicant. Bare presence anywhere in the fingerprint
 * disqualifies personal-identity rules — a "Referral email" or an "Emergency
 * contact phone" must never receive the candidate's own data.
 */
const THIRD_PARTY = String.raw`referr?als?|referr?ers?|referees?|emergency|next[\s._-]*of[\s._-]*kin|guardian|spouse|witness|kontaktn[ií][\s._-]*osob\w*`;

/**
 * People (never the applicant) who can own a *personal* field.
 * Organisations are deliberately absent: a company has no first name, and
 * `user_first_name` must keep working.
 */
const PERSON_OWNER = String.raw`${THIRD_PARTY}|referenc\w*|managers?|supervisors?|recruiters?|contact[\s._-]*persons?|nad[rř][ií]zen\w*`;

/** Owners of contact details that are not the applicant's own */
const CONTACT_OWNER = String.raw`${PERSON_OWNER}|compan(?:y|ies)|employers?|organi[sz]ations?|schools?|universit\w*|logins?|sign[\s._-]*in|accounts?`;

/** Everything that can own a *named* thing — organisations included */
const NEARBY_OWNER = String.raw`${ORG}|${PERSON_OWNER}`;

/**
 * Build "<owner> [word] [word] <field>" / "<field> of the <owner>".
 * Matches `Company name`, `companyName`, `emergency contact name`,
 * `job_application[referral_name]`, `Name of the company`.
 *
 * Brackets deliberately do NOT count as separators: in the Rails convention
 * `job_application[location]` the wrapper `job_application` is form metadata,
 * not an owner of the field inside the brackets.
 */
function ownedField(owners: string, field: string): RegExp {
  return new RegExp(
    `(?<![a-z])(?:${owners})(?:[\\s._-]+[\\w']+){0,2}[\\s._-]*(?:${field})(?![a-z])` +
      `|(?<![a-z])(?:${field})[\\s._-]*(?:of|for)[\\s._-]*(?:the[\\s._-]*)?(?:${owners})`,
    'i',
  );
}

const THIRD_PARTY_PRESENT = new RegExp(`(?<![a-z])(?:${THIRD_PARTY})`, 'i');

/** `Jméno a příjmení` / `Celé jméno` — full name written out in Czech */
const CZECH_FULL_NAME = String.raw`cel[eé][\s._-]*jm[eé]no|jm[eé]no[\s._-]*(?:a[\s._-]*)?p[rř][ií]jmen[ií]`;

/** Sub-parts and non-person uses of the word "name" */
const NON_PERSON_NAME = String.raw`(?<![a-z])(?:first|last|given|family|middle|maiden|sur|user|nick|screen|display|file|folder|host|domain|brand|product|project|pet|child|band|team|page|site|event|city|street|countr(?:y|ie)|bank|card|holder|role|job|position)[\s._-]*names?(?![a-z])`;

export const FIELD_RULES: FieldRule[] = [
  {
    type: 'firstName',
    autocomplete: ['given-name'],
    pattern:
      /(?<![a-z])(?:first[\s._-]?name|given[\s._-]?name|forename|fname|jm[eé]no|k[rř]estn[ií]\w*)(?![a-z])/i,
    negative: new RegExp(
      `${CZECH_FULL_NAME}|${ownedField(PERSON_OWNER, String.raw`names?|jm[eé]no`).source}`,
      'i',
    ),
  },
  {
    type: 'lastName',
    autocomplete: ['family-name'],
    pattern:
      /(?<![a-z])(?:last[\s._-]?name|family[\s._-]?name|sur[\s._-]?name|lname|p[rř][ií]jmen[ií]\w*)(?![a-z])/i,
    negative: new RegExp(
      `${CZECH_FULL_NAME}|${ownedField(PERSON_OWNER, String.raw`names?|p[rř][ií]jmen[ií]`).source}`,
      'i',
    ),
  },
  {
    /**
     * P1-1: a bare `name` token is the single most dangerous pattern in the
     * dictionary — `Company name`, `Referral name`, `File name`, `Project name`
     * all used to score 45 (medium) and got the candidate's full name written
     * into them. The token is kept (ATS really do use `name="name"` for the
     * applicant) but is now guarded by a broad owner/sub-part negative.
     */
    type: 'fullName',
    autocomplete: ['name'],
    pattern: new RegExp(
      String.raw`(?<![a-z])(?:full[\s._-]?name|your[\s._-]?name|legal[\s._-]?name|preferred[\s._-]?name|candidate[\s._-]?name|applicant[\s._-]?name|names?)(?![a-z])|${CZECH_FULL_NAME}`,
      'i',
    ),
    negative: new RegExp(
      `${NON_PERSON_NAME}` +
        `|${ownedField(NEARBY_OWNER, String.raw`names?|jm[eé]no`).source}` +
        `|(?<![a-z])(?:compan(?:y|ies)|organi[sz]ations?|referr?als?|referees?|emergency)(?![a-z])`,
      'i',
    ),
  },
  {
    type: 'email',
    autocomplete: ['email'],
    pattern: /(?<![a-z])e[\s._-]?mail(?:ov\w*|s|u|y)?(?![a-z])/i,
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(CONTACT_OWNER, String.raw`e[\s._-]?mails?`).source}` +
        // signing the user up for something they did not ask for
        `|(?<![a-z])(?:newsletter|subscribe|subscription|marketing|mailing[\\s._-]*list)`,
      'i',
    ),
  },
  {
    /**
     * The old `tel(?!l)[.\s_-]?` matched `hotel`, `telegram` and `Intel`.
     * Soft boundaries make every alternative safe inside longer words.
     */
    type: 'phone',
    autocomplete: ['tel', 'tel-national'],
    pattern:
      /(?<![a-z])(?:phones?|telephones?|tel|mobile|mobil\w*|cell(?:phone|ular)?|handy|telefon\w*|whatsapp)(?![a-z])/i,
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}|${ownedField(CONTACT_OWNER, String.raw`phones?|tel\w*`).source}`,
      'i',
    ),
  },
  {
    type: 'linkedin',
    autocomplete: [],
    pattern: /linked[\s._-]?in/i,
    negative: THIRD_PARTY_PRESENT,
  },
  {
    type: 'github',
    autocomplete: [],
    pattern: /git[\s._-]?hub/i,
    negative: THIRD_PARTY_PRESENT,
  },
  {
    type: 'website',
    autocomplete: ['url'],
    pattern:
      /(?<![a-z])(?:web[\s._-]?site|home[\s._-]?page|web[\s._-]?page|portfolio|personal[\s._-]?(?:url|site|web|page)|osobn[ií][\s._-]*web\w*)(?![a-z])/i,
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(String.raw`compan(?:y|ies)|employers?|organi[sz]ations?|firms?|schools?|universit\w*|products?|projects?`, String.raw`web[\s._-]?site|url|page|web`).source}`,
      'i',
    ),
  },
  {
    type: 'salary',
    autocomplete: [],
    pattern:
      /(?<![a-z])(?:salar(?:y|ies)|compensation|wage|remuneration|expected[\s._-]*(?:pay|salary)|pay[\s._-]*expectations?|mzda|mzdov\w*|plat(?:ov\w*|[uy]|em)?|odm[eě]n\w*|finan[cč]n[ií][\s._-]*o[cč]ek[aá]v[aá]n\w*)(?![a-z])/i,
  },
  {
    /**
     * P1-2: bare `location` used to score 75 on a job-search filter
     * (`name=location` + `aria-label="Location"`) and got the user's city typed
     * into it. `location` is now a weak token: it needs a real city signal
     * (or several independent occurrences) to reach the fill threshold.
     */
    type: 'city',
    autocomplete: ['address-level2'],
    pattern:
      /(?<![a-z])(?:cit(?:y|ies)|town|m[eě]st[oaeě]|obec|bydli[sš]t[eě]\w*)(?![a-z])|(?<![a-z])(?:current|home|your|candidate|applicant|residence|residential|permanent|mailing|primary|preferred|based)[\s._-]*locations?(?![a-z])|(?<![a-z])locations?[\s._-]*[(:]?[\s._-]*(?:city|town)(?![a-z])/i,
    weak: /(?<![a-z])locations?(?![a-z])/i,
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(String.raw`jobs?|office|work\w*|positions?|roles?|vacanc\w*|interviews?|meetings?|trainings?|search|filter|remote|${ORG}`, String.raw`cit(?:y|ies)|locations?`).source}`,
      'i',
    ),
  },
  {
    /**
     * `motivat` alone matched "What motivates you about this role?" and pasted
     * the whole cover letter into an open question. The stem now has to be part
     * of an actual letter noun; bare "motivation" is a weak signal.
     */
    type: 'coverLetter',
    autocomplete: [],
    pattern:
      /(?<![a-z])(?:cover(?:ing)?[\s._-]?letter|motivation[\s._-]?letter|letter[\s._-]?of[\s._-]?(?:motivation|interest)|motiva[cč]n[ií]\w*|pr[uů]vodn[ií]\w*)(?![a-z])/i,
    // No negative needed: "What motivates you about this role?" only reaches the
    // weak tier (19 points), so the open-question detector picks it up instead.
    weak: /(?<![a-z])motivations?(?![a-z])/i,
  },
  {
    type: 'availability',
    autocomplete: [],
    pattern:
      /(?<![a-z])(?:availab\w*|notice[\s._-]?period|start(?:ing)?[\s._-]?date|earliest[\s._-]*(?:start|available|possible)\w*|n[aá]stup\w*|dostupnost\w*|term[ií]n[\s._-]*n[aá]stupu)(?![a-z])/i,
    negative:
      /(?<![a-z])(?:projects?|contracts?|education|study|studies|courses?|schools?|assignments?|internships?|previous|employment)[\s._-]*(?:\w+[\s._-]*){0,1}(?:start|end)?[\s._-]*dates?(?![a-z])|(?<![a-z])end[\s._-]?dates?(?![a-z])|dates?[\s._-]*of[\s._-]*birth/i,
  },
  {
    type: 'workPermit',
    autocomplete: [],
    pattern:
      /(?<![a-z])(?:work(?:ing)?[\s._-]?permits?|work[\s._-]?visas?|visas?(?:[\s._-]*(?:status|type|sponsorship))?|citizenship|citizens?|nationality|(?:work|employment)[\s._-]*authori[sz]\w*|authori[sz]ed[\s._-]*to[\s._-]*work|right[\s._-]*to[\s._-]*work|sponsorship|pracovn[ií][\s._-]*povolen[ií]|povolen[ií][\s._-]*k[\s._-]*pob\w*|ob[cč]anstv\w*)(?![a-z])/i,
    negative: /(?<![a-z])(?:credit|debit|payment|billing)(?![a-z])/i,
  },
  {
    type: 'about',
    autocomplete: [],
    pattern:
      /(?<![a-z])(?:about|summary|bio|biography|souhrn|o[\s._-]sob[eě]|profil)(?![a-z])/i,
    negative:
      /(?<![a-z])about[\s._-]*(?:this|the|us|our|compan|role|job|position|team|process|product|vacanc)|(?<![a-z])(?:order|application|job|position|salary|payment|billing)[\s._-]*summar|linked[\s._-]?in|git[\s._-]?hub|twitter|facebook|instagram/i,
  },
];
