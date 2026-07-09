import type { JobInfo, Profile } from '../types';
import type { ApiErrorKind } from '../messages';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 15_000;

export class GroqApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GroqApiError';
  }
}

interface GroqResponse {
  choices: Array<{ message: { content: string } }>;
}

export async function generateMotivation(
  jobInfo: JobInfo,
  profile: Profile,
  apiKey: string,
  model: string,
): Promise<string> {
  if (!apiKey) {
    throw new GroqApiError('MISSING_KEY', 'Groq API key is not configured.');
  }

  const language = detectLanguage(jobInfo.description);

  const systemPrompt = `You are an assistant that writes concise, professional job application motivation paragraphs.
Write 3-5 sentences in ${language}. Be specific to the role and company. Do not use generic filler phrases.
Return only the paragraph — no preamble, no markdown.`;

  const userPrompt = `Job title: ${jobInfo.position ?? 'unknown'}
Company: ${jobInfo.company ?? 'unknown'}
Job description (excerpt): ${(jobInfo.description ?? '').slice(0, 800)}

Applicant summary: ${profile.about || `${profile.firstName} ${profile.lastName}`}
Skills: (derived from profile summary above)

Write a motivation paragraph.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new GroqApiError('TIMEOUT', 'Request timed out after 15 s.');
    }
    throw new GroqApiError('NETWORK_ERROR', `Network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new GroqApiError('UNAUTHORIZED', 'Invalid or expired Groq API key.');
  }
  if (response.status === 429) {
    throw new GroqApiError('RATE_LIMITED', 'Groq rate limit exceeded.');
  }
  if (!response.ok) {
    throw new GroqApiError('NETWORK_ERROR', `Groq API error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as GroqResponse;
  return data.choices[0]?.message.content?.trim() ?? '';
}

/**
 * Classify field fingerprints via LLM — optional feature flag (FR-5.3).
 * Sends only serialized fingerprint strings — no user data.
 */
export async function classifyFields(
  fingerprints: string[],
  apiKey: string,
  model: string,
): Promise<Record<string, string>> {
  if (!apiKey) {
    throw new GroqApiError('MISSING_KEY', 'Groq API key is not configured.');
  }

  const prompt = `You are a JSON API. Classify each HTML form field fingerprint by type.
Field types: firstName, lastName, fullName, email, phone, linkedin, github, website, salary, city, coverLetter, availability, workPermit, about, unknown.
Respond ONLY with a JSON object mapping each input fingerprint to its type.

Fingerprints:
${fingerprints.map((f, i) => `${i}: "${f}"`).join('\n')}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new GroqApiError('TIMEOUT', 'Request timed out.');
    }
    throw new GroqApiError('NETWORK_ERROR', `Network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new GroqApiError('NETWORK_ERROR', `Groq API error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as GroqResponse;
  const raw = data.choices[0]?.message.content ?? '{}';

  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    // On invalid JSON, return empty — fields remain unclassified (FR-5.3)
    return {};
  }
}

function detectLanguage(text?: string): string {
  if (!text) return 'English';
  const czechIndicators = /[áčďéěíňóřšťúůžÁČĎÉĚÍŇÓŘŠŤÚŮŽ]/;
  return czechIndicators.test(text) ? 'Czech' : 'English';
}

/**
 * Generate answers to open-ended job application questions (FR-5.2 extension).
 * Returns an array of answer strings aligned with the input questions array.
 */
export async function answerOpenQuestions(
  questions: string[],
  profile: Profile,
  jobInfo: JobInfo,
  apiKey: string,
  model: string,
): Promise<string[]> {
  if (!apiKey) throw new GroqApiError('MISSING_KEY', 'Groq API key is not configured.');
  if (questions.length === 0) return [];

  const language = detectLanguage(jobInfo.description ?? questions.join(' '));

  const systemPrompt = `You are a job application assistant. Answer each application question concisely and professionally in ${language}.
Respond ONLY with a JSON array of strings — one answer per question, in the same order.
Each answer should be 1–3 sentences. Tailor each answer to the applicant's experience and the role.`;

  const userPrompt = `Role: ${jobInfo.position ?? 'Software Engineer'}
Company: ${jobInfo.company ?? 'the company'}
Applicant profile: ${profile.about || `${profile.firstName} ${profile.lastName}`}

Questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Respond with a JSON array: ["answer to q1", "answer to q2", ...]`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 800,
        temperature: 0.6,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new GroqApiError('TIMEOUT', 'Request timed out.');
    throw new GroqApiError('NETWORK_ERROR', `Network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) throw new GroqApiError('UNAUTHORIZED', 'Invalid Groq API key.');
  if (response.status === 429) throw new GroqApiError('RATE_LIMITED', 'Groq rate limit exceeded.');
  if (!response.ok) throw new GroqApiError('NETWORK_ERROR', `Groq API error: HTTP ${response.status}`);

  const data = (await response.json()) as GroqResponse;
  const raw = data.choices[0]?.message.content ?? '[]';

  try {
    // Groq json_object mode wraps arrays — handle both {"answers": [...]} and [...]
    const parsed = JSON.parse(raw);
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed.answers ?? parsed.responses ?? Object.values(parsed));
    return questions.map((_, i) => (typeof arr[i] === 'string' ? (arr[i] as string) : ''));
  } catch {
    return questions.map(() => '');
  }
}
