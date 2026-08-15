import { defineContentScript } from 'wxt/utils/define-content-script';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { fillPage, classifyUnresolvedFields } from '../shared/filler';
import { setNativeValue } from '../shared/filler/setNativeValue';
import { extractJobInfo } from '../shared/extractors';
import { getActiveProfile, getSettings, getProfiles, getCoverTemplates } from '../shared/storage/sync';
import {
  showInlineButton,
  repositionButton,
  hideInlineButton,
  showToast,
  isInlineButtonTarget,
  destroyInlineUi,
} from '../shared/filler/inlineButton';
import {
  isInlineButtonAnchor,
  hasFillableControls,
  looksLikeAuthPage,
} from '../shared/filler/fillable';
import {
  resolveCoverTarget,
  rememberFocusedField,
  forgetCoverTargets,
} from '../shared/filler/coverTarget';
import { removeAllHighlights, highlightField } from '../shared/filler/highlight';
import { describeMissingData } from '../shared/filler/missingData';
import { buildFingerprint, type FieldFingerprint } from '../shared/field-matcher/fingerprint';
import { validateFieldTemplates } from '../shared/api/fieldTemplates';
import { validateOptionChoices } from '../shared/api/optionChoice';
import {
  FRAME_REPLY,
  type FrameReplyMessage,
  type FrameRequest,
  type FromBackgroundMessage,
  type OpenQuestion,
  type SelectQuestion,
  type ToBackgroundMessage,
} from '../shared/messages';
import type { FillSummary, Profile } from '../shared/types';

const pendingQuestionEls = new Map<string, HTMLTextAreaElement>();

/** Sub-frames smaller than this cannot hold an application form (ads, pixels, widgets). */
const MIN_FRAME_WIDTH = 200;
const MIN_FRAME_HEIGHT = 150;
/** Grace period before the inline button disappears after blur. */
const BUTTON_HIDE_DELAY_MS = 350;
/** A toast carrying an instruction stays up longer than one carrying counters. */
const HINT_TOAST_MS = 7000;

export default defineContentScript({
  /**
   * The narrowest injection surface we can get away with. `<all_urls>` also
   * covered `file://`, `ftp://` and every custom scheme; the pair below is real
   * web pages only. On top of that: `excludeMatches` drops mail / payment /
   * identity origins that can never hold a job application, `excludeGlobs` drops
   * sign-in and checkout URLs anywhere, and `main()` bails out before touching a
   * frame too small to hold a form.
   *
   * Registration stays declarative rather than moving to `activeTab` +
   * `scripting.executeScript`, because the inline "Fill" button has to react to
   * `focusin` *before* the user has any way to click on the extension.
   */
  matches: ['http://*/*', 'https://*/*'],
  excludeMatches: [
    '*://mail.google.com/*',
    '*://accounts.google.com/*',
    '*://outlook.live.com/*',
    '*://outlook.office.com/*',
    '*://outlook.office365.com/*',
    '*://login.microsoftonline.com/*',
    '*://*.paypal.com/*',
    '*://*.stripe.com/*',
  ],
  excludeGlobs: [
    '*login*',
    '*logon*',
    '*signin*',
    '*sign-in*',
    '*password*',
    '*checkout*',
    '*payment*',
  ],
  allFrames: true,
  matchAboutBlank: false,
  runAt: 'document_idle',

  main(ctx: ContentScriptContext) {
    if (!frameCanHoldAForm()) return;

    installMessageBridge(ctx);

    // The inline button is the only thing that ever touches the page, and it is
    // not armed on sign-in screens at all.
    if (!looksLikeAuthPage()) setupInlineButton(ctx);

    // Everything we injected goes away with the page / the script.
    const teardown = () => {
      destroyInlineUi();
      removeAllHighlights();
      forgetCoverTargets();
      pendingQuestionEls.clear();
      classificationInFlight = false;
    };
    ctx.onInvalidated(teardown);
    ctx.addEventListener(window, 'pagehide', teardown);
  },
});

// ─── Frame gating ─────────────────────────────────────────────────────────────

function isTopFrame(): boolean {
  return window.top === window.self;
}

/** Cheap, layout-free reasons to do absolutely nothing in this frame. */
function frameCanHoldAForm(): boolean {
  const type = document.contentType;
  if (type && type !== 'text/html' && type !== 'application/xhtml+xml') return false;
  if (!isTopFrame() && (window.innerWidth < MIN_FRAME_WIDTH || window.innerHeight < MIN_FRAME_HEIGHT)) {
    return false;
  }
  return true;
}

// ─── Messaging ────────────────────────────────────────────────────────────────

