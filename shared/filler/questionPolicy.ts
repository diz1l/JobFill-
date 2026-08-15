/**
 * The questions a language model is not allowed to answer.
 *
 * ── Why this is a separate rule from "can the model be wrong here" ───────────
 * Everywhere else in this extension a model error costs an empty field or a
 * value the user has to correct — annoying, visible, amber-highlighted. A whole
 * class of application questions is not like that:
 *
 *     Are you at least 18 years of age or older?          Yes / No
 *     Are you of required legal drinking age?             Yes / No
 *     Human Resources may contact me regarding other positions   Yes / No
 *     Is your work experience and education included on your resume?  Yes / No
 *
 * These are not fields to be filled in. They are **statements about a person**,
 * submitted to an employer under that person's name, and several of them have
 * legal weight. "Yes" here is not a guess that turned out wrong; it is a
 * declaration the applicant never made. No highlight colour makes that
 * acceptable, and no amount of model accuracy makes it appropriate — an answer
 * that happens to be true is still an answer the applicant did not give.
 *
 * So: these fields are filled from what the user stored in their profile, or
 * they are not filled at all. Never from the model's judgement.
 *
 * ── Enforced, not requested ──────────────────────────────────────────────────
 * The prompts state the same rules, because a model that understands them
 * answers better and wastes no output on fields that would be dropped. This
 * module is what makes them true. It runs on the way *out* of the model in the
 * worker, and again in the page immediately before anything is written — and,
 * for dropdowns, a third time *before the question is even asked*, so a
 * protected list's options are never put on the wire in the first place.
 *
 * ── Two lists, on purpose ────────────────────────────────────────────────────
 * {@link protectedTopic} covers everything above and governs the path where the
 * model picks an *answer* from a dropdown — there it authors the declaration
 * itself, so the list is drawn as widely as the categories allow.
 * {@link DECLARATION_TOPICS} is the subset that also governs the value-template
 * path, where the model can only choose which of the user's *own* stored values
 * to copy. Work authorisation is in the first and not the second on purpose:
 * `workPermit` is a profile field the user filled in themselves, so copying it
 * into "Do you need a work permit?" is the user answering — while picking Yes or
 * No off a citizenship dropdown is the model answering.
 */

import {
  MAX_OPTION_LABEL_CHARS,
  MAX_OPTION_PAYLOAD_CHARS,
  MAX_OPTION_SELECTS,
  MAX_SELECT_OPTIONS,
  type SelectQuestion,
} from '../messages';
import { canonicalOption, NO_ID, YES_ID } from './optionSynonyms';

export type ProtectedTopic =
  /** Age, date of birth, "18 or older", legal drinking age. */
  | 'age'
  /** Right to work, citizenship, nationality, visa, sponsorship, residency. */
  | 'workAuthorization'
  /** Convictions, criminal record, background checks. */
  | 'criminalRecord'
  /** Military or veteran service. */
  | 'militaryService'
  /** Disability, health, impairment. */
  | 'disability'
  /** Race, ethnicity, gender, religion, orientation, marital status, EEO. */
  | 'protectedGroup'
  /** Consent, opt-in, marketing, "may contact me about other positions". */
  | 'consent'
  /** Confirming that something is true, accurate, complete, or included. */
  | 'attestation'
  /** Education level, degrees, certifications, licences. */
  | 'credentials';

interface TopicRule {
  topic: ProtectedTopic;
  pattern: RegExp;
}

/**
 * Matched against the *serialized fingerprint* — `autocomplete|name|id|
 * semanticName|aria-label|label|placeholder|heading|description` — so a question
 * is caught by its markup as well as by its wording. Czech and Slovak spellings
 * are listed with and without diacritics because the fingerprint is raw page
 * text, folded nowhere.
 *
 * The patterns are deliberately broad. A false positive costs one dropdown the
 * user fills in themselves; a false negative lets a machine sign something.
 */
