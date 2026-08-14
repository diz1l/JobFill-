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
  `|${NB}${String.raw`names?[\s._-]*(?:first|last|given|family|middle|maiden)`}${NA}`;

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
        `|${ownedField(PERSON_OWNER, String.raw`names?|jm[eé]n\w*|meno`).source}` +
        `|${czOwnedField(String.raw`jm[eé]n\w*|meno`).source}`,
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
        `|${ownedField(PERSON_OWNER, String.raw`names?|p[rř][ií]jmen[ií]\w*|priezvisk\w*`).source}` +
        `|${czOwnedField(String.raw`p[rř][ií]jmen[ií]\w*|priezvisk\w*`).source}`,
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
     */
    type: 'phone',
    autocomplete: ['tel', 'tel-national'],
    pattern: new RegExp(
      `${NB}(?:` +
        // Czech adjective + noun, matched as one phrase ("Mobilní telefon")
        String.raw`(?:mobiln|pevn|pracovn|osobn|dom[aá]c|soukrom)\w*[\s._-]*(?:telef[oó]n\w*|link[ay])|` +
        String.raw`[cč][ií]sl[oa][\s._-]*(?:telefonu|mobilu)|telef[oó]nn?\w*[\s._-]*[cč][ií]sl\w*|` +
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
        `|${czOwnedField(String.raw`telefon\w*|mobil\w*`).source}`,
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
     */
    type: 'workPermit',
    autocomplete: [],
    pattern: new RegExp(
      `${NB}(?:` +
        String.raw`work(?:ing)?[\s._-]?permits?|work[\s._-]?visas?|visas?(?:[\s._-]*(?:status|type|sponsorship|requirements?))?|` +
        String.raw`residence[\s._-]?permits?|residency(?:[\s._-]*status)?|` +
        String.raw`citizenship|citizens?|nationalit(?:y|ies)|` +
        String.raw`(?:work|employment)[\s._-]*(?:authori[sz]\w*|eligibilit\w*)|` +
        String.raw`(?:legally[\s._-]*)?authori[sz]ed[\s._-]*to[\s._-]*work|eligib\w*[\s._-]*to[\s._-]*work|` +
        String.raw`right[\s._-]*to[\s._-]*work|(?:require[\s._-]*)?sponsorship|` +
        // Czech / Slovak
        String.raw`pracovn[ií][\s._-]*povolen[ií]|povolen[ií][\s._-]*(?:k[\s._-]*pob\w*|pracovat)|` +
        String.raw`ob[cč]anstv\w*|ob[cč]ianstv\w*|st[aá]tn[ií][\s._-]*p[rř][ií]slu[sš]nost\w*|` +
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
