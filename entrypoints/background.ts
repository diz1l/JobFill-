import { defineBackground } from 'wxt/utils/define-background';
import { generateMotivation, classifyFields, answerOpenQuestions, GroqApiError } from '../shared/api/groq';
import { logToNotion } from '../shared/api/notion';
import { logToSheets } from '../shared/api/sheets';
import { getGroqApiKey, getGroqModel, getNotionCredentials, getSheetsEndpoint, appendLogEntry, updateLogEntrySync } from '../shared/storage/local';
import { getSettings, getProfiles } from '../shared/storage/sync';
import type { ToBackgroundMessage, ApiErrorKind, OpenQuestion } from '../shared/messages';
import type { ApplicationEntry, JobInfo } from '../shared/types';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener(
    (message: ToBackgroundMessage, _sender, sendResponse) => {
      if (message.type === 'GENERATE_COVER') {
        handleGenerateCover(message.jobInfo, message.profileId)
          .then(sendResponse)
          .catch(() => sendResponse({ type: 'API_ERROR', kind: 'NETWORK_ERROR', message: 'Unknown error.' }));
        return true;
      }

      if (message.type === 'ANSWER_QUESTIONS') {
        handleAnswerQuestions(message.questions, message.profileId, message.jobInfo)
          .then(sendResponse)
          .catch(() => sendResponse({ type: 'API_ERROR', kind: 'NETWORK_ERROR', message: 'Unknown error.' }));
        return true;
      }

      if (message.type === 'CLASSIFY_FIELDS') {
        handleClassifyFields(message.fingerprints)
          .then(sendResponse)
          .catch(() => sendResponse({}));
        return true;
      }

      if (message.type === 'LOG_APPLICATION') {
        handleLogApplication(message.entry)
          .then(sendResponse)
          .catch(() => sendResponse({ type: 'LOG_RESULT', success: false }));
        return true;
      }

      return false;
    },
  );
});

async function handleGenerateCover(jobInfo: JobInfo, profileId: string) {
  const apiKey = await getGroqApiKey();
  const model = await getGroqModel();

  if (!apiKey) {
    return { type: 'API_ERROR', kind: 'MISSING_KEY' as ApiErrorKind, message: 'No Groq API key.' };
  }

  const profiles = await getProfiles();
  const profile = profiles.find((p) => p.id === profileId);

  if (!profile) {
    return { type: 'API_ERROR', kind: 'NETWORK_ERROR' as ApiErrorKind, message: 'Profile not found.' };
  }

  try {
    const text = await generateMotivation(jobInfo, profile, apiKey, model);
    return { type: 'GENERATION_RESULT', text };
  } catch (err) {
    if (err instanceof GroqApiError) {
      return { type: 'API_ERROR', kind: err.kind, message: err.message };
    }
    return { type: 'API_ERROR', kind: 'NETWORK_ERROR' as ApiErrorKind, message: String(err) };
  }
}

async function handleClassifyFields(fingerprints: string[]) {
  const apiKey = await getGroqApiKey();
  const model = await getGroqModel();
  if (!apiKey) return {};

  try {
    return await classifyFields(fingerprints, apiKey, model);
  } catch {
    return {};
  }
}

async function handleLogApplication(entry: ApplicationEntry) {
  // Always write locally first
  await appendLogEntry(entry);

  const settings = await getSettings();

  if (settings.logBackend === 'off') {
    return { type: 'LOG_RESULT', success: true };
  }

  try {
    if (settings.logBackend === 'notion') {
      const { notionToken, notionDatabaseId } = await getNotionCredentials();
      if (notionToken && notionDatabaseId) {
        await logToNotion(entry, notionToken, notionDatabaseId);
        await updateLogEntrySync(entry.id, 'ok');
      }
    } else if (settings.logBackend === 'sheets') {
      const endpoint = await getSheetsEndpoint();
      if (endpoint) {
        await logToSheets(entry, endpoint);
        await updateLogEntrySync(entry.id, 'ok');
      }
    }
    return { type: 'LOG_RESULT', success: true };
  } catch {
    await updateLogEntrySync(entry.id, 'failed');
    // Surface non-blockingly — caller shows warning
    return { type: 'LOG_RESULT', success: false };
  }
}

async function handleAnswerQuestions(
  questions: OpenQuestion[],
  profileId: string,
  jobInfo: JobInfo,
) {
  const apiKey = await getGroqApiKey();
  const model = await getGroqModel();

  if (!apiKey) {
    return { type: 'API_ERROR', kind: 'MISSING_KEY' as ApiErrorKind, message: 'No Groq API key.' };
  }

  const profiles = await getProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    return { type: 'API_ERROR', kind: 'NETWORK_ERROR' as ApiErrorKind, message: 'Profile not found.' };
  }

  try {
    const questionTexts = questions.map((q) => q.text);
    const answerTexts = await answerOpenQuestions(questionTexts, profile, jobInfo, apiKey, model);

    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      answers[q.id] = answerTexts[i] ?? '';
    });

    return { type: 'ANSWERS_RESULT', answers };
  } catch (err) {
    if (err instanceof GroqApiError) {
      return { type: 'API_ERROR', kind: err.kind, message: err.message };
    }
    return { type: 'API_ERROR', kind: 'NETWORK_ERROR' as ApiErrorKind, message: String(err) };
  }
}
