/**
 * When two strings name the same answer.
 *
 * A dropdown and a profile rarely agree on wording. The profile says `Czechia`,
 * the list says `Czech Republic`; the profile says `CZ`, the list says `Česká
 * republika`; the profile says `Bachelor`, the list says `Vysokoškolské —
 * bakalářské`. No amount of string similarity bridges those — the pairs share no
 * words at all — so they are enumerated.
 *
 * This is **not** a translation dictionary, and it is not only used to say yes.
 * It answers one question — *do these two strings name the same thing?* — and
 * the "no" is worth as much as the "yes": similarity scoring happily awards
 * `Slovakia` half a point for `Prague Czechia` (one word in two), while this
 * table can state that Czechia and Slovakia are two different countries and the
 * option must be refused outright. A wrong pick in a dropdown reads as a
 * considered answer by the applicant; an empty one reads as an empty one.
 *
 * ── The tables ───────────────────────────────────────────────────────────────
 * One line per thing, `id|alias|alias|…`, where the first token doubles as the
 * id and as an alias. Aliases are written in whatever spelling a form uses them
 * in — English, Czech, Slovak, the native name, the ISO code — and are folded
 * through {@link normalizeOption} when the index is built, so diacritics, case
 * and punctuation need no attention here.
 *
 * ── Ambiguity resolves to nothing ────────────────────────────────────────────
 * An alias listed under two different ids is dropped rather than arbitrated:
 * `suomi` is both Finland and Finnish, and no verdict is better than the wrong
 * one. The same rule is why `no` is absent from Norway's line — it belongs to
 * the yes/no answer, and `Norway` must never be the option that a profile value
 * of "No" selects.
 */

/** Verdict ids for the two answers every ATS form is full of. */
export const YES_ID = 'yesno:yes';
export const NO_ID = 'yesno:no';

/** Stored for an alias that names more than one thing; resolves to `null`. */
const AMBIGUOUS = '?';

/**
 * Lowercase, fold diacritics, drop apostrophes, and treat everything else that
 * is not a letter or a digit as a word separator.
 *
 * Apostrophes are removed rather than split on so that `Bachelor's degree` and
 * `bachelors degree` are one string; every other punctuation mark becomes a
 * space so that `Czech-Republic` and `czech_republic` keep their two words
 * instead of being glued into one.
 */
