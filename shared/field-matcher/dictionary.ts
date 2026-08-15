/**
 * Multilingual (English + Czech + Slovak) rule dictionary for field
 * classification. Add new rules / languages here without touching engine code.
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
 * the "soft" boundaries {@link NB} / {@link NA}, which treat `_ - . [ ] space`
 * as separators but still refuse to match inside a longer word
 * (`hotel`, `telegram`, `platform`).
 *
 * ── Why the alternation lists are long ───────────────────────────────────────
 * Both field-level bugs seen on live forms were a *missing synonym* rather than
 * a scoring mistake: `lokalita` and `nastoupit` were simply absent. Breadth of
 * vocabulary is the rule's primary job, so each field is enumerated along six
 * axes: Czech with and without diacritics in every case form the label can take
 * (`jméno` / `jména` / `jménem` — the scorer folds diacritics, but a stem written
 * `x\w*` still stops dead on a non-ASCII letter); Slovak, since Czech boards
 * carry Slovak vacancies verbatim; English including the exact wording of the
 * big ATS (Workday `Legal Name`, Greenhouse `Full name`, Workable `Cover
 * letter`); compound and colloquial phrasings (`Jméno a příjmení`, `Kdy můžete
 * nastoupit?`); abbreviations (`tel.`, `mob.`, `GSM`); and attribute spellings
 * (`fname`, `given-name`, `candidate[first_name]`).
 *
 * Composite alternatives ("salary expectations", "platové očekávání") are ONE
 * alternative rather than a bare noun, because a match that swallows the *whole*
 * label earns `DEDICATED_BONUS` and can then fill from a label alone — which on
 * Jobs.cz / Prace.cz is the only signal there is. Leaving the adjective stranded
 * is the difference between 20 points (never filled) and 35 (filled).
 *
 * ── Cost model behind the negatives ──────────────────────────────────────────
 * A missed field costs one manual keystroke. A false positive writes personal
 * data into somebody else's field and submits it to an employer. Negatives are
 * therefore deliberately aggressive, and every widening of a positive list is
 * paired with the owner / filter / third-party contexts that token appears in on
 * the other side of the same form.
 */

export type FieldType =
  | 'firstName'
  | 'lastName'
  | 'middleName'
  | 'preferredName'
  | 'nameSuffix'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'linkedin'
  | 'github'
  | 'website'
  | 'salary'
  | 'city'
  | 'addressLine1'
  | 'addressLine2'
  | 'postalCode'
  | 'state'
  | 'country'
  | 'nationality'
  | 'dateOfBirth'
  | 'drivingLicence'
  | 'education'
  | 'preferredLanguage'
  | 'currentTitle'
  | 'currentEmployer'
  | 'yearsOfExperience'
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

// ─── Soft boundaries ─────────────────────────────────────────────────────────

/**
 * Every letter Czech and Slovak can spell a word with: ASCII plus Latin-1
 * Supplement and Latin Extended-A/B (á č ď é ě í ň ó ř š ť ú ů ý ž, and the
 * Slovak ä ĺ ľ ô ŕ), in both cases.
 */
const LETTER = String.raw`a-zÀ-ɏ`;

/**
 * "No letter immediately before / after."
 *
 * The plain ASCII form `(?<![a-z])` leaks on Czech text, expensively: `í` is not
 * an ASCII letter, so `(?<![a-z])jmen` matched *inside* `příjmení` and every
 * surname field on a Czech form scored as a given name. Naming the accented
 * letters closes that hole in both directions.
 *
 * A match ending just before an accented letter (`k[rř]estn` in `Křestní`) is
 * rejected on the raw string; the scorer's diacritics-folded second pass is what
 * matches it — exactly the split of labour those two passes exist for.
 */
const NB = `(?<![${LETTER}])`;
const NA = `(?![${LETTER}])`;

// ─── Shared vocabulary for negative contexts ─────────────────────────────────

/** Entities that own a field instead of the applicant */
const ORG = String.raw`compan(?:y|ies)|organi[sz]ations?|employers?|business(?:es)?|firms?|agenc(?:y|ies)|schools?|universit\w*|colleges?|institut\w*|teams?|departments?|brands?|products?|projects?|files?|folders?|documents?|domains?|accounts?|users?|logins?|display|nick|screen|pets?|child|bank|cards?|streets?|countr(?:y|ies)|events?|stores?|branch(?:es)?|clients?|vendors?|suppliers?|startups?|spole[cč]nost\w*|firm\w*|firemn\w*|n[aá]zev|[sš]kol\w*|zam[eě]stnavatel\w*|organizac\w*|univerzit\w*|instituc\w*|agentur\w*|pobo[cč]k\w*|provozovn\w*`;

/**
 * People who are not the applicant. Bare presence anywhere in the fingerprint
 * disqualifies personal-identity rules — a "Referral email" or an "Emergency
 * contact phone" must never receive the candidate's own data.
 */
const THIRD_PARTY = String.raw`referr?als?|referr?ers?|referees?|emergency|next[\s._-]*of[\s._-]*kin|guardian|spouse|witness|kontaktn[ií][\s._-]*osob\w*|nouzov\w*|t[ií]s[nň]ov\w*|man[zž]el\w*|doporu[cč]uj[ií]c\w*`;

/**
 * People (never the applicant) who can own a *personal* field.
 * Organisations are deliberately absent: a company has no first name, and
 * `user_first_name` must keep working.
 */
const PERSON_OWNER = String.raw`${THIRD_PARTY}|referenc\w*|managers?|supervisors?|recruiters?|contact[\s._-]*persons?|nad[rř][ií]zen\w*|person[aá]list\w*|n[aá]bor[aá][rř]\w*`;

/** Owners of contact details that are not the applicant's own */
const CONTACT_OWNER = String.raw`${PERSON_OWNER}|compan(?:y|ies)|employers?|organi[sz]ations?|schools?|universit\w*|logins?|sign[\s._-]*in|accounts?|p[rř]ihla[sš]ovac\w*`;

/** Everything that can own a *named* thing — organisations included */
const NEARBY_OWNER = String.raw`${ORG}|${PERSON_OWNER}`;

/** Owners of a link: a company's LinkedIn page is not the candidate's */
const LINK_OWNER = String.raw`compan(?:y|ies)|employers?|organi[sz]ations?|firms?|business(?:es)?|schools?|universit\w*|products?|projects?|clients?|agenc(?:y|ies)|spole[cč]nost\w*|firemn\w*|zam[eě]stnavatel\w*`;

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
    `${NB}(?:${owners})(?:[\\s._-]+[\\w']+){0,2}[\\s._-]*(?:${field})${NA}` +
      `|${NB}(?:${field})[\\s._-]*(?:of|for)[\\s._-]*(?:the[\\s._-]*)?(?:${owners})`,
    'i',
  );
}

/**
 * Organisations as they appear in Czech and Slovak labels, in the *genitive* —
 * the form they take when they own the noun in front of them.
 */
const CZ_OWNER_GENITIVE = String.raw`spole[cč]nost\w*|firm\w*|zam[eě]stnavatel\w*|organizac\w*|instituc\w*|[sš]kol\w*|univerzit\w*|agentur\w*|projektu|souboru|dokumentu|dom[eé]ny|[uú][cč]tu|t[yý]mu|odd[eě]len[ií]|pobo[cč]k\w*|provozovn\w*|klienta|zam[eě]stnance|nad[rř][ií]zen[eé]ho|referenc\w*|kontaktn[ií][\s._-]*osoby`;

/**
 * Czech and Slovak put the owner *after* the noun it owns, in the genitive:
 * `Jméno společnosti`, `Název firmy`, `Lokalita pobočky`. {@link ownedField}
 * only builds the English "<owner> <field>" word order, so that whole family of
 * labels slipped through — which is why `Jméno společnosti` scored as a
 * `firstName`, one signal short of being filled with the candidate's given name.
 */
function czOwnedField(field: string): RegExp {
  return new RegExp(`${NB}(?:${field})[\\s._-]+(?:${CZ_OWNER_GENITIVE})`, 'i');
}

const THIRD_PARTY_PRESENT = new RegExp(`${NB}(?:${THIRD_PARTY})`, 'i');

// ─── Category selectors ──────────────────────────────────────────────────────

/**
 * Nouns that turn a field from "give me the value" into "tell me which *kind*
 * of value this is": `Phone Type`, `Address Type`, `Name Type`, `Email Type`,
 * `Contact Method`, `Typ telefonu`, `Druh adresy`.
 */
const CATEGORY_NOUN = String.raw`types?|kinds?|categor(?:y|ies)|classifications?|methods?|typ[uy]?|druh[uy]?|kategori\w*|zp[uů]sob\w*`;

/**
 * "<field> … <category noun>" / "<category noun> of <field>" — a control that
 * asks which *sort* of `field` this is, rather than for a `field`.
 *
 * This is why `Phone Type` — a Mobile / Home / Work `<select>` — was filled with
 * "+420737647855" on a live Workday form. It scored phone/60/medium, and both
 * halves of that 60 were legitimate: `data-automation-id="phone-device-type"`
 * really does say "phone" (25), and the label really is nothing but the word
 * "Phone" plus a qualifier the scorer treats as grammar (`type` is in
 * `FILLER_WORD` as the imperative "Type your name here"), so it earned
 * `DEDICATED_BONUS` on top of the label's 20.
 *
 * It is expressed as a `negative` rather than as a scoring penalty or a
 * `<select>` check, for three reasons.
 *
 *  1. **Only a disqualifier is strong enough.** Blocking the dedicated bonus
 *     would have left `Phone Type` on 45 — still over `MEDIUM_THRESHOLD`, still
 *     filled. A negative drops the rule to 0 whichever source carried it.
 *  2. **The tag is not the signal.** Keying on `<select>` would break every
 *     selector this dictionary is *supposed* to fill (`country`, `state`,
 *     `education`, `preferredLanguage`, `nameSuffix` are all `<select>` on the
 *     same form) while missing a `Phone Type` rendered as a radio group.
 *  3. **It is per-rule on purpose.** For a handful of rules the category *is*
 *     the value the profile holds — `Visa type`, `Driving licence category`,
 *     `Education level` — so they must keep matching "type"/"category" wording.
 *     Those rules simply do not call this helper; a cross-cutting check in the
 *     scorer could not make that distinction.
 *
 * Up to two intervening words, matching {@link ownedField}, so Workday's real
 * `Phone Device Type` is caught as well as the bare `Phone Type`.
 */
function categoryOf(field: string): RegExp {
  return new RegExp(
    `${NB}(?:${field})(?:[\\s._-]+[\\w']+){0,2}[\\s._-]*(?:${CATEGORY_NOUN})${NA}` +
      `|${NB}(?:${CATEGORY_NOUN})[\\s._-]*(?:of[\\s._-]*|for[\\s._-]*)?(?:the[\\s._-]*)?(?:${field})${NA}`,
    'i',
  );
}

