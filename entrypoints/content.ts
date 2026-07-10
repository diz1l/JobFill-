import { defineContentScript } from 'wxt/utils/define-content-script';
import { fillPage } from '../shared/filler';
import { setNativeValue } from '../shared/filler/setNativeValue';
import { extractJobInfo } from '../shared/extractors';
import { getActiveProfile, getSettings, getProfiles, getCoverTemplates } from '../shared/storage/sync';
import {
  showInlineButton,
  repositionButton,
  hideInlineButton,
  showToast,
  isInlineButtonTarget,
} from '../shared/filler/inlineButton';
import { buildFingerprint } from '../shared/field-matcher/fingerprint';
import type { PopupToContentMessage, OpenQuestion } from '../shared/messages';
import type { FillSummary } from '../shared/types';

// ─── Module-level state: open question elements keyed by id ──────────────────
const pendingQuestionEls = new Map<string, HTMLTextAreaElement>();

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    setupInlineButton();

    chrome.runtime.onMessage.addListener(
      (
        message: PopupToContentMessage,
        _sender,
        sendResponse: (response: unknown) => void,
      ) => {
        if (message.type === 'FILL_FORM') {
          performFill(message.profileId).then((result) => {
            sendResponse(result ?? { error: 'Profile not found.' });
          }).catch((err: Error) => {
            sendResponse({ error: err.message });
          });
          return true;
        }

        if (message.type === 'EXTRACT_JOB_INFO') {
          const jobInfo = extractJobInfo();
          sendResponse({ type: 'JOB_INFO', jobInfo });
          return false;
        }

        if (message.type === 'FILL_COVER_TEXT') {
          // Find the best cover letter target: highlighted field → focused textarea → first textarea
          const highlighted = document.querySelector<HTMLTextAreaElement>(
            'textarea.__jobfill-high, textarea.__jobfill-medium, textarea.__jobfill-ai',
          );
          const target =
            (document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null)
            ?? highlighted
            ?? document.querySelector<HTMLTextAreaElement>('textarea');

          if (target) {
            setNativeValue(target, message.text);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'No text field found. Click a cover letter field first.' });
          }
          return false;
        }

        if (message.type === 'FILL_ANSWERS') {
          let filled = 0;
          for (const [id, answer] of Object.entries(message.answers)) {
            const el = pendingQuestionEls.get(id);
            if (el && answer) {
              setNativeValue(el, answer);
              filled++;
            }
          }
          sendResponse({ filled });
          return false;
        }

        return false;
      },
    );
  },
});

// ─── Inline fill button ───────────────────────────────────────────────────────

function isFillable(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const excluded = ['file', 'hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'];
    return !excluded.includes((el as HTMLInputElement).type.toLowerCase());
  }
  return false;
}

function setupInlineButton() {
  let currentAnchor: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const triggerFill = async () => {
    hideInlineButton();
    const result = await performFill('__active__');
    if (!result) {
      showToast('No active profile. Open settings and choose a profile.');
      return;
    }

    const { summary } = result;
    const filled = summary.high + summary.medium;
    const parts: string[] = [`⚡ Filled ${filled} field${filled !== 1 ? 's' : ''}`];
    if (summary.medium > 0) parts.push(`${summary.medium} need review`);
    if (summary.fileInputs > 0) parts.push(`${summary.fileInputs} file${summary.fileInputs > 1 ? 's' : ''} attach manually`);
    if (summary.aiQuestions > 0) parts.push(`${summary.aiQuestions} open question${summary.aiQuestions > 1 ? 's' : ''} — use popup to answer`);
    showToast(parts.join(' · '));
  };

  document.addEventListener('focusin', (e) => {
    if (!isFillable(e.target)) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    currentAnchor = e.target as HTMLElement;
    showInlineButton(currentAnchor, triggerFill);
  });

  document.addEventListener('focusout', (e) => {
    if (isInlineButtonTarget(e.relatedTarget)) return;
    hideTimer = setTimeout(() => {
      hideInlineButton();
      currentAnchor = null;
    }, 350);
  });

  const reposition = () => {
    if (currentAnchor) repositionButton(currentAnchor);
  };
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });
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

  const summary = fillPage(profile, {
    highlightDurationMs: settings.highlightDurationMs,
    coverLetterText,
  });

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

