import type {
  Profile,
  CompleteFillSummary,
  FieldConfidence,
  FillSummary,
  LlmFieldConfidence,
} from '../types';
import { LLM_FIELD_CONFIDENCE } from '../types';
import {
  buildClassificationBatch,
  buildFingerprint,
  enumerateFillable,
  type FieldFingerprint,
  type FillableElement,
} from '../field-matcher/fingerprint';
import { scoreField } from '../field-matcher/scorer';
import { setNativeValue } from './setNativeValue';
import { fillSelect } from './selectStrategy';
import { highlightField } from './highlight';
import { isSensitiveControl, isInsideAuthForm } from './fillable';
import { rememberRecognizedCoverField } from './coverTarget';
import { COVER_LETTER_FIELD } from './missingData';
import { resolveAnswer } from './valueTemplate';
import { describeField } from './fieldShape';

/**
 * A field type's value, via `valueTemplate`.
 *
 * The lookup table that used to live here could answer with exactly one profile
 * property, `fullName` hardcoded as the sole exception. Forms do not respect
 * that shape — "Jméno a příjmení" wants two atoms in one box — hence templates.
 *
 * The whole fingerprint is passed on, not just the field type: `pattern`,
 * `maxlength`, `type` and the field's own wording are what decide *which*
 * spelling of the value this particular form accepts.
 */
function resolveValue(
  fieldType: string,
  profile: Profile,
  coverLetterText: string,
  fp: FieldFingerprint,
): string {
  return resolveAnswer(fieldType, { profile, coverLetter: coverLetterText }, describeField(fp));
}

const DEFAULT_HIGHLIGHT_MS = 3000;

/**
 * A cover letter is *never* reported as a settled `high` match.
 *
 * The value is generated text — a template with `{company}` / `{position}` /
 * `{source}` substituted, possibly against a posting whose company we failed to
 * extract — and it goes verbatim into a free-text box an employer reads. Same
 * argument that caps LLM-derived matches at amber, so it reuses the same
 * single-inhabitant type: no expression in this module can highlight a cover
 * letter green.
 */
const COVER_LETTER_CONFIDENCE: LlmFieldConfidence = LLM_FIELD_CONFIDENCE;

export interface FillOptions {
  highlightDurationMs?: number;
  /** Pre-resolved cover letter text (placeholders already substituted) */
  coverLetterText?: string;
  /**
   * Invoked for every control the heuristics left at `low` / `none` — exactly
   * the candidates for LLM classification. Recognised fields are never reported,
   * including those counted in `summary.noData`: naming a field a second time
   * does not conjure a value the profile does not hold.
   *
   * Collecting during the pass costs nothing; re-enumerating afterwards would
   * double the work and could disagree with what was just filled.
   */
  onUnresolved?: (fingerprint: FieldFingerprint) => void;
}

/**
 * Main fill entry point.  Enumerates the page, scores each field,
 * fills high/medium confidence ones, highlights everything.
 */