/** Every spelling of a phone, for the negatives that must name the same field */
const PHONE_FIELD = String.raw`phones?|telephones?|mobiles?|cell\w*|telef[oó]n\w*|mobil\w*`;

/**
 * "Whose phone is this" adjectives. They chain — `Mobile/Alternate Phone` is
 * two of them and a noun — and they are only ever matched as part of a compound
 * ending in a phone noun, so a bare "Home" or "Work" still means nothing.
 */
const PHONE_QUALIFIER = String.raw`mobiles?|cells?|cellulars?|alternates?|alternatives?|secondary|primary|additional|others?|home|work|business|personal|private|day(?:time)?|evening|preferred|main|direct|contact`;

// ─── Name parts ──────────────────────────────────────────────────────────────

/**
 * The three name parts that were *added* to the dictionary, in the spellings a
 * rule needs when it has to say "not that one".
 *
 * `firstName` and `lastName` are absent because nothing needs to exclude them:
 * their tokens are distinctive enough that no other rule's pattern reaches
 * them. The reverse is not true. `Legal MiddleName` sits between `Legal
 * FirstName` and `Legal LastName` on the live form, and the Czech spellings
 * share the word `jméno` outright — `Prostřední jméno` matched the `firstName`
 * rule exactly as well as it matched its own, which is a tie, which is a field
 * left empty. So every name rule names these three in its `negative`, minus
 * whichever one it is itself.
 *
 * Slovak/British `second name` is deliberately absent from `middle`: it means
 * the *surname*, and it already belongs to `lastName`.
 */
const NAME_PART = {
  middle: String.raw`middle[\s._-]?(?:names?|initials?)|prost[rř]edn\w*[\s._-]*(?:jm[eé]n\w*|meno)|druh[eéyý][\s._-]*jm[eé]n\w*|stredn[eé][\s._-]*meno`,
  preferred: String.raw`(?:preferred|chosen|informal|familiar)[\s._-]*(?:first[\s._-]*)?names?|nick[\s._-]?names?|known[\s._-]*as|goes[\s._-]*by|p[rř]ezd[ií]v\w*|preferovan\w*[\s._-]*jm[eé]n\w*`,
  suffix: String.raw`suffixe?s?|post[\s._-]?nominals?|titul[\s._-]*za[\s._-]*(?:jm[eé]nem|menom)|koncovk\w*[\s._-]*jm[eé]n\w*`,
} as const;

/** Every spelling of "name", for owner and category negatives */
const NAME_FIELD = String.raw`names?|jm[eé]n\w*|meno|p[rř][ií]jmen[ií]\w*|priezvisk\w*`;

/** "This field is one of the other name parts, so it is not mine" */
function otherNameParts(...parts: (keyof typeof NAME_PART)[]): string {
  return `${NB}(?:${parts.map((p) => NAME_PART[p]).join('|')})`;
}

/**
 * `Jméno a příjmení` / `Celé jméno` / `Meno a priezvisko` — a full name written
 * out in Czech or Slovak, in either word order. Disqualifies the two halves so
 * the compound label resolves to `fullName` rather than to whichever half the
 * regex happened to see first.
 */
const CZECH_FULL_NAME = String.raw`cel[eé][\s._-]*(?:jm[eé]no|meno)|pln[eé][\s._-]*jm[eé]no|jm[eé]n[oa][\s._-]*(?:a[\s._-]*)?p[rř][ií]jmen[ií]|p[rř][ií]jmen[ií][\s._-]*(?:a[\s._-]*)?jm[eé]no|meno[\s._-]*(?:a[\s._-]*)?priezvisko|priezvisko[\s._-]*(?:a[\s._-]*)?meno`;

/**
 * The English mirror of {@link CZECH_FULL_NAME}: `First and last name`,
 * `First & last name`, `Name and surname`, `Given / family name`. Without this
 * the phrase contains a literal "last name" and resolved to `lastName` — the
 * candidate's surname written into a field asking for the whole name.
 */
const ENGLISH_FULL_NAME =
  `${NB}(?:first|given|fore)[\\s._-]*(?:names?[\\s._-]*)?(?:and|&|\\/|\\+)[\\s._-]*(?:last|family|sur)[\\s._-]?names?${NA}` +
  `|${NB}names?[\\s._-]*(?:and|&|\\/|\\+)[\\s._-]*sur[\\s._-]?names?${NA}`;

/**
 * Sub-parts and non-person uses of the word "name".
 *
 * `preferred` sits next to `nick` / `display` / `screen` on purpose: a
 * "Preferred name" is what the applicant likes to be called, which is why
 * Workday offers it *alongside* Legal Name and why its placeholder reads "How
 * should we call you?". The profile holds a legal full name, so writing it there
 * is a guess — the field belongs to the LLM path instead.
 *
 * The `(?<!(?:and|or|&|\/|\+)[\s._-]{0,3})` guard keeps this list from eating
 * {@link ENGLISH_FULL_NAME}: in "First and last name" the words "last name" are
 * a *half* of the compound, not a field of their own.
 */
const NON_PERSON_NAME =
  `${NB}(?<!(?:and|or|&|\\/|\\+)[\\s._-]{0,3})` +
  String.raw`(?:first|last|given|family|middle|maiden|birth|sur|second|user|nick|screen|display|preferred|chosen|known|other|former|previous|alias|pen|stage|trade|file|folder|host|domain|brand|product|project|pet|child|band|team|group|club|page|site|event|city|street|countr(?:y|ie)|bank|card|holder|role|job|position|award|course|certificate|degree|skill|tag|label|template|variant|colou?r)[\s._-]*names?` +
  NA +
  // The reversed attribute order: `name_first`, `name[last]`, `nameMiddle`.
  // Without it `name_first` scored 55 for BOTH firstName and lastName's
  // neighbour `fullName`, and the tie downgraded a perfectly clear field.
  `|${NB}${String.raw`names?[\s._-]*(?:first|last|given|family|middle|maiden|suffix|prefix|title)`}${NA}` +
  /**
   * A bare `suffix` / `prefix` anywhere, not just glued to "name". Workday's
   * suffix selector carries `data-automation-id="legalNameSection_socialSuffix"`
   * and sits under a "Legal Name" heading, so `fullName` matched `legal name`
   * twice over and scored 50 — the candidate's full name written into a
   * Jr. / Sr. / Ph.D. dropdown. No form asks for a whole name and calls it a
   * suffix, so the word is a disqualifier on its own.
   */
  `|${NB}${String.raw`(?:suffixe?s?|prefixe?s?)`}${NA}`;

/**
 * The Czech/Slovak half of {@link NON_PERSON_NAME}: a `jméno` that belongs to a
 * login, a file or a former identity rather than to the applicant.
 * `Uživatelské jméno` is the important one — it is a username, and it scored as
 * the candidate's first name on every Czech registration form.
 */
const CZ_NON_PERSON_NAME = `${NB}${String.raw`(?:u[zž]ivatelsk\w*|p[rř]ihla[sš]ovac\w*|obchodn[ií]|rodn[eé]|d[rř][ií]v[eě]j[sš][ií]|p[rř]edchoz[ií]|p[rř]ezd[ií]vk\w*|dom[eé]nov\w*|souborov\w*)[\s._-]*(?:jm[eé]n\w*|p[rř][ií]jmen[ií]\w*|meno|n[aá]z\w*)`}`;

/** `Rodné jméno` / `Rodné příjmení` — a maiden name is not the current one */
const CZ_MAIDEN_NAME = `${NB}${String.raw`rodn[eé][\s._-]*(?:jm[eé]n\w*|p[rř][ií]jmen[ií]\w*|meno|priezvisk\w*)`}`;