export function normalizeOption(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Yes and no, in the spellings the Czech and Slovak boards use. Deliberately
 * small: this is the domain where a wrong verdict answers a question about the
 * applicant, so it holds only tokens that can mean nothing else.
 */
const YES_NO = ['yes|y|true|ano', 'no|n|false|ne|nie'];

/**
 * Levels of education, not titles. `Ing.` and `Mgr.` are absent on purpose —
 * they are name suffixes as often as they are degrees, and a Suffix dropdown
 * that offered both would have had them declared identical.
 */
const EDUCATION = [
  'primary|primary school|primary education|elementary|elementary school|zakladni|zakladni skola|zakladni vzdelani',
  'vocational|vocational training|apprenticeship|trade school|vyucen|vyucena|ucnovske|stredni odborne|stredni odborne bez maturity',
  'secondary|high school|high school diploma|secondary school|secondary education|upper secondary|a levels|ged|maturita|stredoskolske|stredni skola|stredni vzdelani s maturitou|stredoskolske s maturitou',
  'associate|associate degree|associates degree|foundation degree|higher professional|vyssi odborne|vyssi odborne vzdelani',
  'bachelor|bachelors|bachelors degree|bachelor degree|undergraduate|undergraduate degree|bsc|bakalar|bakalarske|bakalarsky|vysokoskolske bakalarske',
  'master|masters|masters degree|master degree|graduate degree|msc|magistr|magisterske|inzenyrske|vysokoskolske magisterske',
  'doctorate|doctoral|doctoral degree|doctor of philosophy|phd|doktorske|doktorat',
];

/**
 * Languages by name only. The two-letter codes are almost all somebody's
 * country code as well (`de`, `fr`, `it`, `pl`, `ru`), and an ambiguous alias is
 * a dropped alias — so only `en` and `cs`, which collide with nothing, are here.
 */
const LANGUAGE = [
  'english|anglictina|anglicky|en|eng',
  'czech|cestina|cesky|cs|ces',
  'slovak|slovencina|slovensky',
  'german|deutsch|nemcina|nemecky',
  'french|francais|francouzstina|francouzsky',
  'spanish|espanol|castellano|spanelstina',
  'italian|italiano|italstina',
  'polish|polski|polstina',
  'ukrainian|ukrajinstina|ukrajinsky',
  'russian|rustina|russkij|rusky',
  'dutch|nederlands|nizozemstina',
  'portuguese|portugues|portugalstina',
  'hungarian|magyar|madarstina',
  'romanian|romana|rumunstina',
  'bulgarian|bulharstina',
  'croatian|hrvatski|chorvatstina',
  'serbian|srpski|srbstina',
  'slovenian|slovenscina|slovinstina',
  'swedish|svenska|svedstina',
  'norwegian|norsk|norstina',
  'danish|dansk|danstina',
  'finnish|suomi|finstina',
  'greek|ellinika|rectina',
  'turkish|turkce|turectina',
  'arabic|arabstina',
  'chinese|mandarin|zhongwen|cinstina',
  'japanese|nihongo|japonstina',
  'korean|korejstina',
  'hindi|hindstina',
  'vietnamese|vietnamstina',
];

/**
 * Europe in full, plus the countries a Czech application form is otherwise
 * likely to list. Each line carries the ISO-3166 alpha-2 code (which is what
 * `<option value>` usually holds), the English name, the Czech name, the native
 * name where a form might print it, and the alpha-3 code.
 */
const COUNTRY = [
  'cz|czechia|czech republic|ceska republika|cesko|cze',
  'sk|slovakia|slovak republic|slovensko|slovenska republika|svk',
  'at|austria|osterreich|rakousko|aut',
  'de|germany|deutschland|nemecko|deu',
  'pl|poland|polska|polsko|pol',
  'hu|hungary|magyarorszag|madarsko|hun',
  'gb|united kingdom|uk|great britain|britain|england|velka britanie|spojene kralovstvi|gbr',
  'ie|ireland|eire|irsko|irl',
  'fr|france|francie|fra',
  'es|spain|espana|spanelsko|esp',
  'pt|portugal|portugalsko|prt',
  'it|italy|italia|italie|ita',
  'nl|netherlands|the netherlands|holland|nederland|nizozemsko|nld',
  'be|belgium|belgique|belgie|bel',
  'lu|luxembourg|lucembursko|lux',
  'ch|switzerland|schweiz|suisse|svycarsko|che',
  'li|liechtenstein|lie',
  'dk|denmark|danmark|dansko|dnk',
  'se|sweden|sverige|svedsko|swe',
  'norway|norge|norsko|nor',
  'fi|finland|suomi|finsko|fin',
  'is|iceland|island|islandie|isl',
  'ee|estonia|eesti|estonsko|est',
  'lv|latvia|latvija|lotyssko|lva',
  'lt|lithuania|lietuva|litva|ltu',
  'ua|ukraine|ukrajina|ukr',
  'by|belarus|belorusko|bielorusko|blr',
  'ru|russia|russian federation|rusko|rus',
  'md|moldova|moldavsko|mda',
  'ro|romania|rumunsko|rou',
  'bg|bulgaria|bulharsko|bgr',
  'gr|greece|hellas|recko|grc',
  'hr|croatia|hrvatska|chorvatsko|hrv',
  'si|slovenia|slovenija|slovinsko|svn',
  'rs|serbia|srbija|srbsko|srb',
  'ba|bosnia and herzegovina|bosnia|bosna a hercegovina|bih',
  'mk|north macedonia|macedonia|makedonie|mkd',
  'me|montenegro|crna gora|cerna hora|mne',
  'al|albania|shqiperia|albanie|alb',
  'xk|kosovo',
  'mt|malta|mlt',
  'cy|cyprus|kypr|cyp',
  'tr|turkey|turkiye|turecko|tur',
  'ad|andorra',
  'mc|monaco',
  'sm|san marino',
  'va|vatican|holy see|vatikan',
  'us|united states|united states of america|usa|america|spojene staty',
  'ca|canada|kanada|can',
  'au|australia|australie|aus',
  'nz|new zealand|novy zeland|nzl',
  'in|india|indie|ind',
  'cn|china|cina|chn',
  'jp|japan|japonsko|jpn',
  'kr|south korea|republic of korea|jizni korea|kor',
  'br|brazil|brasil|brazilie|bra',
  'mx|mexico|mexiko|mex',
  'ar|argentina|arg',
  'za|south africa|jizni afrika|zaf',
  'il|israel|izrael|isr',
  'ae|united arab emirates|uae|are',
  'sg|singapore|singapur|sgp',
  'ph|philippines|filipiny|phl',
  'vn|vietnam|viet nam|vnm',
  'id|indonesia|indonesie|idn',
  'pk|pakistan|pak',
  'ng|nigeria|nga',
  'eg|egypt|egy',
];

const DOMAINS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['yesno', YES_NO],
  ['education', EDUCATION],
  ['language', LANGUAGE],
  ['country', COUNTRY],
];

/**
 * Built on first use, not on import: a content script runs in every frame of
 * every page, and the vast majority of them never see a `<select>` at all.
 */
let index: Map<string, string> | undefined;

function aliasIndex(): Map<string, string> {
  if (index) return index;
  const built = new Map<string, string>();
  for (const [domain, groups] of DOMAINS) {
    for (const group of groups) {
      const aliases = group.split('|');
      const id = `${domain}:${aliases[0]}`;
      for (const alias of aliases) {
        const key = normalizeOption(alias);
        built.set(key, built.has(key) ? AMBIGUOUS : id);
      }
    }
  }
  index = built;
  return built;
}

/**
 * What this string names, or `null` when the tables do not know it — or know it
 * as two different things.
 */
export function canonicalOption(value: string): string | null {
  const id = aliasIndex().get(normalizeOption(value));
  return id === undefined || id === AMBIGUOUS ? null : id;
}

/**
 * Whether two strings name the same thing, different things, or nothing the
 * tables can speak about.
 *
 * `'different'` is the load-bearing answer: it is the one that stops an option
 * from being chosen no matter how well its wording happens to score.
 */
export function compareAliases(a: string, b: string): 'same' | 'different' | null {
  const left = canonicalOption(a);
  if (left === null) return null;
  const right = canonicalOption(b);
  if (right === null) return null;
  return left === right ? 'same' : 'different';
}