const TOPIC_RULES: readonly TopicRule[] = [
  {
    topic: 'age',
    pattern:
      /\bage\b|\bages\b|how old|date of birth|birth\s?date|\bdob\b|\bborn\b|birthday|\b1[68]\+|\b(?:1[68]|21)\s*(?:years|yrs)|years of age|of legal age|age of majority|drinking age|minimum age|věk\b|vek\b|datum narození|datum narozeni|rodné číslo|rodne cislo|plnolet|zletil/i,
  },
  {
    topic: 'workAuthorization',
    pattern:
      /work permit|work authori|authori[sz]ed to work|right to work|legally (?:authori|entitled|allowed|permitted)|eligible to work|sponsorship|\bvisa\b|citizenship|\bcitizen\b|nationality|national origin|residency status|permanent resident|green card|pracovní povolení|pracovni povoleni|povolení k pobytu|povoleni k pobytu|občanství|obcanstvi|státní příslušnost|statni prislusnost/i,
  },
  {
    topic: 'criminalRecord',
    pattern:
      /criminal|conviction|convicted|\bfelony\b|misdemean|offen[cs]e|background check|police (?:record|check)|rejstřík|rejstrik|\btrest|bezúhonn|bezuhonn/i,
  },
  {
    topic: 'militaryService',
    pattern:
      /military|armed forces|\bveteran|conscript|selective service|draft status|vojensk|armád|armad|branná povinnost|branna povinnost/i,
  },
  {
    topic: 'disability',
    pattern:
      /disabilit|\bdisabled\b|handicap|impairment|chronic (?:illness|condition)|invalidit|invalidní|invalidni|zdravotní postižení|zdravotni postizeni|zdravotní stav|zdravotni stav|zdravotní omezení|zdravotni omezeni/i,
  },
  {
    topic: 'protectedGroup',
    pattern:
      /\bgender\b|\bsex\b|\brace\b|ethnic|religio|sexual orientation|marital status|pregnan|\blgbt|minority|protected (?:group|class|veteran|characteristic)|\beeo\b|equal opportunity|diversity (?:survey|questionnaire|monitoring)|pohlaví|pohlavi|rodinný stav|rodinny stav|náboženstv|nabozenstv|etnick|národnost|narodnost/i,
  },
  {
    topic: 'consent',
    pattern:
      /consent|\bagree\b|agreement|opt[\s_-]?in|subscribe|newsletter|marketing|\bgdpr\b|privacy polic|data processing|processing of (?:my|your) (?:personal )?data|contact me\b|talent (?:pool|community|network)|other (?:positions|opportunities|vacancies)|future (?:roles|openings|positions)|souhlas|zpracování osobních údajů|zpracovani osobnich udaju|marketingov/i,
  },
  {
    topic: 'attestation',
    pattern:
      /\bcertify\b|\battest\b|\bdeclare\b|declaration|acknowledge|i confirm|confirm that|please confirm|true and (?:complete|accurate|correct)|accurate and complete|to the best of my knowledge|included (?:on|in) (?:your|my|the) (?:resume|cv|curriculum)|on your (?:resume|cv)|prohlašuji|prohlasuji|čestné prohlášení|cestne prohlaseni|potvrzuji/i,
  },
  {
    topic: 'credentials',
    pattern:
      /level of education|highest (?:level|degree|qualification|education)|education(?:al)? (?:level|attainment)|degree (?:obtained|earned|level|completed)|\bgpa\b|grade point|certification|professional licen[cs]e|driv(?:ing|er'?s) licen[cs]e|nejvyšší|nejvyssi|dosažené vzdělání|dosazene vzdelani|vzdělání|vzdelani|řidičsk|ridicsk/i,
  },
];

/**
 * The first reason this question may not be answered by a model, or `null`.
 */
export function protectedTopic(fingerprint: string): ProtectedTopic | null {
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(fingerprint)) return rule.topic;
  }
  return null;
}

/**
 * The subset that also bars the value-template path.
 *
 * Two topics are deliberately absent. Work authorisation and qualifications have
 * a profile field of their own — `workPermit`, `education` — so a template
 * naming one is the *user's* answer being copied into the field that asked for
 * it, which is the whole point of that path. Every topic listed here has no such
 * field and never will: there is nothing to copy, only something to invent, and
 * "Yes" borrowed from `workPermit` is not an answer to "Have you ever been
 * convicted?" however true it is about work permits.
 *
 * The dropdown path refuses all nine regardless — there the model would be
 * choosing the answer itself rather than choosing whose answer to copy.
 */
const DECLARATION_TOPICS: ReadonlyArray<ProtectedTopic> = [
  'age',
  'criminalRecord',
  'militaryService',
  'disability',
  'protectedGroup',
  'consent',
  'attestation',
];

/** Does this fingerprint describe a declaration no stored value can answer? */
export function isDeclarationField(fingerprint: string): boolean {
  const topic = protectedTopic(fingerprint);
  return topic !== null && DECLARATION_TOPICS.includes(topic);
}

/**
 * A list offering both yes and no — in any of the spellings the alias tables
 * know, which is what makes this a structural check rather than a lexical one.
 *
 * Every binary dropdown on an application form is a question *about the
 * applicant*, and the wording is the part that varies: it can be phrased in
 * Czech, buried in an `aria-label`, or worded in a way no pattern above
 * anticipated. The shape of the answer set cannot be phrased away. So the model
 * is never offered one, and the four questions the live Workday run turned up
 * are refused twice over — by topic and by shape.
 */
export function isBinaryChoice(options: readonly string[]): boolean {
  let yes = false;
  let no = false;
  for (const option of options) {
    const id = canonicalOption(option);
    if (id === YES_ID) yes = true;
    if (id === NO_ID) no = true;
  }
  return yes && no;
}

/**
 * Everything that may be asked about a dropdown, capped and filtered.
 *
 * Shared by the page (which builds the batch) and the LLM client (which is the
 * last code to touch it before it becomes an HTTP body), so "what can leave the
 * browser" has exactly one definition. Both call it; neither can widen it.
 */
export function askableSelects(selects: readonly SelectQuestion[]): SelectQuestion[] {
  const out: SelectQuestion[] = [];
  let budget = MAX_OPTION_PAYLOAD_CHARS;

  for (const select of selects) {
    if (out.length >= MAX_OPTION_SELECTS) break;
    if (!isAskable(select)) continue;

    const cost = select.fingerprint.length + select.options.join('').length;
    if (cost > budget) break;
    budget -= cost;
    out.push(select);
  }

  return out;
}

/**
 * Nothing here truncates. A list is asked about whole or not at all, so what the
 * model was shown and what can be written back are the same strings — the reply
 * is an index, and an index into a shortened list points somewhere else.
 *
 * The size limits therefore *select* which dropdowns qualify. Both directions
 * are wanted: a 250-entry country list and a paragraph-long option are the two
 * shapes that would dominate the egress budget, and both belong to lists this
 * feature has no business with anyway — the long one is answered from the
 * profile, and the wordy one is almost always the consent sentence.
 */
function isAskable(select: SelectQuestion): boolean {
  if (protectedTopic(select.fingerprint) !== null) return false;

  const { options } = select;
  // One option is not a choice, and a yes/no pair is not ours to make.
  if (options.length < 2 || options.length > MAX_SELECT_OPTIONS) return false;
  if (options.some((label) => label.length > MAX_OPTION_LABEL_CHARS)) return false;
  return !isBinaryChoice(options);
}
