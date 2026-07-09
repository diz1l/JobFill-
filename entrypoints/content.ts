import { defineContentScript } from 'wxt/utils/define-content-script';
import { fillPage } from '../shared/filler';
import { extractJobInfo } from '../shared/extractors';
import { getActiveProfile, getSettings } from '../shared/storage/sync';
import type { PopupToContentMessage } from '../shared/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    chrome.runtime.onMessage.addListener(
      (
        message: PopupToContentMessage,
        _sender,
        sendResponse: (response: unknown) => void,
      ) => {
        if (message.type === 'FILL_FORM') {
          handleFill(message.profileId).then(sendResponse).catch((err: Error) => {
            sendResponse({ error: err.message });
          });
          return true; // async
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

async function handleFill(profileId: string) {
  // Resolve which profile to use
  let profile =
    profileId !== '__active__'
      ? (await getActiveProfile()) // fallback
      : await getActiveProfile();

  if (!profile) {
    // Try by explicit profileId
    const { getProfiles } = await import('../shared/storage/sync');
    const profiles = await getProfiles();
    profile = profiles.find((p) => p.id === profileId);
  }

  if (!profile) {
    return { type: 'FILL_RESULT', summary: null, error: 'Profile not found.' };
  }

  const settings = await getSettings();
  const summary = fillPage(profile, { highlightDurationMs: settings.highlightDurationMs });
  return { type: 'FILL_RESULT', summary };
}