export function fillPage(profile: Profile, opts: FillOptions = {}): CompleteFillSummary {
  const durationMs = opts.highlightDurationMs ?? DEFAULT_HIGHLIGHT_MS;
  const coverLetterText = opts.coverLetterText ?? '';

  // Defence in depth: even if a credential field slips through enumeration, it
  // is never scored and never written to.
  const elements = enumerateFillable().filter(
    (el) => !isSensitiveControl(el) && !isInsideAuthForm(el),
  );
  const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');

  const summary: CompleteFillSummary = {
    // Every control we looked at: fillable ones plus the file inputs we only
    // highlight. Keeps `high + medium + unrecognized + noData + aiQuestions +
    // fileInputs === total` true, which was not the case before.
    total: elements.length + fileInputs.length,
    high: 0,
    medium: 0,
    unrecognized: 0,
    fileInputs: 0,
    aiQuestions: 0,
    noData: 0,
    missingFields: [],
  };

  // File inputs are highlighted, never filled.
  fileInputs.forEach((el) => {
    summary.fileInputs++;
    highlightField(el, 'file', durationMs);
  });

  for (const el of elements) {
    const fp = buildFingerprint(el);
    const match = scoreField(fp);

    if (!match || match.confidence === 'low' || match.confidence === 'none') {
      summary.unrecognized++;
      highlightField(el, 'none', durationMs);
      opts.onUnresolved?.(fp);
      continue;
    }

    // Open-ended question — skip fill, highlight as AI-needed
    if (match.fieldType === 'openQuestion') {
      summary.aiQuestions++;
      highlightField(el, 'ai', durationMs);
      continue;
    }

    // Remember the cover-letter field even with no text for it yet: "Generate
    // motivation → Insert" needs a target later.
    if (match.fieldType === 'coverLetter') rememberRecognizedCoverField(el);

    const value = resolveValue(match.fieldType, profile, coverLetterText, fp);

    if (!value) {
      // Recognised, nothing to write into it: the profile entry is blank, or —
      // the case behind the original bug report — no cover letter template
      // exists yet on a fresh install. This used to fall into `unrecognized`
      // with no highlight, so the field stayed empty, the counter said
      // "skipped", and the one thing the user could have done was never
      // mentioned. Still nothing is written (an empty box beats invented prose
      // in a form an employer reads), but the fact is reported.
      summary.noData++;
      if (!summary.missingFields.includes(match.fieldType)) {
        summary.missingFields.push(match.fieldType);
      }
      highlightField(el, 'empty', durationMs);
      continue;
    }

    const confidence: FieldConfidence =
      match.fieldType === 'coverLetter' ? COVER_LETTER_CONFIDENCE : match.confidence;

    if (writeInto(el, value)) {
      countMatch(summary, confidence);
      highlightField(el, confidence, durationMs);
    } else {
      // A <select> with no option resembling the value — recognised, but there
      // is nothing to pick. The LLM cannot help with that, so it is not a
      // classification candidate either.
      summary.unrecognized++;
      highlightField(el, 'none', durationMs);
    }
  }

  return summary;
}

/** Write a resolved value into a control. `false` only for an unfillable select. */
function writeInto(el: FillableElement, value: string): boolean {
  if (el instanceof HTMLSelectElement) return fillSelect(el, value);
  setNativeValue(el, value);
  return true;
}

function countMatch(summary: FillSummary, confidence: string): void {
  if (confidence === 'high') {
    summary.high++;
  } else {
    summary.medium++;
  }
}

// ─── Second pass: LLM classification of what the heuristics missed ────────────

/**
 * Sends the batch and returns the model's `index → field type` map.
 *
 * Injected rather than imported so this module stays free of `chrome.*`: the
 * content script passes a function that goes through the background worker (the
 * only context with the API key), and tests pass a spy. Rejecting or resolving
 * to `undefined` both mean "no classifications" — see {@link classifyUnresolvedFields}.
 */
export type ClassifyTransport = (
  fingerprints: string[],
) => Promise<Record<string, string> | undefined>;

export interface LlmPassOptions {
  /**
   * The opt-in, read from `AppSettings.llmFieldClassification`. Fail-closed:
   * anything other than a literal `true` sends nothing at all.
   */
  enabled: boolean;
  classify: ClassifyTransport;
  highlightDurationMs?: number;
  /** Same pre-resolved text `fillPage` was given, for a classified cover field. */
  coverLetterText?: string;
}

export interface LlmPassResult {
  /** Controls the model's answer actually filled. */
  filled: number;
  /** Fingerprints that were put on the wire (0 when the feature is off). */
  sent: number;
  /**
   * Confidence every one of those `filled` fields was highlighted with. Its type
   * admits exactly one value, so this is a fact about the code, not a report:
   * there is no branch in this module that can produce `high`.
   */
  confidence: LlmFieldConfidence;
}

function nothingClassified(sent = 0): LlmPassResult {
  return { filled: 0, sent, confidence: LLM_FIELD_CONFIDENCE };
}

/**
 * True while a control still looks the way the fill pass left it — empty. The
 * classification round-trip takes a second or two, and the user may well have
 * started typing into the very field the model is describing. Their input wins.
 */
function isUntouched(el: FillableElement): boolean {
  if (el instanceof HTMLSelectElement) return el.selectedIndex <= 0 || el.value === '';
  return el.value.trim() === '';
}

/**
 * The second pass. Runs *after* `fillPage` has filled and highlighted everything
 * it could recognise, over the fingerprints that pass reported through
 * `FillOptions.onUnresolved`. A plain async function with no timers of its own:
 * the caller starts it without awaiting, so heuristic filling is never held up
 * by a network request.
 *
 * Every failure mode — no key, no network, a timeout, a hallucinated answer, an
 * index that does not exist — leaves the fields exactly as the heuristics left
 * them, silently.
 *
 * A filled field is *always* highlighted {@link LLM_FIELD_CONFIDENCE} — amber,
 * "check this" — never `high`.
 */