/**
 * Frame addressing, page half — the caller half is `entrypoints/ui/frames.ts`,
 * which explains why the protocol is shaped this way. Two rules hold here:
 *
 *   1. **a frame with nothing to contribute never answers**, so silence is the
 *      normal outcome in frames that do not own the form;
 *   2. a frame that does answer uses `chrome.runtime.sendMessage`, never
 *      `sendResponse`, because Chrome hands the sender of a broadcast only the
 *      first `sendResponse` and the top frame's "0 filled" would shadow the
 *      iframe that actually holds the form.
 *
 * The listener therefore always returns `false`: nothing here uses the response
 * channel.
 */
function installMessageBridge(ctx: ContentScriptContext): void {
  const listener = (message: FrameRequest): boolean => {
    if (message.type === 'FILL_FORM') {
      if (!hasFillableControls()) return false; // another frame owns the form
      performFill(message.profileId)
        .then((result) => reply(message, result ?? { error: 'Profile not found.' }))
        .catch((err: Error) => reply(message, { error: err.message }));
      return false;
    }

    if (message.type === 'EXTRACT_JOB_INFO') {
      const jobInfo = extractJobInfo();
      // A sub-frame that found nothing stays out of it. The top frame answers
      // even empty-handed, because a page whose posting is only a description
      // still has to produce that description — the caller scores the answers
      // and keeps the richest one, so an empty answer can never win.
      if (jobInfo.company || jobInfo.position || isTopFrame()) {
        reply(message, { type: 'JOB_INFO', jobInfo });
      }
      return false;
    }

    if (message.type === 'FILL_COVER_TEXT') {
      // Insert only into a field we can justify, never into "the first textarea
      // on the page" — which is usually search or a chat widget.
      const target = resolveCoverTarget();
      if (!target) return false;
      setNativeValue(target, message.text);
      highlightField(target, 'high', 3000);
      target.scrollIntoView({ block: 'center' });
      reply(message, { success: true });
      return false;
    }

    if (message.type === 'FILL_ANSWERS') {
      // Only the frame that collected the questions can answer them.
      if (pendingQuestionEls.size === 0) return false;
      let filled = 0;
      for (const [id, answer] of Object.entries(message.answers)) {
        const el = pendingQuestionEls.get(id);
        if (el?.isConnected && answer) {
          setNativeValue(el, answer);
          filled++;
        }
      }
      reply(message, { filled });
      return false;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(listener);
  ctx.onInvalidated(() => chrome.runtime.onMessage.removeListener(listener));
}

/**
 * Answer a broadcast over the runtime bus, echoing the id it came with so the
 * caller can tell this reply from the previous click's.
 *
 * The callback is there only to consume `chrome.runtime.lastError`: the popup
 * may already be closed by the time a frame is done, and an unanswered message
 * is not something the page can act on.
 */
function reply(request: FrameRequest, payload: unknown): void {
  const envelope: FrameReplyMessage = {
    type: FRAME_REPLY,
    requestId: request.requestId,
    payload,
  };
  try {
    chrome.runtime.sendMessage(envelope, () => chrome.runtime.lastError?.message);
  } catch {
    // Extension context invalidated (update / reload) — the page is on its own.
  }
}

// ─── Inline fill button ───────────────────────────────────────────────────────

function setupInlineButton(ctx: ContentScriptContext): void {
  let currentAnchor: HTMLElement | null = null;
  let hideTimer: number | null = null;
  let trackingViewport = false;

  const reposition = () => {
    if (currentAnchor) repositionButton(currentAnchor);
  };

  // scroll/resize used to be bound for the lifetime of every page in every
  // frame. They now exist only while the button is actually on screen.
  const startTracking = () => {
    if (trackingViewport) return;
    trackingViewport = true;
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });
  };
  const stopTracking = () => {
    if (!trackingViewport) return;
    trackingViewport = false;
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  };

  const hide = () => {
    stopTracking();
    hideInlineButton();
    currentAnchor = null;
  };

  const triggerFill = async () => {
    hide();
    const result = await performFill('__active__');
    if (!result) {
      showToast('No active profile. Open settings and choose a profile.');
      return;
    }

    const { summary } = result;
    const filled = summary.high + summary.medium;
    const parts: string[] = [`Filled ${filled} field${filled !== 1 ? 's' : ''}`];
    if (summary.medium > 0) parts.push(`${summary.medium} need review`);
    if (summary.fileInputs > 0) {
      parts.push(`${summary.fileInputs} file${summary.fileInputs > 1 ? 's' : ''} attach manually`);
    }
    if (summary.aiQuestions > 0) {
      parts.push(
        `${summary.aiQuestions} open question${summary.aiQuestions > 1 ? 's' : ''} — use popup to answer`,
      );
    }
    const noData = summary.noData ?? 0;
    if (noData > 0) parts.push(`${noData} field${noData > 1 ? 's' : ''} we have no data for`);

    // Every other counter describes something visible on the page (a green
    // outline, a file box, a purple question). `noData` is invisible by
    // construction — the field is empty because we had nothing — so it gets a
    // second line naming the missing item and where to add it. Without this the
    // first run of a fresh install is silent.
    const hint = describeMissingData(summary.missingFields ?? []);
    showToast(hint ? `${parts.join(' · ')}\n${hint}` : parts.join(' · '), hint ? HINT_TOAST_MS : undefined);
  };

  ctx.addEventListener(document, 'focusin', (e: FocusEvent) => {
    if (!isInlineButtonAnchor(e.target)) return;
    // Recorded while the page still has focus — opening the popup blurs it.
    rememberFocusedField(e.target);
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    currentAnchor = e.target;
    showInlineButton(currentAnchor, triggerFill);
    startTracking();
  });

  ctx.addEventListener(document, 'focusout', (e: FocusEvent) => {
    if (isInlineButtonTarget(e.relatedTarget)) return;
    hideTimer = ctx.setTimeout(hide, BUTTON_HIDE_DELAY_MS);
  });

  ctx.onInvalidated(stopTracking);
}