export const FIELD_RULES: FieldRule[] = [
  {
    /**
     * `jm[eé]n(?:o|a|u|e|ě|em|y|ech|ům)?` covers the whole declension — `Jméno`,
     * `Vaše jména`, `Jménem`, `Zadejte jméno` — while the soft boundary still
     * refuses `jmenovka` (a name badge), `jmenování` and, thanks to {@link NB},
     * the `jmen` buried inside `příjmení`. `Křestní jméno` / `Krstné meno` are
     * matched as one phrase so the label is consumed whole and earns the
     * dedicated bonus.
     */
    type: 'firstName',
    autocomplete: ['given-name'],
    pattern: new RegExp(
      `${NB}(?:` +
        // Czech / Slovak compounds first — they must swallow both words
        String.raw`k[rř]estn[ií]?\w*[\s._-]*jm[eé]n\w*|krstn[eé]?\w*[\s._-]*meno|` +
        // English, incl. the reversed attribute order `name_first` / `name[first]`
        String.raw`first[\s._-]?names?|given[\s._-]?names?|fore[\s._-]?names?|christian[\s._-]?names?|` +
        String.raw`f[\s._-]?name|fname|names?[\s._-]*first|` +
        // Czech / Slovak, bare
        String.raw`jm[eé]n(?:o|a|u|e|ě|em|y|ech|ům)?|k[rř]estn\w*|krstn\w*|meno` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${CZECH_FULL_NAME}|${ENGLISH_FULL_NAME}|${CZ_NON_PERSON_NAME}|${CZ_MAIDEN_NAME}` +
        // the neighbouring parts of the same name — `Prostřední jméno` contains
        // `jméno` and matched this rule as well as its own
        `|${otherNameParts('middle', 'preferred', 'suffix')}` +
        `|${ownedField(PERSON_OWNER, String.raw`names?|jm[eé]n\w*|meno`).source}` +
        `|${czOwnedField(String.raw`jm[eé]n\w*|meno`).source}` +
        `|${categoryOf(NAME_FIELD).source}`,
      'i',
    ),
  },
  {
    type: 'lastName',
    autocomplete: ['family-name'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`last[\s._-]?names?|family[\s._-]?names?|sur[\s._-]?names?|second[\s._-]?names?|` +
        String.raw`l[\s._-]?name|lname|names?[\s._-]*last|` +
        String.raw`p[rř][ií]jmen[ií]\w*|priezvisk\w*` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${CZECH_FULL_NAME}|${ENGLISH_FULL_NAME}|${CZ_NON_PERSON_NAME}|${CZ_MAIDEN_NAME}` +
        `|${otherNameParts('middle', 'preferred', 'suffix')}` +
        `|${ownedField(PERSON_OWNER, String.raw`names?|p[rř][ií]jmen[ií]\w*|priezvisk\w*`).source}` +
        `|${czOwnedField(String.raw`p[rř][ií]jmen[ií]\w*|priezvisk\w*`).source}` +
        `|${categoryOf(NAME_FIELD).source}`,
      'i',
    ),
  },
  {
    /**
     * `Legal MiddleName` — the field the live run reported as NOT RECOGNISED,
     * sitting between two fields that were. Czech writes it `prostřední jméno`
     * and Slovak `stredné meno`, both of which contain the whole `firstName`
     * stem, so this rule and that one have to disqualify each other explicitly.
     *
     * `middle initial` is included because US forms ask for one letter rather
     * than a name; the filler decides how much of the value fits, not the
     * matcher.
     */
    type: 'middleName',
    autocomplete: ['additional-name'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`middle[\s._-]?names?|middle[\s._-]?initials?|middle[\s._-]?i|` +
        String.raw`m[\s._-]?names?|mname|names?[\s._-]*middle|additional[\s._-]?names?|` +
        String.raw`second[\s._-]?given[\s._-]?names?|` +
        // Czech / Slovak
        String.raw`prost[rř]edn\w*[\s._-]*(?:jm[eé]n\w*|meno)|prost[rř]edn[ií]|` +
        String.raw`druh[eéyý][\s._-]*jm[eé]n\w*|stredn[eé][\s._-]*meno` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${CZECH_FULL_NAME}|${ENGLISH_FULL_NAME}|${CZ_NON_PERSON_NAME}|${CZ_MAIDEN_NAME}` +
        `|${otherNameParts('preferred', 'suffix')}` +
        `|${ownedField(PERSON_OWNER, NAME_FIELD).source}` +
        `|${czOwnedField(String.raw`jm[eé]n\w*|meno`).source}` +
        `|${categoryOf(NAME_FIELD).source}`,
      'i',
    ),
  },
  {
    /**
     * A nickname — "How should we call you?" — offered by every big ATS *next
     * to* Legal Name. It has always been in {@link NON_PERSON_NAME}, i.e. a
     * reason to disqualify `fullName`; the profile now carries the value, so
     * the same phrasings become a rule of their own. The two halves stay
     * consistent: `preferred` remains a `fullName` disqualifier, and what used
     * to fall through to the model is now filled from `preferredName`.
     */
    type: 'preferredName',
    autocomplete: ['nickname'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`(?:preferred|chosen|informal|familiar|usual|common)[\s._-]*(?:first[\s._-]*)?names?|` +
        String.raw`nick[\s._-]?names?|names?[\s._-]*(?:you[\s._-]*)?(?:go|goes)[\s._-]*by|goes[\s._-]*by|` +
        String.raw`known[\s._-]*as|also[\s._-]*known[\s._-]*as|preferred[\s._-]*form[\s._-]*of[\s._-]*address|` +
        String.raw`what[\s._-]*(?:should|shall|do)[\s._-]*we[\s._-]*call[\s._-]*you|` +
        String.raw`how[\s._-]*(?:should|shall|do)[\s._-]*we[\s._-]*(?:call|address)[\s._-]*you|` +
        // Czech / Slovak
        String.raw`p[rř]ezd[ií]vk\w*|p[rř]ezd[ií]v\w*|preferovan\w*[\s._-]*jm[eé]n\w*|` +
        String.raw`jak[\s._-]*v[aá]s[\s._-]*(?:m[aá]me[\s._-]*)?(?:oslovovat|[rř][ií]kat)` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${CZ_MAIDEN_NAME}` +
        // a login handle is not what the applicant likes to be called
        `|${NB}${String.raw`(?:u[zž]ivatelsk\w*|p[rř]ihla[sš]ovac\w*|usern|logins?|screens?|displays?|accounts?|handles?|gamer\w*)`}` +
        `|${otherNameParts('suffix')}` +
        `|${ownedField(PERSON_OWNER, NAME_FIELD).source}` +
        `|${czOwnedField(String.raw`jm[eé]n\w*|meno`).source}` +
        `|${categoryOf(NAME_FIELD).source}`,
      'i',
    ),
  },
  {
    /**
     * `Jr.`, `Sr.`, `III`, `Ph.D.` — Workday calls the dropdown `Suffix` and
     * hangs `legalNameSection_socialSuffix` off it. Czech puts the same idea
     * after the name as a degree ("titul za jménem"), which is why the academic
     * wording is here and not under `about`.
     *
     * The `nameSuffix` value IS one of a fixed list, so this rule deliberately
     * does NOT take {@link categoryOf}: "Suffix type" would be the same field.
     */
    type: 'nameSuffix',
    autocomplete: ['honorific-suffix'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`names?[\s._-]?suffixe?s?|suffixe?s?(?:[\s._-]*names?)?|` +
        String.raw`(?:social|generational|professional|personal)[\s._-]*suffixe?s?|` +
        String.raw`post[\s._-]?nominals?|titles?[\s._-]*after[\s._-]*(?:the[\s._-]*)?names?|` +
        // Czech / Slovak
        String.raw`titul\w*[\s._-]*za[\s._-]*(?:jm[eé]nem|menom)|` +
        String.raw`koncovk\w*[\s._-]*jm[eé]n\w*|p[rř][ií]pon\w*[\s._-]*jm[eé]n\w*` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // a file / domain / phone suffix is not part of a person's name
        `|${NB}${String.raw`(?:files?|domains?|urls?|e[\s._-]?mails?|numbers?|extensions?|soubor\w*|dom[eé]n\w*|telef[oó]n\w*)[\s._-]*(?:suffixe?s?|p[rř][ií]pon\w*|koncovk\w*)`}` +
        `|${ownedField(PERSON_OWNER, String.raw`suffixe?s?`).source}`,
      'i',
    ),
  },
  {
    /**
     * A bare `name` token is the single most dangerous pattern in the dictionary
     * — `Company name`, `Referral name`, `File name`, `Project name` all scored
     * 45 (medium) and got the candidate's full name written into them. The token
     * is kept, because ATS really do use `name="name"` for the applicant, but is
     * guarded by a broad owner/sub-part negative.
     *
     * The compound alternatives (`Name and surname`, `Jméno a příjmení`) come
     * *before* bare `names?` so the match consumes the whole label and earns the
     * dedicated bonus.
     */
    type: 'fullName',
    autocomplete: ['name'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`full[\s._-]?names?|your[\s._-]?names?|legal[\s._-]?names?|complete[\s._-]?names?|whole[\s._-]?names?|` +
        String.raw`candidate[\s._-]?names?|applicant[\s._-]?names?|` +
        String.raw`names?[\s._-]*(?:and|&|\/|\+)[\s._-]*sur[\s._-]?names?|` +
        String.raw`(?:first|given|fore)[\s._-]*(?:names?[\s._-]*)?(?:and|&|\/|\+)[\s._-]*(?:last|family|sur)[\s._-]?names?|` +
        String.raw`names?` +
        `)${NA}|${CZECH_FULL_NAME}`,
      'i',
    ),
    negative: new RegExp(
      `${NON_PERSON_NAME}|${CZ_NON_PERSON_NAME}|${CZ_MAIDEN_NAME}` +
        `|${ownedField(NEARBY_OWNER, String.raw`names?|jm[eé]n\w*|meno`).source}` +
        `|${czOwnedField(String.raw`jm[eé]n\w*|meno|n[aá]zev`).source}` +
        `|${categoryOf(NAME_FIELD).source}` +
        `|${NB}(?:compan(?:y|ies)|organi[sz]ations?|referr?als?|referees?|emergency)${NA}`,
      'i',
    ),
  },
  {
    /**
     * The trailing `\w*` takes every Czech/Slovak inflection at once
     * (`e-mailová`, `e-mailem`, `emailu`), and the last alternative matches an
     * address-shaped *placeholder* (`jan.novak@seznam.cz`) — on Czech forms the
     * placeholder is regularly the only thing that says what the field is.
     * It is worth 15 (30 dedicated), i.e. never enough on its own.
     */
    type: 'email',
    autocomplete: ['email'],
    pattern: new RegExp(
      `${NB}${String.raw`(?:e[\s._-]?mail\w*|mails?|mejl\w*|elektronick\w*[\s._-]*(?:po[sš]t\w*|adres\w*))`}${NA}` +
        String.raw`|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(CONTACT_OWNER, String.raw`e[\s._-]?mails?|mails?`).source}` +
        `|${czOwnedField(String.raw`e[\s._-]?mail\w*|mail\w*`).source}` +
        // `Email Type` (personal / work) is the twin of `Phone Type`
        `|${categoryOf(String.raw`e[\s._-]?mails?|mails?`).source}` +
        // signing the user up for something they did not ask for
        `|${NB}${String.raw`(?:newsletter|subscribe|subscription|marketing|mailing[\s._-]*list|odb[eě]r\w*|odeb[ií]r\w*|novink\w*)`}`,
      'i',
    ),
  },
  {
    /**
     * The old `tel(?!l)[.\s_-]?` matched `hotel`, `telegram` and `Intel`.
     * Soft boundaries make every alternative safe inside longer words, which is
     * what lets the abbreviations (`tel.`, `mob.`, `GSM`) be listed at all.
     * `telegram` / `viber` stay out on purpose: `Telegram` is pinned as a false
     * positive by the regression suite, and a messenger handle is not a number.
     *
     * `Mobile/Alternate Phone` was recognised but never filled: the rule matched
     * the single word "Mobile" and left "Alternate Phone" stranded, so the label
     * was not dedicated and the field stopped at 20. The qualifier chain below
     * swallows any run of "whose phone is this" adjectives — including across a
     * slash, which is how Workday writes it.
     */
    type: 'phone',
    autocomplete: ['tel', 'tel-national'],
    pattern: new RegExp(
      `${NB}(?:` +
        // Czech adjective + noun, matched as one phrase ("Mobilní telefon")
        String.raw`(?:mobiln|pevn|pracovn|osobn|dom[aá]c|soukrom)\w*[\s._-]*(?:telef[oó]n\w*|link[ay])|` +
        String.raw`[cč][ií]sl[oa][\s._-]*(?:telefonu|mobilu)|telef[oó]nn?\w*[\s._-]*[cč][ií]sl\w*|` +
        // "Mobile/Alternate Phone", "Home phone number", "Daytime telephone"
        String.raw`(?:${PHONE_QUALIFIER})(?:[\s._\/-]+(?:${PHONE_QUALIFIER}))*[\s._\/-]*(?:phones?|telephones?|numbers?|lines?)|` +
        // `phoneNumber` / `mobileNumber`: camelCase leaves no separator, so the
        // trailing boundary rejects bare `phone` and the attribute — usually the
        // strongest signal a control has — scored nothing at all.
        String.raw`(?:phones?|telephones?|mobiles?|cell)[\s._-]*numbers?|` +
        String.raw`phones?|telephones?|tel|mobiles?|mobil\w*|cell(?:phone|ular)?|handy|` +
        String.raw`telef[oó]n\w*|whatsapp|gsm|mob|contact[\s._-]*numbers?` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(CONTACT_OWNER, String.raw`phones?|tel\w*|mobil\w*`).source}` +
        `|${czOwnedField(String.raw`telefon\w*|mobil\w*`).source}` +
        // `Phone Type` is a Mobile / Home / Work selector, not a number
        `|${categoryOf(PHONE_FIELD).source}`,
      'i',
    ),
  },
  {
    /**
     * No trailing boundary: `linkedinUrl` and `linkedin.com/in/x` must both
     * match, and the token is distinctive enough that it cannot appear inside
     * an unrelated word. A bare `LI` abbreviation is deliberately absent — two
     * letters would match `li` in dozens of attributes.
     */
    type: 'linkedin',
    autocomplete: [],
    pattern: /linked[\s._-]?in/i,
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(LINK_OWNER, String.raw`linked[\s._-]?in`).source}` +
        `|${czOwnedField(String.raw`linked[\s._-]?in`).source}`,
      'i',
    ),
  },
  {
    type: 'github',
    autocomplete: [],
    pattern: /git[\s._-]?hub/i,
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(LINK_OWNER, String.raw`git[\s._-]?hub`).source}` +
        `|${czOwnedField(String.raw`git[\s._-]?hub`).source}`,
      'i',
    ),
  },
  {
    /**
     * `Vaše webová stránka` matched nothing: the rule knew `osobní web` but not
     * the far commoner `webová stránka`, `webovka` or a bare `web`.
     *
     * A bare `stránky` is `weak` — on its own it means "pages" and turns up in
     * paginators and document counters, so it outlines the field but cannot fill
     * it. `www` is deliberately absent: it appears inside every LinkedIn /
     * GitHub URL placeholder and would tie with those rules on exactly the forms
     * where the placeholder is the only signal.
     */
    type: 'website',
    autocomplete: ['url'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`web[\s._-]?sites?|home[\s._-]?pages?|web[\s._-]?pages?|portfolio\w*|blogs?|` +
        String.raw`(?:personal|own|private)[\s._-]?(?:url|site|web|website|page|homepage)|` +
        String.raw`(?:webov|internetov|osobn|vlastn)\w*[\s._-]*(?:str[aá]nk\w*|web\w*)|webovk\w*|web` +
        `)${NA}`,
      'i',
    ),
    weak: new RegExp(`${NB}${String.raw`str[aá]nk\w*`}${NA}`, 'i'),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(LINK_OWNER, String.raw`web[\s._-]?sites?|urls?|pages?|web|str[aá]nk\w*`).source}` +
        `|${czOwnedField(String.raw`web\w*|str[aá]nk\w*|urls?`).source}`,
      'i',
    ),
  },
  {
    /**
     * The optional `(?:expectations?|požadavky|…)` tail is not redundant with
     * the bare noun: it makes the match swallow the entire label, which earns
     * `DEDICATED_BONUS` and can fill on its own. `Salary expectations` /
     * `Platové očekávání` are the commonest wording of this field and used to
     * score 20 from a label, i.e. were never filled where the label was the only
     * signal.
     *
     * Bare `pay` is not a token — `Pay frequency`, `Payment method` — it is only
     * matched inside a composite.
     */
    type: 'salary',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`(?:salar(?:y|ies)|compensation|wages?|remuneration)(?:[\s._-]*(?:expectations?|requirements?|ranges?|levels?|bands?|rates?))?|` +
        String.raw`(?:expected|desired|required|requested|target|minimum|base|annual|monthly|gross|net)[\s._-]*(?:pay|salar(?:y|ies)|compensation|wages?|rate|income|earnings)|` +
        String.raw`pay[\s._-]*(?:expectations?|requirements?|ranges?|rates?|grades?)|` +
        String.raw`(?:hourly|daily|day|monthly|annual|yearly)[\s._-]*rates?|` +
        // Czech / Slovak, with the same "swallow the whole label" tail
        String.raw`(?:mzdov\w*|mzd\w*|platov\w*|plat[uyem]|plat|odm[eě]n\w*|honor[aá][rř]\w*)(?:[\s._-]*(?:o[cč]ek[aá]v[aá]n\w*|po[zž]adav\w*|p[rř]edstav\w*|rozp[eě]t[ií]|rozsah))?|` +
        String.raw`(?:o[cč]ek[aá]van\w*|po[zž]adovan\w*|nab[ií]zen\w*)[\s._-]*(?:mzd\w*|plat\w*|odm[eě]n\w*)|` +
        String.raw`finan[cč]n[ií][\s._-]*(?:o[cč]ek[aá]v[aá]n\w*|po[zž]adav\w*|p[rř]edstav\w*)|` +
        String.raw`p[rř]edstava[\s._-]*o[\s._-]*(?:plat\w*|mzd\w*|odm[eě]n\w*)|` +
        String.raw`hodinov\w*[\s._-]*sazb\w*` +
        `)${NA}`,
      'i',
    ),
    /** A currency or a bare "rate" hints at money without naming the field */
    weak: new RegExp(`${NB}${String.raw`(?:czk|k[cč]|eur|sazb\w*|rates?|incomes?|p[rř][ií]jem)`}${NA}`, 'i'),
  },
  {
    /**
     * Bare `location` used to score 75 on a job-search filter (`name=location` +
     * `aria-label="Location"`) and got the user's city typed into it. It is now a
     * weak token: it needs a real city signal, or several independent
     * occurrences, to reach the fill threshold. The Czech vocabulary follows the
     * same split rather than being a flat list of synonyms:
     *
     *  strong — `město`, `obec`, `bydliště` name a settlement, and
     *    `preferovaná / současná / trvalá / vaše lokalita | místo` carries the
     *    same "whose location is this?" qualifier that makes English `current
     *    location` strong.
     *  weak — bare `lokalita` is the exact counterpart of bare `location`: it is
     *    what Jobs.cz and Prace.cz call their search filter. Bare `místo` is
     *    weaker still ("place"): `místo narození`, `volné místo`. `pracoviště` /
     *    `působiště` are the employer's site, not the applicant's home town.
     *
     * `místo výkonu práce` is deliberately *not* promoted to strong: on a job ad
     * it is the vacancy's location, and its English mirror (`Work location`) is
     * pinned as a false positive by the regression suite — treating the two
     * differently would re-open that bug for Czech users.
     *
     * `adresa` stays out: it is a street address, there is no `address` field
     * type to hold it, and `E-mailová adresa` would collide with `email`.
     * `kraj` / `region` stay out too — a region is not a city, and the profile
     * has no region to write there.
     */
    type: 'city',
    autocomplete: ['address-level2'],
    pattern: new RegExp(
      // 1. a settlement, named outright — EN / CS / SK
      `${NB}${String.raw`(?:cit(?:y|ies)[\s._\/-]*towns?|towns?[\s._\/-]*cit(?:y|ies)|cit(?:y|ies)|towns?|home[\s._-]?towns?|municipalit(?:y|ies)|m[eě]st[oaeěu]|obec|obce|obci|bydli[sš]t[eě]\w*|bydlisk\w*)`}${NA}` +
        // 2. "<whose> location" — the qualifier is what makes it the applicant's
        `|${NB}${String.raw`(?:current|currently|home|your|my|own|candidate|applicant|residence|residential|residing|permanent|mailing|primary|preferred|desired|nearest|actual|physical|based)[\s._-]*(?:locations?|cit(?:y|ies)|town)`}${NA}` +
        // 3. "Location (City)" — an explicit city gloss on an ambiguous word
        `|${NB}${String.raw`locations?[\s._-]*[(:]?[\s._-]*(?:cit(?:y|ies)|town)`}${NA}` +
        // 4. Czech / Slovak "<whose> lokalita | místo | bydliště"
        `|${NB}${String.raw`(?:preferovan\w*|po[zž]adovan\w*|sou[cč]asn\w*|aktu[aá]ln\w*|nyn[eě]j[sš]\w*|trval\w*|domovsk\w*|vlastn\w*|va[sš]\w*|hledan\w*|c[ií]lov\w*)[\s._-]*(?:lokalit\w*|m[ií]st[oaeě]|bydli[sš]t[eě]\w*|bydlisk\w*|m[eě]st[oaeě])`}${NA}` +
        // 5. "Where do you live?" / "Kde bydlíte?"
        `|${NB}${String.raw`where[\s._-]*(?:do[\s._-]*you[\s._-]*(?:live|reside)|are[\s._-]*you[\s._-]*(?:based|located|living))\w*`}` +
        `|${NB}${String.raw`kde[\s._-]*(?:bydl[ií]\w*|[zž]ijete)`}` +
        // 6. "City of residence" / "Místo bydliště"
        `|${NB}${String.raw`(?:places?|cit(?:y|ies)|town)[\s._-]*of[\s._-]*residence`}${NA}` +
        `|${NB}${String.raw`m[ií]sto[\s._-]*bydli[sš]t[eě]\w*`}`,
      'i',
    ),
    weak: new RegExp(
      `${NB}${String.raw`(?:locations?|lokalit\w*|m[ií]st[oaeě]|pracovi[sš]t[eě]|p[uů]sobi[sš]t[eě]|poloh[ay])`}${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(String.raw`jobs?|office|work\w*|positions?|roles?|vacanc\w*|interviews?|meetings?|trainings?|search|filter|remote|onsite|hybrid|pracovn[ií]\w*|zam[eě]stnavatel\w*|${ORG}`, String.raw`cit(?:y|ies)|locations?|lokalit\w*|m[ií]st[oaeě]|m[eě]st[oaeě]`).source}` +
        `|${czOwnedField(String.raw`lokalit\w*|m[ií]st[oaeě]|m[eě]st[oaeě]`).source}` +
        // an invoice address is not a home town
        `|${NB}${String.raw`(?:billing|shipping|delivery|invoice|fakturac\w*|dodac\w*)`}` +
        // a place of birth is not a place of residence
        `|${NB}${String.raw`(?:places?|cit(?:y|ies)|town)[\s._-]*of[\s._-]*birth`}${NA}` +
        `|${NB}${String.raw`m[ií]sto[\s._-]*narozen[ií]`}|${NB}${String.raw`rodn[eé][\s._-]*m[eě]st\w*`}`,
      'i',
    ),
  },
  {
    /**
     * The street line. Bare `address` / `adresa` is `weak`, for exactly the
     * reason bare `location` is: on its own the word belongs to an e-mail
     * address, an IP address, a web address or a billing address at least as
     * often as to a street. Anything that says *whose* address it is, or that
     * numbers the line, is strong — which covers every ATS spelling
     * (`Address Line 1`, `Street Address`, `Home address`, `Ulice`).
     *
     * The trailing `(?:1|one)` is not decoration: without it this rule also
     * matched `Address Line 2`, the field immediately below it on the same
     * form, and the two lines are not interchangeable.
     */
    type: 'addressLine1',
    autocomplete: ['address-line1', 'street-address'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`address(?:[\s._-]*lines?)?[\s._-]*(?:1|one)|` +
        String.raw`street[\s._-]*address(?:[\s._-]*(?:lines?[\s._-]*)?(?:1|one))?|` +
        String.raw`(?:home|permanent|residential|residence|current|mailing|postal|personal|private|your|my|candidate|applicant)[\s._-]*address(?:[\s._-]*(?:lines?[\s._-]*)?(?:1|one))?|` +
        String.raw`streets?(?:[\s._-]*(?:names?|and[\s._-]*numbers?))?|house[\s._-]*(?:numbers?|no)|` +
        // Czech / Slovak
        String.raw`ulic[aeiy]\w*(?:[\s._-]*(?:a[\s._-]*[cč][ií]sl\w*|a[\s._-]*[cč]\.?[\s._-]*p\.?)(?:[\s._-]*popisn\w*)?)?|` +
        String.raw`(?:trval\w*|sou[cč]asn\w*|kontaktn[ií]|dom[aá]c[ií]|va[sš]\w*|p[rř]echodn\w*|bydli[sš]t[eě])[\s._-]*adres\w*|` +
        String.raw`adres\w*[\s._-]*(?:[rř][aá]d(?:ek|ku)[\s._-]*)?(?:1|one)|` +
        String.raw`[cč][ií]slo[\s._-]*popisn[eé]` +
        `)${NA}`,
      'i',
    ),
    weak: new RegExp(`${NB}${String.raw`(?:address(?:es)?|adres\w*)`}${NA}`, 'i'),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // an e-mail / IP / web address, or an invoice one, is not where you live
        `|${NB}${String.raw`(?:e[\s._-]?mail\w*|mejl\w*)`}` +
        `|${NB}${String.raw`(?:ip|web\w*|internet\w*|urls?|macs?|servers?|wallets?|billing|shipping|delivery|invoice|fakturac\w*|dodac\w*)[\s._-]*(?:address(?:es)?|adres\w*)`}${NA}` +
        // the second line is a different field
        `|${NB}${String.raw`(?:address|adres\w*)[\s._-]*(?:lines?[\s._-]*|[rř][aá]d(?:ek|ku)[\s._-]*)?(?:2|two|3|three)`}${NA}` +
        `|${NB}${String.raw`(?:apartments?|apt|suites?|byt[uy]?|patr[oa])`}${NA}` +
        `|${ownedField(`${LINK_OWNER}|${THIRD_PARTY}`, String.raw`address(?:es)?|adres\w*|streets?|ulic\w*`).source}` +
        `|${czOwnedField(String.raw`adres\w*|ulic\w*`).source}` +
        `|${categoryOf(String.raw`address(?:es)?|adres\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * The overflow line — apartment, floor, "Apartment, suite, etc.". Distinct
     * from `addressLine1` only by the `2` or by the apartment vocabulary, so
     * both halves are enumerated rather than sharing a stem.
     */
    type: 'addressLine2',
    autocomplete: ['address-line2'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`address(?:[\s._-]*lines?)?[\s._-]*(?:2|two)|street[\s._-]*address[\s._-]*(?:lines?[\s._-]*)?(?:2|two)|` +
        String.raw`(?:additional|second|secondary|further|extra)[\s._-]*address(?:[\s._-]*(?:lines?|info\w*|details?))?|` +
        String.raw`apartments?(?:[\s._\/,-]*suites?)?(?:[\s._\/,-]*etc)?|apt|suites?|flats?|` +
        String.raw`(?:apartment|suite|unit|floor|building|room)[\s._-]*(?:numbers?|no)|` +
        // Czech / Slovak
        String.raw`adres\w*[\s._-]*(?:[rř][aá]d(?:ek|ku)[\s._-]*)?(?:2|two)|` +
        String.raw`(?:dopl[nň]uj[ií]c\w*|dopl[nň]kov\w*|druh\w*|dal[sš][ií])[\s._-]*adres\w*|dopln[eě]k[\s._-]*adres\w*|` +
        String.raw`[cč][ií]slo[\s._-]*(?:bytu|orienta[cč]n[ií])|byt[\s._\/-]*patro` +
        `)${NA}`,
      'i',
    ),
    weak: new RegExp(`${NB}${String.raw`(?:units?|floors?|patr[oa]|byt[uy]?)`}${NA}`, 'i'),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${NB}${String.raw`(?:e[\s._-]?mail\w*|mejl\w*)`}` +
        `|${NB}${String.raw`(?:ip|web\w*|internet\w*|urls?|macs?|servers?|billing|shipping|delivery|invoice|fakturac\w*|dodac\w*)[\s._-]*(?:address(?:es)?|adres\w*)`}${NA}` +
        // "Business unit" / "Sales unit" is an org chart, not a flat
        `|${NB}${String.raw`(?:business|organi[sz]ation\w*|sales|teams?|measure\w*|price|pricing)[\s._-]*units?`}${NA}` +
        `|${ownedField(`${LINK_OWNER}|${THIRD_PARTY}`, String.raw`address(?:es)?|adres\w*`).source}` +
        `|${czOwnedField(String.raw`adres\w*`).source}` +
        `|${categoryOf(String.raw`address(?:es)?|adres\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * `Zip/ Postal Code` is one field with two names, and the slash is a
     * separator the ordinary `[\s._-]` class does not carry — matched by halves
     * the label was not dedicated and the field stopped short of the threshold.
     *
     * A postcode is digits, and so is a phone number, so the negatives name
     * every other kind of "code" a form asks for: dial codes, country codes,
     * verification codes, promo codes.
     */
    type: 'postalCode',
    autocomplete: ['postal-code'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`zip(?:[\s._\/-]*codes?)?(?:[\s._\/-]*postal[\s._\/-]*codes?)?|` +
        String.raw`postal[\s._\/-]*(?:codes?|indexe?s?)|post[\s._-]?codes?|` +
        String.raw`(?:postal|zip)[\s._\/-]*\/?[\s._\/-]*(?:postal|zip)[\s._\/-]*codes?|` +
        // Czech / Slovak
        String.raw`ps[cč]|po[sš]tovn\w*[\s._-]*(?:sm[eě]rovac\w*[\s._-]*)?[cč][ií]sl\w*|` +
        String.raw`sm[eě]rovac\w*[\s._-]*[cč][ií]sl\w*` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${NB}${String.raw`(?:countr(?:y|ies)|dial|dialling|calling|area|phones?|tel\w*|discount|promo|coupon|voucher|access|security|verification|otp|sms|auth\w*|referr?als?)[\s._-]*codes?`}${NA}` +
        `|${NB}${String.raw`(?:files?|archives?|soubor\w*|folders?)`}${NA}` +
        `|${ownedField(`${LINK_OWNER}|${THIRD_PARTY}`, String.raw`zip|postal[\s._-]*codes?|post[\s._-]?codes?|ps[cč]`).source}`,
      'i',
    ),
  },
  {
    /**
     * The administrative region below a country. `State / Province / County` is
     * how Workday spells it, and all three words have to be swallowed by one
     * alternative for the label to name the field rather than mention it.
     *
     * Bare `region` / `oblast` is `weak`: on a job board it is a search facet.
     * Czech `kraj` is strong but written `kraj(?:e|i|…)?` rather than `kraj\w*`,
     * because `krajina` is the *Slovak word for country* and the greedy stem
     * would have handed every Slovak country selector to this rule.
     */
    type: 'state',
    autocomplete: ['address-level1'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`states?(?:[\s._\/-]*(?:or[\s._\/-]*)?provinces?)?(?:[\s._\/-]*count(?:y|ies))?(?:[\s._\/-]*(?:regions?|territor(?:y|ies)))?|` +
        String.raw`provinces?(?:[\s._\/-]*(?:states?|territor(?:y|ies)|count(?:y|ies)))?|` +
        String.raw`count(?:y|ies)|territor(?:y|ies)|prefectures?|` +
        String.raw`(?:federal|us|home|your)[\s._-]*states?|` +
        // Czech / Slovak
        String.raw`kraj(?:e|i|em|[uů]|[ií]ch|[uů]m|sk[yý]\w*)?|okres\w*|` +
        String.raw`samospr[aá]vn\w*[\s._-]*kraj\w*|vy[sš][sš][ií][\s._-]*[uú]zemn\w*` +
        `)${NA}`,
      'i',
    ),
    weak: new RegExp(`${NB}${String.raw`(?:regions?|oblast\w*|[uú]zem\w*)`}${NA}`, 'i'),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // "Marital status", "Real estate", "United States" the country
        `|${NB}${String.raw`(?:marital|civil|employment|order|payment|relationship|rodinn\w*)[\s._-]*(?:status|states?)`}${NA}` +
        `|${NB}${String.raw`(?:real[\s._-]*estates?|united[\s._-]*states|usa)`}${NA}` +
        // A narrower owner list than {@link ORG} on purpose: ORG counts
        // `country` as an owner, and Workday's state selector is called
        // `addressSection_countryRegion` — ORG disqualified this rule on
        // precisely the field it exists for, leaving the live form's
        // "State / Province / County" unmatched.
        `|${ownedField(
          String.raw`jobs?|office|work\w*|positions?|roles?|vacanc\w*|interviews?|search|filter|remote|onsite|hybrid|compan(?:y|ies)|employers?|organi[sz]ations?|schools?|universit\w*|spole[cč]nost\w*|firm\w*|zam[eě]stnavatel\w*|pracovn[ií]\w*`,
          String.raw`states?|provinces?|count(?:y|ies)|regions?|kraj\w*|okres\w*|oblast\w*`,
        ).source}` +
        `|${czOwnedField(String.raw`kraj\w*|okres\w*|regions?|oblast\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * `Country`, `Country/Region`, `Země`, `Stát`.
     *
     * The Czech `stát` and the English `state` are the same four letters plus
     * one, and they mean *opposite levels* of the hierarchy — so `st[aá]t` is
     * closed with {@link NA} and never matches "state", while the state rule's
     * `states?` never matches the diacritics-folded "stat". That one boundary is
     * the whole separation between the two rules on a bilingual form.
     *
     * Workday's state selector is called `addressSection_countryRegion`, i.e.
     * its *attribute* says "country" while its label says "State / Province /
     * County" — hence the province / county disqualifier, without which the two
     * rules tie on that field and neither is filled.
     */
    type: 'country',
    autocomplete: ['country', 'country-name'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`countr(?:y|ies)(?:[\s._\/-]*regions?)?(?:[\s._-]*of[\s._-]*residence)?|` +
        String.raw`(?:home|current|residence|residing|permanent|mailing|your|my)[\s._-]*countr(?:y|ies)|` +
        String.raw`nations?|` +
        // Czech / Slovak
        String.raw`zem[eě](?:i|[ií]ch|[ií]m|[ií])?|krajin\w*|st[aá]t(?:u|em|y|[uů]|ech|[uů]m)?` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // a state / province selector, not a country one
        `|${NB}${String.raw`(?:provinces?|count(?:y|ies)|prefectures?|okres\w*|kraj(?:e|i|em|[uů]|[ií]ch|[uů]m|sk[yý]\w*)?)`}${NA}` +
        `|${NB}${String.raw`states?[\s._\/-]*(?:or[\s._\/-]*)?provinces?`}${NA}` +
        // citizenship is a different question, and has its own rule
        `|${NB}${String.raw`(?:citizenship|nationalit\w*|ob[cč]anstv\w*|ob[cč]ianstv\w*|p[rř][ií]slu[sš]nos\w*|n[aá]rodnos\w*)`}` +
        // "Country code" / "Country phone code" is a dial prefix
        `|${NB}${String.raw`(?:countr(?:y|ies)|zem[eě]\w*)[\s._-]*(?:\w+[\s._-]*){0,1}(?:codes?|k[oó]d\w*|prefixe?s?|predvolb\w*)`}${NA}` +
        `|${NB}${String.raw`(?:countr(?:y|ies)|zem[eě]\w*)[\s._-]*of[\s._-]*(?:birth|origin)`}${NA}` +
        `|${NB}${String.raw`(?:zem[eě]\w*|st[aá]t\w*)[\s._-]*narozen[ií]`}` +
        `|${ownedField(ORG, String.raw`countr(?:y|ies)|zem[eě]\w*|st[aá]t\w*`).source}` +
        `|${czOwnedField(String.raw`zem[eě]\w*|st[aá]t\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * `motivat` alone matched "What motivates you about this role?" and pasted
     * the whole cover letter into an open question. The stem now has to be part
     * of an actual letter noun; bare "motivation" — and its Czech twin
     * `motivace` — is weak for the same reason.
     *
     * The Czech stems optionally swallow the noun they qualify, so `Motivační
     * dopis` matches as one phrase instead of leaving "dopis" behind. Nothing
     * new matches; the point is that consuming the *whole* label is what lets
     * `Přiložte motivační dopis` count as a dedicated label and reach the fill
     * threshold where the label is the only signal.
     *
     * `Message to Hiring Manager` is SmartRecruiters' name for the same box.
     */
    type: 'coverLetter',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`cover(?:ing)?[\s._-]?(?:letters?|notes?)|` +
        String.raw`(?:motivation(?:al)?|application|introductory|presentation)[\s._-]?letters?|` +
        String.raw`letters?[\s._-]?of[\s._-]?(?:motivation|interest|application|introduction)|` +
        String.raw`messages?[\s._-]*(?:to|for)[\s._-]*(?:the[\s._-]*)?(?:hiring[\s._-]*)?(?:managers?|teams?|recruiters?|employers?|compan\w*|us)|` +
        // Czech / Slovak, optionally swallowing the noun they qualify
        String.raw`motiva[cč]n[iíyý]\w*(?:[\s._-]*(?:dopis\w*|list\w*|text\w*|slov\w*))?|` +
        String.raw`pr[uů]vodn[ií]\w*(?:[\s._-]*(?:dopis\w*|text\w*|slov\w*))?|` +
        String.raw`sprievodn\w*(?:[\s._-]*list\w*)?|doprovodn\w*[\s._-]*dopis\w*|` +
        String.raw`zpr[aá]v[au][\s._-]*pro[\s._-]*(?:zam[eě]stnavatel\w*|person[aá]list\w*|n[aá]bor\w*|firmu)` +
        `)${NA}`,
      'i',
    ),
    // No negative needed: "What motivates you about this role?" only reaches the
    // weak tier (19 points), so the open-question detector picks it up instead.
    weak: new RegExp(`${NB}${String.raw`(?:motivations?|motivac\w*|dopis\w*)`}${NA}`, 'i'),
  },
  {
    /**
     * `Kdy můžete nastoupit?` — the commonest Czech phrasing of this field —
     * matched nothing: the stem is `nastoup-`, not `nástup-`, so the question
     * fell through to the open-question heuristic and was sent to the model as
     * an essay prompt.
     *
     * The English mirror ("When can you start?") had the same hole for a
     * different reason: `start` only counted next to `date`. It is matched as a
     * whole phrase rather than by adding a bare `start` token — that appears in
     * "Project start", "Start typing to search" and every wizard's button label.
     */
    type: 'availability',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`availab\w*|` +
        String.raw`notice[\s._-]?periods?|periods?[\s._-]?of[\s._-]?notice|` +
        String.raw`start(?:ing)?[\s._-]?dates?|dates?[\s._-]?of[\s._-]?(?:start|joining|entry)|` +
        // the optional `date` tail keeps "Earliest start date" one whole match
        String.raw`(?:preferred|desired|possible|earliest|expected|proposed)[\s._-]*start(?:ing)?(?:[\s._-]*dates?)?|` +
        String.raw`earliest[\s._-]*(?:available|availability|possible|entry|joining)\w*(?:[\s._-]*dates?)?|` +
        String.raw`when[\s._-]*(?:can|could|would|will|are)[\s._-]*you[\s._-]*(?:be[\s._-]*able[\s._-]*to[\s._-]*)?(?:start|join|begin|commence)\w*|` +
        String.raw`how[\s._-]*soon[\s._-]*(?:can|could)[\s._-]*you[\s._-]*(?:start|join|begin)\w*|` +
        // Czech / Slovak. `nastoup-` (CZ) and `nastúp-` (SK) are BOTH needed —
        // they differ by one vowel, and a miss falls silently through to the
        // open-question path.
        String.raw`n[aá]stup\w*|nastoup\w*|nast[uú]p\w*|dostupnost\w*|dostupn\w*[\s._-]*od|` +
        String.raw`(?:mo[zž]n[yý]|preferovan\w*|po[zž]adovan\w*)[\s._-]*term[ií]n\w*(?:[\s._-]*n[aá]stupu)?|` +
        String.raw`term[ií]n\w*[\s._-]*n[aá]stupu|datum[\s._-]*n[aá]stupu|` +
        String.raw`v[yý]pov[eě]dn[ií][\s._-]*(?:lh[uů]t\w*|dob\w*)|v[yý]poved\w*[\s._-]*lehot\w*|` +
        String.raw`k[\s._-]*dispozici(?:[\s._-]*od)?` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${NB}${String.raw`(?:projects?|contracts?|education|study|studies|courses?|schools?|assignments?|internships?|previous|employment)[\s._-]*(?:\w+[\s._-]*){0,1}(?:start|end)?[\s._-]*dates?`}${NA}` +
        `|${NB}${String.raw`end[\s._-]?dates?`}${NA}` +
        String.raw`|dates?[\s._-]*of[\s._-]*birth|datum[\s._-]*narozen[ií]|birth[\s._-]?dates?` +
        // a document's validity is not the candidate's start date
        `|${NB}${String.raw`(?:expir\w*|issue[\s._-]*dates?|platnost\w*)`}` +
        // "Available positions" / "Volné místo" is the vacancy list, not a date
        `|${NB}${String.raw`(?:available|dostupn\w*|voln\w*)[\s._-]*(?:positions?|jobs?|roles?|vacanc\w*|pozic\w*|m[ií]st\w*)`}` +
        // interview scheduling is a different question from the notice period
        `|${NB}${String.raw`(?:interviews?|pohovor\w*)[\s._-]*(?:dates?|term[ií]n\w*|availab\w*)`}`,
      'i',
    ),
  },
  {
    /**
     * Czechia-specific: `modrá karta` (EU Blue Card) and `zaměstnanecká karta`
     * (employee card) are the two permits a foreign applicant actually holds,
     * and both are asked for by name on Czech application forms. The `credit /
     * debit / platební` negative is what keeps `karta` from meaning a bank card.
     *
     * `nationality` / `citizenship` / `občanství` / `státní příslušnost` used to
     * live here, because there was nowhere else to put them: the profile held a
     * work-permit status and nothing else, so a "Nationality" field was filled
     * with it. They now have a rule and a profile field of their own and have
     * moved there wholesale — leaving both here would be a permanent tie, and a
     * tie is a field left empty.
     *
     * `visas?[\s._-]*type` deliberately survives {@link categoryOf}: the *type*
     * of visa is exactly what the profile stores, so this rule does not take
     * that negative at all.
     */
    type: 'workPermit',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`work(?:ing)?[\s._-]?permits?|work[\s._-]?visas?|visas?(?:[\s._-]*(?:status|type|sponsorship|requirements?))?|` +
        String.raw`residence[\s._-]?permits?|residency(?:[\s._-]*status)?|` +
        String.raw`(?:work|employment)[\s._-]*(?:authori[sz]\w*|eligibilit\w*)|` +
        String.raw`(?:legally[\s._-]*)?authori[sz]ed[\s._-]*to[\s._-]*work|eligib\w*[\s._-]*to[\s._-]*work|` +
        String.raw`right[\s._-]*to[\s._-]*work|(?:require[\s._-]*)?sponsorship|` +
        // Czech / Slovak
        String.raw`pracovn[ií][\s._-]*povolen[ií]|povolen[ií][\s._-]*(?:k[\s._-]*pob\w*|pracovat)|` +
        String.raw`modr[aá][\s._-]*kart\w*|zam[eě]stnaneck[aá][\s._-]*kart\w*|` +
        String.raw`pobytov\w*[\s._-]*opr[aá]vn[eě]n\w*|trval[yý][\s._-]*pobyt|v[ií]z[au]m?|` +
        String.raw`opr[aá]vnenie[\s._-]*na[\s._-]*pr[aá]cu` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${NB}${String.raw`(?:credit|debit|payment|billing|platebn\w*|kreditn\w*|debetn\w*)`}${NA}`,
      'i',
    ),
  },
  {
    /**
     * Split out of `workPermit`, where these words used to live for want of a
     * profile field to fill from. `Státní příslušnost` is the phrasing every
     * Czech form uses; `Country of citizenship` is Workday's.
     */
    type: 'nationality',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`nationalit(?:y|ies)|citizenships?|citizens?|` +
        String.raw`countr(?:y|ies)[\s._-]*of[\s._-]*(?:citizenship|nationality)|` +
        // Czech / Slovak
        String.raw`st[aá]tn[ií][\s._-]*p[rř][ií]slu[sš]nos\w*|[sš]t[aá]tn[au][\s._-]*pr[ií]slu[sš]nos\w*|` +
        String.raw`ob[cč]anstv\w*|ob[cč]ianstv\w*|n[aá]rodnos\w*|p[rř][ií]slu[sš]nos\w*` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        `|${ownedField(PERSON_OWNER, String.raw`nationalit\w*|citizenships?|ob[cč]anstv\w*|n[aá]rodnos\w*`).source}` +
        // a "senior citizen" / EEO diversity question is not a nationality field
        `|${NB}${String.raw`(?:senior|elderly|second|dual|corporate)[\s._-]*citizen\w*`}${NA}`,
      'i',
    ),
  },
  {
    /**
     * A date of birth and a start date are both dates, and the two mistakes are
     * not symmetrical: a birth date in "When can you start?" is absurd and
     * visible, while a start date in "Date of birth" is silent and wrong. Both
     * rules therefore name the other in their negatives — `availability` already
     * did, and this one refuses every *other* birth field there is, because
     * `Place of birth` is a city and `Rodné číslo` is a national ID number.
     */
    type: 'dateOfBirth',
    autocomplete: ['bday'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`dates?[\s._-]*of[\s._-]*birth|birth[\s._-]?dates?|birth[\s._-]?days?|dob|` +
        String.raw`dates?[\s._-]*born|born[\s._-]*on|year[\s._-]*of[\s._-]*birth|` +
        // Czech / Slovak
        String.raw`datum[\s._-]*narozen[ií]\w*|d[aá]tum[\s._-]*narodenia|` +
        String.raw`den[\s._-]*narozen[ií]\w*|narozen[\s._-]*dne|datum[\s._-]*nar` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // a birth *place*, a birth *number* or a birth *certificate* is not a date
        `|${NB}${String.raw`(?:places?|cit(?:y|ies)|towns?|countr(?:y|ies)|hospitals?)[\s._-]*of[\s._-]*birth`}${NA}` +
        `|${NB}${String.raw`birth[\s._-]*(?:places?|cit(?:y|ies)|countr(?:y|ies)|certificates?|names?|numbers?)`}${NA}` +
        `|${NB}${String.raw`m[ií]sto[\s._-]*narozen[ií]|rodn[eé][\s._-]*[cč][ií]sl\w*|rodn[eé][\s._-]*jm[eé]n\w*`}` +
        `|${NB}${String.raw`(?:child|children|kids?|dependants?|dependents?|d[ií]t[eě]|d[eě]t\w*)`}${NA}` +
        `|${ownedField(PERSON_OWNER, String.raw`birth\w*|dob|narozen\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * A driving licence, and — like `workPermit` and `education` — a rule whose
     * *value is a category*: "Driving licence category B" is the answer, not a
     * selector for one, so {@link categoryOf} deliberately does not apply.
     *
     * `ŘP` is two letters and would be reckless without the soft boundaries;
     * with them it has to stand as a whole token, which is how Czech forms
     * abbreviate it.
     */
    type: 'drivingLicence',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`driv(?:ing|ers?|er's)[\s._-]*licen[cs]es?(?:[\s._-]*(?:categor(?:y|ies)|class(?:es)?|types?|numbers?|groups?))?|` +
        String.raw`driv(?:ing|ers?|er's)[\s._-]*(?:permits?|qualifications?)|` +
        String.raw`licen[cs]es?[\s._-]*to[\s._-]*drive|full[\s._-]*driving[\s._-]*licen[cs]es?|` +
        // Czech / Slovak
        String.raw`[rř]idi[cč]sk\w*[\s._-]*(?:pr[uů]kaz\w*|opr[aá]vn[eě]n\w*)|[rř]idi[cč][aá]k\w*|` +
        String.raw`vodi[cč]sk\w*[\s._-]*(?:preukaz\w*|opr[aá]vnen\w*)|` +
        String.raw`skupin\w*[\s._-]*[rř]idi[cč]sk\w*[\s._-]*pr[uů]kaz\w*|[rř]p` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // a software licence, and a licence *plate*, are not a driving licence
        `|${NB}${String.raw`(?:software|open[\s._-]*source|mit|apache|gpl|business|trade|professional|medical|plates?|licenc[ií]|spz)`}${NA}`,
      'i',
    ),
  },
  {
    /**
     * "Please list your highest level of education achieved" — a `<select>` on
     * the live form, and 51 characters of which only "highest level of education
     * achieved" carries meaning. The optional `achieved|attained|completed` tail
     * exists so that the match swallows the participle too; leaving it stranded
     * costs `DEDICATED_BONUS` and drops the field from 35 to 20.
     *
     * `school` and `university` are absent on purpose: the profile holds a
     * *level*, and "School name" wants an institution. The date negative is what
     * keeps this rule off "Education end date", already pinned as a false
     * positive for `availability`.
     */
    type: 'education',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`(?:highest[\s._-]*)?(?:levels?[\s._-]*of[\s._-]*)?educations?(?:[\s._-]*(?:levels?|achieved|attained|completed|obtained|backgrounds?))?|` +
        String.raw`highest[\s._-]*(?:levels?[\s._-]*of[\s._-]*)?(?:degrees?|qualifications?)(?:[\s._-]*(?:achieved|attained|completed|obtained))?|` +
        String.raw`(?:academic|educational)[\s._-]*(?:levels?|backgrounds?|qualifications?|attainment|degrees?)|` +
        String.raw`degrees?(?:[\s._-]*levels?)?|qualifications?|` +
        // Czech / Slovak
        String.raw`(?:nejvy[sš][sš][ií][\s._-]*)?(?:dosa[zž]en[eé][\s._-]*)?vzd[eě]l[aá]n[ií]\w*|` +
        String.raw`(?:stupe[nň]|[uú]rove[nň])[\s._-]*vzd[eě]l[aá]n[ií]\w*|` +
        String.raw`(?:dosiahnut[eé][\s._-]*)?vzdelani\w*|najvy[sš][sš]ie[\s._-]*vzdelanie` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // "Education end date" / "Rok ukončení" is a date, not a level
        `|${NB}${String.raw`(?:starts?|ends?|graduations?|completions?|from|to|award)[\s._-]*dates?`}${NA}` +
        `|${NB}${String.raw`dates?[\s._-]*(?:of|from|to)`}${NA}` +
        `|${NB}${String.raw`(?:datum|rok[uy]?|obdob[ií])[\s._-]*(?:\w+[\s._-]*){0,1}(?:ukon[cč]en\w*|dokon[cč]en\w*|studia|absolv\w*)`}` +
        // an institution, a field of study or a document about them
        `|${NB}${String.raw`(?:schools?|universit\w*|colleges?|institut\w*|[sš]kol\w*|univerzit\w*)[\s._-]*(?:names?|jm[eé]n\w*|n[aá]z\w*|address\w*|adres\w*)`}${NA}` +
        `|${NB}${String.raw`(?:fields?[\s._-]*of[\s._-]*study|majors?|obor\w*[\s._-]*studia|certificates?|diplomas?|transcripts?)`}${NA}` +
        `|${czOwnedField(String.raw`vzd[eě]l[aá]n[ií]\w*|[uú]rove[nň]`).source}`,
      'i',
    ),
  },
  {
    /**
     * The language the applicant wants to be dealt with in — a `<select>` on
     * Workday, a radio pair on Czech boards.
     *
     * The negatives are the whole rule: `Language skills`, `Jazykové znalosti`
     * and `Programming language` all contain the word and none of them wants a
     * single preferred language written into it.
     */
    type: 'preferredLanguage',
    autocomplete: ['language'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`(?:preferred|primary|native|main|first|correspondence|communication|contact|interview|application|written|spoken)[\s._-]*languages?|` +
        String.raw`languages?(?:[\s._-]*(?:preferences?|of[\s._-]*(?:correspondence|communication|choice|instruction)|settings?))?|` +
        String.raw`in[\s._-]*which[\s._-]*language|` +
        // Czech / Slovak
        String.raw`(?:preferovan\w*|prim[aá]rn\w*|hlavn\w*|komunika[cč]n\w*|mate[rř]sk\w*|rodn\w*|materinsk\w*)[\s._-]*jazyk\w*|` +
        String.raw`jazyk\w*(?:[\s._-]*(?:preferenc\w*|komunikace|nastaven\w*))?|jazykov\w*[\s._-]*preferenc\w*|` +
        String.raw`v[\s._-]*jak[eé]m[\s._-]*jazyce` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // a skill, not a preference
        `|${NB}${String.raw`(?:languages?|jazyk\w*|jazykov\w*)[\s._-]*(?:skills?|levels?|proficienc\w*|tests?|certificat\w*|znalost\w*|dovednost\w*|[uú]rov\w*|zkou[sš]k\w*|schopnost\w*|vybaven\w*)`}${NA}` +
        `|${NB}${String.raw`(?:skills?|levels?|proficienc\w*|fluenc\w*|command|znalost\w*|[uú]rove[nň]\w*)[\s._-]*(?:in[\s._-]*|of[\s._-]*)?(?:languages?|jazyk\w*)`}${NA}` +
        // not a human language at all
        `|${NB}${String.raw`(?:programming|coding|scripting|markup|query|programovac\w*|k[oó]dovac\w*)`}` +
        `|${NB}${String.raw`(?:sign|body|foreign|second|third|other|ciz\w*|znakov\w*)[\s._-]*languages?`}${NA}`,
      'i',
    ),
  },
  {
    /**
     * The applicant's *current* job title. Bare `title` / `position` / `role` /
     * `pozice` is `weak`, because on an application form those words belong to
     * the vacancy at least as often as to the candidate — "Position applied
     * for", "Název pozice", "Job location". Only a possessive qualifier, or the
     * compound `job title`, is strong.
     */
    type: 'currentTitle',
    autocomplete: ['organization-title'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`(?:current|currently|present|latest|most[\s._-]*recent|existing)[\s._-]*(?:job[\s._-]*)?(?:titles?|positions?|roles?|jobs?|occupations?|functions?)|` +
        String.raw`(?:job|position|role|occupation|work|professional|business)[\s._-]*titles?|` +
        String.raw`titles?[\s._-]*(?:at[\s._-]*)?(?:your[\s._-]*)?(?:current|present)[\s._-]*(?:employer|compan(?:y|ies)|jobs?|roles?)|` +
        String.raw`what[\s._-]*is[\s._-]*your[\s._-]*(?:current[\s._-]*)?(?:job[\s._-]*)?titles?|` +
        // Czech / Slovak
        // `zaměstnání` is deliberately absent: "Současné zaměstnání" is claimed
        // by `currentEmployer`, and listing it in both rules made the two tie —
        // which downgrades to `low` and fills neither.
        String.raw`(?:sou[cč]asn\w*|aktu[aá]ln\w*|nyn[eě]j[sš]\w*|st[aá]vaj[ií]c\w*|posledn[ií]|momenta\w*)[\s._-]*(?:pozic\w*|funkc\w*|profes\w*)|` +
        String.raw`pracovn[ií][\s._-]*za[rř]azen[ií]\w*|n[aá]zev[\s._-]*(?:va[sš][ieí]|sou[cč]asn[eé])[\s._-]*pozic\w*` +
        `)${NA}`,
      'i',
    ),
    weak: new RegExp(
      `${NB}${String.raw`(?:titles?|positions?|roles?|occupations?|pozic\w*|funkc\w*|profes\w*)`}${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // the vacancy, not the candidate's own job
        `|${NB}${String.raw`(?:applied?|applying|apply|desired|preferred|target|wanted|open|available|vacan\w*|requisition|advertised|posted)[\s._-]*(?:for[\s._-]*)?(?:positions?|roles?|jobs?|titles?)`}${NA}` +
        `|${NB}${String.raw`(?:positions?|roles?|jobs?|titles?)[\s._-]*(?:applied|applying|of[\s._-]*interest|you[\s._-]*(?:are|re)[\s._-]*applying|sought)`}${NA}` +
        `|${NB}${String.raw`(?:pozic\w*|m[ií]st\w*)[\s._-]*(?:o[\s._-]*kterou|na[\s._-]*kterou|kterou)`}` +
        `|${NB}${String.raw`(?:uch[aá]z\w*|hledan\w*|inzerovan\w*|nab[ií]zen\w*|voln\w*)[\s._-]*(?:pozic\w*|m[ií]st\w*)`}` +
        // metadata about a job, not its name
        `|${NB}${String.raw`(?:jobs?|positions?|roles?)[\s._-]*(?:locations?|descriptions?|ids?|numbers?|references?|types?|levels?|families|codes?)`}${NA}` +
        `|${ownedField(NEARBY_OWNER, String.raw`titles?|positions?|roles?|pozic\w*`).source}` +
        `|${czOwnedField(String.raw`pozic\w*|funkc\w*|titul\w*`).source}` +
        `|${categoryOf(String.raw`jobs?|positions?|roles?|pozic\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * The applicant's *current* employer.
     *
     * A bare `company` / `společnost` is deliberately NOT a positive here, and
     * that is the entire safety design of this rule: those tokens are the owner
     * half of {@link ORG}, {@link LINK_OWNER} and {@link czOwnedField}, i.e. the
     * words that disqualify every other rule from "Company name", "Company
     * website" and "Jméno společnosti". Admitting them would have meant fighting
     * the same regression suite from the other side. `Employer` and any
     * "current / present / latest" qualifier are unambiguous and suffice.
     *
     * The negative mirrors those owner contexts one for one: an employer's
     * *website*, *address* or *LinkedIn* is not its name.
     */
    type: 'currentEmployer',
    autocomplete: ['organization'],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`(?:current|currently|present|latest|most[\s._-]*recent|existing)[\s._-]*(?:employers?|compan(?:y|ies)|organi[sz]ations?|firms?|workplaces?|employment)|` +
        String.raw`employers?(?:[\s._-]*names?)?|` +
        String.raw`who[\s._-]*(?:do|are)[\s._-]*you[\s._-]*(?:currently[\s._-]*)?work(?:ing)?[\s._-]*for|` +
        String.raw`where[\s._-]*do[\s._-]*you[\s._-]*(?:currently[\s._-]*)?work|` +
        // Czech / Slovak
        String.raw`(?:sou[cč]asn\w*|aktu[aá]ln\w*|nyn[eě]j[sš]\w*|st[aá]vaj[ií]c\w*|posledn[ií])[\s._-]*(?:zam[eě]stnavatel\w*|spole[cč]nost\w*|firm\w*|zam[eě]stn[aá]n\w*)|` +
        String.raw`zam[eě]stnavatel\w*|zamestn[aá]vate[lľ]\w*` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // a previous employer is not the current one
        `|${NB}${String.raw`(?:previous|former|past|prior|last[\s._-]*but|p[rř]edchoz\w*|b[yý]val\w*|minul\w*)`}` +
        // an attribute of the employer rather than its name
        `|${ownedField(
          String.raw`compan(?:y|ies)|employers?|organi[sz]ations?|firms?|spole[cč]nost\w*|firm\w*|zam[eě]stnavatel\w*`,
          String.raw`websites?|urls?|e[\s._-]?mails?|phones?|tel\w*|address(?:es)?|adres\w*|str[aá]nk\w*|logos?|sizes?|linked[\s._-]?in|git[\s._-]?hub|locations?|lokalit\w*|industr\w*|odv[eě]tv\w*|numbers?|ids?|[cč][ií]sl\w*|i[cč]o|dic|vat`,
        ).source}` +
        `|${categoryOf(String.raw`employers?|compan(?:y|ies)|zam[eě]stnavatel\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * How long the applicant has been doing this. Both this and `salary` are
     * "type a number here", so the two are kept apart lexically rather than by
     * score: nothing in this rule mentions money and nothing in `salary`
     * mentions years.
     *
     * Bare `experience` is `weak` — it is a section heading ("Work Experience"),
     * an essay subject ("Tell us about your experience with React") and a skills
     * matrix column. Czech `praxe` is strong: it is a discrete field on Czech
     * boards, and it is not a synonym for "experience" in the essay sense.
     *
     * "…years of age" is disqualified outright: the same live form asks two age
     * questions, and a candidate's seniority is not their age.
     */
    type: 'yearsOfExperience',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        // The `do you have` tail is what makes the commonest phrasing of all —
        // "How many years of experience do you have?" — a *dedicated* label
        // rather than a question the essay heuristic picks up: `have` is not a
        // filler word, and one stranded verb is the difference between 35 and 20.
        String.raw`(?:how[\s._-]*many[\s._-]*|total[\s._-]*|overall[\s._-]*|number[\s._-]*of[\s._-]*|no[\s._-]*of[\s._-]*)?years?[\s._-]*(?:of[\s._-]*)?(?:relevant[\s._-]*|professional[\s._-]*|work(?:ing)?[\s._-]*|commercial[\s._-]*|total[\s._-]*|industry[\s._-]*)?experien\w*(?:[\s._-]*(?:do[\s._-]*you[\s._-]*have|have[\s._-]*you[\s._-]*got))?|` +
        String.raw`experien\w*[\s._\/(-]*(?:in[\s._-]*)?years?|experien\w*[\s._-]*levels?|` +
        String.raw`how[\s._-]*many[\s._-]*years?|` +
        String.raw`(?:seniority|tenure)[\s._-]*(?:levels?|in[\s._-]*years?)?|` +
        // Czech / Slovak
        String.raw`(?:po[cč]et[\s._-]*)?let[\s._-]*(?:prax\w*|zku[sš]enost\w*)|rok[uůy]?[\s._-]*(?:prax\w*|zku[sš]enost\w*)|` +
        String.raw`d[eé]lka[\s._-]*prax\w*|d[lĺ][zž]ka[\s._-]*prax\w*|prax[eií]\w*[\s._-]*v[\s._-]*(?:letech|oboru)|` +
        String.raw`prax[eiíu]?` +
        `)${NA}`,
      'i',
    ),
    weak: new RegExp(`${NB}${String.raw`(?:experien\w*|zku[sš]enost\w*)`}${NA}`, 'i'),
    negative: new RegExp(
      `${THIRD_PARTY_PRESENT.source}` +
        // an age question, not a seniority one
        `|${NB}${String.raw`years?[\s._-]*of[\s._-]*age`}${NA}` +
        `|${NB}${String.raw`(?:ages?|v[eě]k\w*)[\s._-]*(?:in[\s._-]*)?(?:years?|let)`}${NA}` +
        `|${NB}${String.raw`(?:are[\s._-]*you[\s._-]*(?:at[\s._-]*least[\s._-]*)?\d+|over[\s._-]*\d+|under[\s._-]*\d+)`}` +
        // somebody else's experience, or a different meaning of the word
        `|${NB}${String.raw`(?:user|customer|client|candidate[\s._-]*)?experience[\s._-]*(?:designs?|designers?|managers?|platforms?)`}${NA}` +
        `|${NB}${String.raw`(?:user|customer|client|ux|cx)[\s._-]*experien\w*`}` +
        `|${ownedField(ORG, String.raw`experien\w*|prax\w*`).source}`,
      'i',
    ),
  },
  {
    /**
     * `profil` stays exact rather than `profil\w*`: broadening it would match
     * the English "Profile", and "Profile URL" would then be filled with the
     * candidate's biography instead of a link.
     */
    type: 'about',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`about(?:[\s._-]*(?:me|you|your[\s._-]?self))?|` +
        String.raw`(?:professional|personal|profile|career|candidate|short|brief|executive)[\s._-]*(?:summar(?:y|ies)|bio|biography|statement|profile)|` +
        String.raw`summar(?:y|ies)|bios?|biograph\w*|personal[\s._-]*statement|elevator[\s._-]*pitch|intro(?:duction)?|` +
        // Czech / Slovak
        String.raw`souhrn\w*|shrnut[ií]|zhrnut\w*|o[\s._-]*sob[eě]|o[\s._-]*sebe|o[\s._-]*mn[eě]|` +
        String.raw`n[eě]co[\s._-]*o[\s._-]*(?:sob[eě]|v[aá]s)|kr[aá]tk[eé][\s._-]*p[rř]edstaven[ií]|` +
        String.raw`p[rř]edstav(?:te[\s._-]*se|en[ií])|profil` +
        `)${NA}`,
      'i',
    ),
    negative: new RegExp(
      `${NB}${String.raw`about[\s._-]*(?:this|the|us|our|compan|role|job|position|team|process|product|vacanc|n[aá]s|spole[cč]nost|firm|pozic)`}` +
        `|${NB}${String.raw`(?:hear|heard|learn|learned|find|found)[\s._-]*(?:out[\s._-]*)?about`}` +
        `|${NB}${String.raw`(?:order|application|job|position|salary|payment|billing|invoice|cart|basket)[\s._-]*summar`}` +
        `|${NB}${String.raw`o[\s._-]*(?:n[aá]s|spole[cč]nosti|firm[eě]|pozici)`}${NA}` +
        String.raw`|linked[\s._-]?in|git[\s._-]?hub|twitter|facebook|instagram|dribbble|behance`,
      'i',
    ),
  },
];