export async function classifyUnresolvedFields(
  profile: Profile,
  candidates: readonly FieldFingerprint[],
  options: LlmPassOptions,
): Promise<LlmPassResult> {
  // Fail-closed. This is the last gate before anything leaves the page.
  if (options.enabled !== true) return nothingClassified();

  const batch = buildClassificationBatch(candidates);
  if (batch.payload.length === 0) return nothingClassified();

  let classifications: Record<string, string> | undefined;
  try {
    classifications = await options.classify(batch.payload);
  } catch {
    return nothingClassified(batch.payload.length); // silent by design
  }
  if (!classifications) return nothingClassified(batch.payload.length);

  const durationMs = options.highlightDurationMs ?? DEFAULT_HIGHLIGHT_MS;
  let filled = 0;

  for (const [key, answer] of Object.entries(classifications)) {
    const field = batch.fields[Number(key)];
    // The API client validates the schema; this re-check is what makes an index
    // outside the batch (or a non-numeric key) harmless here too.
    if (!field) continue;

    const el = field.element;
    // The page is a live document: it may have re-rendered, and the user may
    // have typed. Both mean hands off.
    if (!el.isConnected || !isUntouched(el)) continue;
    // Defence in depth: a model instruction is not a reason to write profile
    // data into a credential field.
    if (isSensitiveControl(el) || isInsideAuthForm(el)) continue;

    const value = resolveValue(answer, profile, options.coverLetterText ?? '', field);
    if (!value) continue; // unknown type, or the profile has nothing to offer
    if (!writeInto(el, value)) continue;

    // The answer may be a field type or a template (see `resolveAnswer`), and
    // either way a cover-letter box is the target "Generate motivation → Insert"
    // needs to remember.
    if (answer === COVER_LETTER_FIELD || answer.includes(`{${COVER_LETTER_FIELD}}`)) {
      rememberRecognizedCoverField(el);
    }
    highlightField(el, LLM_FIELD_CONFIDENCE, durationMs);
    filled++;
  }

  return { filled, sent: batch.payload.length, confidence: LLM_FIELD_CONFIDENCE };
}

export { LLM_FIELD_CONFIDENCE } from '../types';
export type { LlmFieldConfidence } from '../types';
export { setNativeValue } from './setNativeValue';
export { fillSelect } from './selectStrategy';
export {
  highlightField,
  removeAllHighlights,
  removeStyles,
  activeHighlightCount,
} from './highlight';
export {
  isFillableControl,
  isSensitiveControl,
  isInlineButtonAnchor,
  isInsideAuthForm,
  looksLikeAuthPage,
  hasFillableControls,
  countFillableControls,
} from './fillable';
export {
  resolveCoverTarget,
  rememberFocusedField,
  rememberRecognizedCoverField,
  forgetCoverTargets,
} from './coverTarget';
export {
  COVER_LETTER_FIELD,
  MISSING_DATA_LABELS,
  describeMissingData,
  splitMissingData,
} from './missingData';
export type { MissingDataBreakdown } from './missingData';
export type { HighlightKind } from './highlight';
/**
 * The composition layer. `PROFILE_VALUE_KEYS` is the vocabulary the LLM prompt
 * offers the model; `resolveTemplate` is the only thing that ever sees both a
 * template and the profile, and it runs in the page.
 */
export {
  DEFAULT_TEMPLATES,
  PROFILE_VALUE_KEYS,
  TEMPLATE_VALUE_KEYS,
  isProfileValueKey,
  isTemplateValueKey,
  resolveAnswer,
  resolveFieldType,
  resolveTemplate,
  selectTemplate,
} from './valueTemplate';
export type {
  ProfileValueKey,
  TemplateValueKey,
  ValueContext,
  ValueTemplate,
} from './valueTemplate';
export { DERIVED_VALUE_KEYS } from './atoms';
export type { DerivedValueKey } from './atoms';
export { ANY_SHAPE, describeField } from './fieldShape';
export type { FieldDescription, FieldShape } from './fieldShape';
export { VARIANTS } from './templateVariants';
export type { TemplateVariant } from './templateVariants';