// ─── Fill logic ───────────────────────────────────────────────────────────────

async function performFill(profileId: string): Promise<{
  type: 'FILL_RESULT';
  summary: FillSummary;
  openQuestions: OpenQuestion[];
} | null> {
  let profile = await getActiveProfile();
  if (!profile) {
    const profiles = await getProfiles();
    profile = profiles.find((p) => p.id === profileId);
  }
  if (!profile) return null;

  // No template → no text → the letter field is reported as `noData` and the
  // user is told what to do about it. Deliberately NOT auto-generated or filled
  // from a canned default: this text is submitted to an employer under the
  // user's name, so it never appears without them having seen it.
  let coverLetterText = '';
  const [templates, settings] = await Promise.all([getCoverTemplates(), getSettings()]);
  if (templates.length > 0) {
    const jobInfo = extractJobInfo();
    coverLetterText = templates[0].body
      .replace(/\{company\}/gi, jobInfo.company ?? '')
      .replace(/\{position\}/gi, jobInfo.position ?? '')
      .replace(/\{source\}/gi, resolveSource())
      .trim();
  }

  // The fields heuristics could not name, collected during the pass that is
  // about to run — no second enumeration of the page.
  const unresolved: FieldFingerprint[] = [];

  const summary = fillPage(profile, {
    highlightDurationMs: settings.highlightDurationMs,
    coverLetterText,
    onUnresolved: (fp) => unresolved.push(fp),
  });

  // Started, deliberately not awaited: the reply below (and with it the popup
  // summary, the badge and every highlight on the page) must not wait for a
  // network round-trip that only concerns fields nothing was written into.
  if (settings.llmFieldClassification) {
    void runClassificationPass(profile, unresolved, {
      highlightDurationMs: settings.highlightDurationMs,
      coverLetterText,
    });
  }

  // Keep the open-question textareas addressable, so the popup can answer them.
  pendingQuestionEls.clear();
  const openQuestions: OpenQuestion[] = [];
  document.querySelectorAll<HTMLTextAreaElement>('textarea.__jobfill-ai').forEach((el, i) => {
    const fp = buildFingerprint(el);
    const id = `oq_${i}`;
    pendingQuestionEls.set(id, el);
    openQuestions.push({ id, text: fp.labelText || fp.placeholder || fp.contextHeading || `Question ${i + 1}` });
  });

  return { type: 'FILL_RESULT', summary, openQuestions };
}

/**
 * The `{source}` placeholder — "where I saw this posting". It used to be
 * replaced with the empty string unconditionally, turning every "I found your ad
 * on {source}" template into a sentence with a hole in it.
 *
 * Which host is the honest answer depends on where this frame is: an ATS form is
 * routinely embedded in an iframe, where `location.hostname` is
 * `boards.greenhouse.io` rather than the site the user is looking at. So the top
 * document's host is asked for first, falling back to our own — which, for a
 * form served straight from the ATS, is the right answer anyway.
 */
