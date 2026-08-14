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
import { buildFingerprint, type FieldFingerprint } from '../shared/field-matcher/fingerprint';
import {
  FRAME_REPLY,
  type FrameReplyMessage,
  type FrameRequest,
  type FromBackgroundMessage,
  type OpenQuestion,
  type ToBackgroundMessage,
} from '../shared/messages';
import type { FillSummary, Profile } from '../shared/types';

// ─── Module-level state: open question elements keyed by id ──────────────────
const pendingQuestionEls = new Map<string, HTMLTextAreaElement>();

/** Sub-frames smaller than this cannot hold an application form (ads, pixels, widgets). */
const MIN_FRAME_WIDTH = 200;
const MIN_FRAME_HEIGHT = 150;
/** Grace period before the inline button disappears after blur. */
const BUTTON_HIDE_DELAY_MS = 350;

export default defineContentScript({
  /**
   * NFR-2 asks for the narrowest possible injection surface.
   *
   * `<all_urls>` also covered `file://`, `ftp://` and every custom scheme; the
   * pair below is limited to real web pages. On top of that:
   *   - `excludeMatches` drops well-known mail / payment / identity origins that
   *     can never contain a job application form;
   *   - `excludeGlobs` drops sign-in and checkout URLs anywhere on the web;
   *   - `main()` bails out before touching the page when the frame cannot hold a
   *     form, and no page listener is registered on sign-in screens.
   *
   * The declarative registration is still what makes the inline "Fill" button
   * possible at all: it has to react to `focusin` *before* the user has any way
   * to click on the extension. See the migration notes at the bottom of this
   * file for the activeTab / `scripting.executeScript` follow-up.
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

    // The inline button is the only thing that ever touches the page. It is not
    // armed on sign-in screens at all (P0-4).
    if (!looksLikeAuthPage()) setupInlineButton(ctx);

    // NFR-4: everything we injected goes away with the page / the script.
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
 * P0-5 — frame addressing, page half.
 *
 * A request arrives as one broadcast to every frame of the tab (the caller has
 * no `frameId` to aim at, and getting one would cost the `webNavigation`
 * permission — NFR-2). Two rules make that work:
 *
 *   1. **a frame that has nothing to contribute never answers**, so silence is
 *      the normal outcome in the frames that do not own the form;
 *   2. a frame that *does* answer replies with `chrome.runtime.sendMessage`
 *      instead of `sendResponse`. Chrome gives the sender of a broadcast only
 *      the first `sendResponse` — with LinkedIn / Greenhouse / Workable the form
 *      lives in an iframe while the top frame answers "0 filled" first, and the
 *      user was told nothing had been filled. On the runtime bus every frame is
 *      heard, and the caller learns which frame spoke from `sender.frameId`.
 *
 * The listener therefore always returns `false`: nothing here ever uses the
 * response channel.
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
      // P1-12: insert only into a field we can justify, never into "the first
      // textarea on the page" (which is usually search or a chat widget).
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
    showToast(parts.join(' · '));
  };

  ctx.addEventListener(document, 'focusin', (e: FocusEvent) => {
    if (!isInlineButtonAnchor(e.target)) return;
    // Recorded while the page still has focus — opening the popup blurs it (P1-12).
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

  // Resolve cover letter template with job info placeholders
  let coverLetterText = '';
  const [templates, settings] = await Promise.all([getCoverTemplates(), getSettings()]);
  if (templates.length > 0) {
    const jobInfo = extractJobInfo();
    coverLetterText = templates[0].body
      .replace(/\{company\}/gi, jobInfo.company ?? '')
      .replace(/\{position\}/gi, jobInfo.position ?? '')
      .replace(/\{source\}/gi, '');
  }

  // FR-5.3: the fields heuristics could not name, collected during the pass that
  // is about to run — no second enumeration of the page.
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

  // Collect open-question textareas so popup can trigger Groq answering
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

// ─── FR-5.3 — LLM classification pass ─────────────────────────────────────────

/**
 * One pass per frame at a time. A second Fill click while a request is in flight
 * would classify the same fingerprints again for the same answer, so it is
 * dropped — this is also the only bound on how often the feature can spend the
 * user's Groq quota.
 */
let classificationInFlight = false;

/**
 * The second pass: ask the worker to name the leftovers, fill what comes back,
 * tell the user on the page.
 *
 * **Why the page and not the popup.** A frame answers a fill broadcast within
 * milliseconds and `entrypoints/ui/frames.ts` closes its collection window
 * 400 ms later; a classification answer arrives seconds after that, when nothing
 * is listening for this request any more. So the second pass reports where the
 * user is actually looking — the amber highlights appear on the fields as they
 * are filled, and one toast says how many there were. The popup's counters stay
 * the heuristic snapshot they always were.
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
 * S-3: `fingerprints` are `serializeFingerprint` output and nothing else — no
 * profile values, no page body, not even the controls' current contents.
 *
 * The worker owns the API key, so it makes the request; `undefined` means "no
 * classifications", which is what every failure looks like from here.
 */
function requestClassification(fingerprints: string[]): Promise<Record<string, string> | undefined> {
  const message: ToBackgroundMessage = { type: 'CLASSIFY_FIELDS', fingerprints };

  // The callback form, not the promise one: `chrome.*` is callback-based on
  // Firefox (MV2), where the promise form would resolve to `undefined` and
  // quietly disable the feature. This never rejects — `lastError` (dead worker,
  // invalidated context) is read and turned into "no classifications".
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: FromBackgroundMessage | undefined) => {
        if (chrome.runtime.lastError || response?.type !== 'CLASSIFY_RESULT') {
          resolve(undefined);
          return;
        }
        resolve(response.classifications);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/*
 * ── Follow-up: full activeTab / programmatic injection (NFR-2, option "a") ────
 *
 * Everything above still ships as a declarative content script, because the
 * inline button must exist before the user interacts with the extension. To go
 * all the way to `activeTab` + `chrome.scripting.executeScript`, three files
 * outside this stream have to change together:
 *
 *   1. entrypoints/content.ts — add `registration: 'runtime'` so WXT builds the
 *      script as an injectable asset instead of listing it in the manifest.
 *   2. entrypoints/background.ts — on `action.onClicked` / `commands.onCommand`
 *      / a popup request, call `chrome.scripting.executeScript({ target: { tabId,
 *      allFrames: true }, files: ['content-scripts/content.js'] })`, deduplicate
 *      injections per tab, and only then forward FILL_FORM.
 *   3. entrypoints/popup/App.tsx — ask the background to inject first, await it,
 *      and address the resulting frames explicitly (see below).
 *
 * The trade-off to accept with that move: the "⚡ Fill" affordance can no longer
 * appear on first focus — it would only appear after the user has opened the
 * popup (or pressed the shortcut) once per tab.
 */
