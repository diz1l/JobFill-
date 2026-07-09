import { defineContentScript } from 'wxt/utils/define-content-script';
import { fillPage } from '../shared/filler';
import { extractJobInfo } from '../shared/extractors';
import { getActiveProfile, getSettings, getProfiles } from '../shared/storage/sync';
import { showInlineButton, repositionButton, hideInlineButton, showToast } from '../shared/filler/inlineButton';
import type { PopupToContentMessage } from '../shared/messages';
import type { FillSummary } from '../shared/types';

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
          performFill(message.profileId).then((summary) => {
            sendResponse({ type: 'FILL_RESULT', summary });
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
    const summary = await performFill('__active__');
    if (summary) {
      const filled = summary.high + summary.medium;
      const parts: string[] = [`⚡ Filled ${filled} field${filled !== 1 ? 's' : ''}`];
      if (summary.medium > 0) parts.push(`${summary.medium} need review`);
      if (summary.fileInputs > 0) parts.push(`${summary.fileInputs} file${summary.fileInputs > 1 ? 's' : ''} attach manually`);
      if (summary.aiQuestions > 0) parts.push(`${summary.aiQuestions} open question${summary.aiQuestions > 1 ? 's' : ''} (AI)`);
      showToast(parts.join(' · '));
    }
  };

  document.addEventListener('focusin', (e) => {
    if (!isFillable(e.target)) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    currentAnchor = e.target as HTMLElement;
    showInlineButton(currentAnchor, triggerFill);
  });

  document.addEventListener('focusout', () => {
    hideTimer = setTimeout(() => {
      hideInlineButton();
      currentAnchor = null;
    }, 200);
  });

  // Keep button aligned on scroll / resize
  const reposition = () => {
    if (currentAnchor) repositionButton(currentAnchor);
  };
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });
}

// ─── Fill logic ───────────────────────────────────────────────────────────────

async function performFill(profileId: string): Promise<FillSummary | null> {
  let profile = await getActiveProfile();

  if (!profile) {
    const profiles = await getProfiles();
    profile = profiles.find((p) => p.id === profileId);
  }

  if (!profile) return null;

  const settings = await getSettings();
  return fillPage(profile, { highlightDurationMs: settings.highlightDurationMs });
}