function resolveSource(): string {
  if (isTopFrame()) return bareHost(location.hostname);

  // Same-origin parent: readable directly.
  try {
    const top = window.top?.location.hostname;
    if (top) return bareHost(top);
  } catch {
    // Cross-origin — expected, fall through.
  }

  // Cross-origin: `ancestorOrigins` is ordered parent-first, top-level last.
  // Chrome and Safari only; `undefined` on Firefox, hence the guard.
  const ancestors = location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    try {
      return bareHost(new URL(ancestors[ancestors.length - 1]).hostname);
    } catch {
      // Opaque origin ("null") — not a URL, nothing to salvage.
    }
  }

  return bareHost(location.hostname);
}

function bareHost(hostname: string): string {
  return hostname.replace(/^www\./i, '');
}

// ─── LLM classification pass ──────────────────────────────────────────────────

/**
 * One pass per frame at a time. A second Fill click while a request is in flight
 * would classify the same fingerprints for the same answer, so it is dropped —
 * this is also the only bound on how often the feature spends the user's quota.
 */
let classificationInFlight = false;

/**
 * The second pass: ask the worker to name the leftovers, fill what comes back,
 * tell the user on the page.
 *
 * It reports on the page, not in the popup, because a frame answers a fill
 * broadcast within milliseconds and `frames.ts` closes its collection window
 * 400 ms later — a classification answer arrives seconds after that, when
 * nothing is listening for this request any more. So amber highlights appear on
 * the fields as they are filled and one toast counts them; the popup's counters
 * stay the heuristic snapshot they always were.
 */
async function runClassificationPass(
  profile: Profile,
  candidates: FieldFingerprint[],
  opts: { highlightDurationMs: number; coverLetterText: string },
): Promise<void> {
  if (classificationInFlight || candidates.length === 0) return;
  classificationInFlight = true;
  try {
    const { filled } = await classifyUnresolvedFields(profile, candidates, {
      enabled: true,
      classify: requestClassification,
      chooseOptions: requestOptionChoice,
      ...opts,
    });
    if (filled > 0) {
      showToast(`JobFill: ${filled} more field${filled > 1 ? 's' : ''} matched by AI — please check`);
    }
  } catch {
    // Optional feature, unattended pass: nothing here is worth a message.
  } finally {
    classificationInFlight = false;
  }
}

/**
 * `fingerprints` are `serializeFingerprint` output and nothing else — no profile
 * values, no page body, not even the controls' current contents. The worker owns
 * the API key, so it makes the request; `undefined` means "no templates", which
 * is what every failure looks like from here.
 *
 * **The answer is validated again on arrival.** `validateFieldTemplates` already
 * ran in the worker on the way out of the model; it runs again here because this
 * is the last place before a value is written into somebody's job application.
 * Same function, same fingerprints, so a correct answer is unaffected — but a
 * template naming a non-existent atom, or one aimed at a consent box, cannot
 * reach the DOM even if everything upstream is wrong.
 */
/**
 * The dropdown half. `selects` is what `buildSelectBatch` allowed: a control's
 * fingerprint and the labels of its own `<option>` elements — the fixed choices
 * the site's author wrote, identical for every visitor — and nothing else from
 * the page. Dropdowns about a protected topic, yes/no lists and lists the user
 * has already answered never appear in it.
 *
 * The reply is re-validated here for the same reason as the template one: the
 * worker already ran `validateOptionChoices` on the way out of the model, and
 * this is the last place before an option is selected in somebody's job
 * application. Same function, same batch, so a correct answer is unaffected.
 */
function requestOptionChoice(selects: SelectQuestion[]): Promise<Record<string, number> | undefined> {
  const message: ToBackgroundMessage = { type: 'CHOOSE_OPTIONS', selects };

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: FromBackgroundMessage | undefined) => {
        if (chrome.runtime.lastError || response?.type !== 'OPTION_CHOICE_RESULT') {
          resolve(undefined);
          return;
        }
        resolve(validateOptionChoices(response.choices, selects));
      });
    } catch {
      resolve(undefined);
    }
  });
}

function requestClassification(fingerprints: string[]): Promise<Record<string, string> | undefined> {
  const message: ToBackgroundMessage = { type: 'CLASSIFY_FIELDS', fingerprints };

  // The callback form, not the promise one: `chrome.*` is callback-based on
  // Firefox (MV2), where the promise form would resolve to `undefined` and
  // quietly disable the feature. This never rejects — `lastError` (dead worker,
  // invalidated context) is read and turned into "no templates".
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: FromBackgroundMessage | undefined) => {
        if (chrome.runtime.lastError || response?.type !== 'CLASSIFY_RESULT') {
          resolve(undefined);
          return;
        }
        resolve(validateFieldTemplates(response.templates, fingerprints));
      });
    } catch {
      resolve(undefined);
    }
  });
}

