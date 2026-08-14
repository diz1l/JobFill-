/**
 * Which OpenAI-compatible endpoint the LLM calls go to.
 *
 * The first person to configure this extension pasted an openrouter.ai key into
 * a field labelled "API key" and was told, accurately and uselessly, that "Groq
 * rejected this key. Groq said: Invalid API Key". The key was perfectly valid —
 * just a key for a different company, sent to `api.groq.com`, whose URL was
 * hard-coded three modules away with no way to see or change it. Two things
 * follow, and both are here:
 *
 *   1. **The base URL is configuration, not a constant.** Groq, OpenRouter,
 *      OpenAI and Together speak the same protocol — `POST /chat/completions`
 *      and `GET /models`, same body, same error envelope — so a hostname and a
 *      default model id is all this module encodes, and nothing in `groq.ts`
 *      becomes provider-specific.
 *   2. **A foreign key is recognised before the request, not after it.** Every
 *      provider stamps its keys with a prefix, so `sk-or-v1-…` in a field
 *      configured for Groq is knowable locally and instantly. See
 *      {@link identifyKeyOrigin}.
 *
 * No stored provider means Groq, with the URL and default model it always had,
 * so an existing install needs no migration step.
 */

/** Providers the UI offers by name. `custom` is any other compatible endpoint. */
export type ProviderId = 'groq' | 'openrouter' | 'openai' | 'together' | 'custom';

export interface Provider {
  id: ProviderId;
  /** Name in the dropdown. */
  label: string;
  /**
   * Name inside a sentence, which is not always the same string.
   * "Asks Other (OpenAI-compatible) which models it serves" is not English;
   * "Asks your endpoint which models it serves" is.
   */
  inSentence: string;
  /**
   * OpenAI-compatible base, no trailing slash: `${baseUrl}/chat/completions`
   * and `${baseUrl}/models` must both be valid. Empty for `custom`, where the
   * user supplies it.
   */
  baseUrl: string;
  defaultModel: string;
  /** Where a key for this provider is issued — quoted verbatim in the UI. */
  keysUrl: string;
  /** Shown under the Model field; model naming differs sharply per provider. */
  modelHint: string;
  /**
   * What `GET /models` answers with. `account` — the models this key may use
   * (Groq, OpenAI): short, every entry a valid choice, worth rendering whole.
   * `catalogue` — every model the service brokers, hundreds of them regardless
   * of the key (OpenRouter, Together); rendering that as pills would be a wall,
   * so the UI uses it to *verify* the configured id and suggest near matches.
   */
  catalogue: 'account' | 'catalogue';
  /** Where a human browses the model list when it is too long to show. */
  modelsPageUrl?: string;
  /** Extra request headers. See the note on OpenRouter below. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * OpenRouter asks for `HTTP-Referer` and `X-Title` to identify the calling app.
 * `X-Title` is sent — it is a name, it is true, and it is what shows up on their
 * side. `HTTP-Referer` deliberately is not: from an extension the only honest
 * value is `chrome-extension://<id>`, an installation-specific identifier that
 * has no business travelling with every request, and anything else would be an
 * invented URL. Both are optional; requests without them are served normally.
 */
const OPENROUTER_HEADERS = { 'X-Title': 'JobFill' } as const;

export const PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    inSentence: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keysUrl: 'https://console.groq.com/keys',
    modelHint: 'A plain model id, e.g. llama-3.3-70b-versatile. Groq retires models — check below if letters stop working.',
    catalogue: 'account',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    inSentence: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    keysUrl: 'https://openrouter.ai/keys',
    modelHint: 'Vendor-prefixed, e.g. meta-llama/llama-3.3-70b-instruct. A Groq model id will not work here.',
    catalogue: 'catalogue',
    modelsPageUrl: 'https://openrouter.ai/models',
    headers: OPENROUTER_HEADERS,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    inSentence: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keysUrl: 'https://platform.openai.com/api-keys',
    modelHint: 'A plain model id, e.g. gpt-4o-mini.',
    catalogue: 'account',
  },
  together: {
    id: 'together',
    label: 'Together AI',
    inSentence: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keysUrl: 'https://api.together.xyz/settings/api-keys',
    modelHint: 'Vendor-prefixed, e.g. meta-llama/Llama-3.3-70B-Instruct-Turbo.',
    catalogue: 'catalogue',
    modelsPageUrl: 'https://api.together.xyz/models',
  },
  custom: {
    id: 'custom',
    label: 'Other (OpenAI-compatible)',
    inSentence: 'your endpoint',
    baseUrl: '',
    defaultModel: '',
    keysUrl: '',
    modelHint: 'Whatever id your endpoint serves.',
    catalogue: 'catalogue',
  },
};

/** The order the dropdown lists them in. */
export const PROVIDER_IDS: readonly ProviderId[] = [
  'groq',
  'openrouter',
  'openai',
  'together',
  'custom',
];

/** Groq is the answer for `undefined`, for junk, and for anything unknown. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'groq';

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}

/**
 * Never throws and never returns `undefined`: a settings read that cannot say
 * which provider is configured has to keep filling forms, and the only
 * behaviour that surprises nobody is the one from before this file existed.
 */
export function providerOf(id: unknown): Provider {
  return isProviderId(id) ? PROVIDERS[id] : PROVIDERS[DEFAULT_PROVIDER_ID];
}

// ─── Base URL ────────────────────────────────────────────────────────────────

/** Trailing slashes, and the `/chat/completions` people paste by mistake. */
export function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Why this URL cannot be used, or `undefined` when it can.
 *
 * A base URL becomes the target of an authenticated request carrying the user's
 * key, so it is checked before it is stored rather than after it fails:
 *
 *   - it must parse, and be `https:` — a key sent over plaintext is a key given
 *     away, and no provider requires it;
 *   - no embedded credentials (`https://user:pass@host`), a classic way to make
 *     a hostile host look like a familiar one;
 *   - no query or fragment: everything after the path is appended by us, so
 *     anything there would silently end up mid-URL.
 *
 * The host is deliberately *not* checked — restricting it to a list would defeat
 * the point of the option. What limits a hostile value is the permission model:
 * the origin must be granted before any request can be made (see
 * {@link originPattern}).
 */
export function validateBaseUrl(raw: string): string | undefined {
  const value = normalizeBaseUrl(raw);
  if (!value) return 'No API URL — paste the base URL of an OpenAI-compatible endpoint.';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'That is not a valid URL. It should look like https://example.com/v1.';
  }

  if (url.protocol !== 'https:') return 'The API URL must start with https:// — a key sent over http is a key given away.';
  if (url.username || url.password) return 'Remove the username and password from the URL.';
  if (url.search || url.hash) return 'Remove everything after the path — JobFill appends /chat/completions itself.';
  if (!url.hostname) return 'That URL has no host.';

  return undefined;
}

/** `https://api.groq.com/openai/v1` → `https://api.groq.com/*`, for permissions. */
export function originPattern(baseUrl: string): string | null {
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch {
    return null;
  }
}

/**
 * The endpoint a provider + user configuration resolves to.
 *
 * `custom` is the only case where the stored URL is used; for a named provider
 * the built-in URL wins, so a stale custom value left behind by switching
 * providers can never redirect a request.
 */
export function resolveBaseUrl(provider: Provider, customBaseUrl?: string): string {
  if (provider.id !== 'custom') return provider.baseUrl;
  return normalizeBaseUrl(customBaseUrl ?? '');
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl}/chat/completions`;
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl}/models`;
}

// ─── The resolved connection ─────────────────────────────────────────────────

/**
 * Everything one request needs to know about where it is going. Passed
 * explicitly rather than read from storage inside the client, so "Check key" can
 * probe credentials the user has *typed* but not saved.
 */
export interface LlmEndpoint {
  providerId: ProviderId;
  /** Human name of the provider *as it reads in a sentence* — every error uses it. */
  label: string;
  /** Resolved base URL, no trailing slash. Empty means "not configured". */
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Readonly<Record<string, string>>;
}

/**
 * Build an endpoint out of whatever is stored or typed, filling every gap with
 * the selected provider's defaults.
 *
 * The model default is per provider on purpose: a Groq id (`llama-3.3-70b-versatile`)
 * is not an OpenRouter id (`meta-llama/llama-3.3-70b-instruct`), and carrying one
 * over on a provider switch produces a 404 that reads like a broken key.
 */
export function buildEndpoint(input: {
  providerId?: unknown;
  apiKey?: string;
  model?: string;
  customBaseUrl?: string;
}): LlmEndpoint {
  const provider = providerOf(input.providerId);
  return {
    providerId: provider.id,
    label: provider.inSentence,
    baseUrl: resolveBaseUrl(provider, input.customBaseUrl),
    apiKey: (input.apiKey ?? '').trim(),
    model: (input.model ?? '').trim() || provider.defaultModel,
    ...(provider.headers ? { headers: provider.headers } : {}),
  };
}

// ─── Key origin ──────────────────────────────────────────────────────────────

/**
 * A service whose keys we can recognise — including services we do not support,
 * because "this is an Anthropic key and none of these providers take it" is a
 * more useful sentence than silence.
 */
export interface KeyOrigin {
  /** Provider id when we support it; otherwise a bare name. */
  id: ProviderId | 'anthropic';
  label: string;
}

/**
 * Prefixes, longest first — `sk-or-v1-`, `sk-ant-` and `sk-proj-` all start with
 * `sk-`, so order is the whole correctness argument here.
 */
const KEY_PREFIXES: ReadonlyArray<{ prefix: string; origin: KeyOrigin }> = [
  { prefix: 'sk-or-v1-', origin: { id: 'openrouter', label: 'OpenRouter' } },
  { prefix: 'sk-ant-', origin: { id: 'anthropic', label: 'Anthropic' } },
  { prefix: 'sk-proj-', origin: { id: 'openai', label: 'OpenAI' } },
  { prefix: 'gsk_', origin: { id: 'groq', label: 'Groq' } },
  { prefix: 'sk-', origin: { id: 'openai', label: 'OpenAI' } },
];

/**
 * Which service issued this key, as far as its prefix can tell.
 *
 * `null` means "no idea", which is a normal answer: Together's keys are bare
 * hex, and a self-hosted endpoint's key can be anything. Absence of a prefix is
 * never evidence of a problem, so it never produces a warning.
 */
export function identifyKeyOrigin(key: string): KeyOrigin | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  for (const { prefix, origin } of KEY_PREFIXES) {
    if (trimmed.startsWith(prefix)) return origin;
  }
  return null;
}

/** "a Groq key" / "an OpenRouter key" — the sentence is read by a human. */
function article(name: string): string {
  return /^[aeiou]/i.test(name) ? 'an' : 'a';
}

/**
 * The sentence the first user of this extension needed, and did not get.
 *
 * Returned *before* any request is made, so the answer arrives at paste time
 * rather than after a round-trip that can only ever say "invalid key". `null`
 * when the key looks right for the selected provider, or when its origin is
 * unknown — a guess would be worse than nothing, because the user would have to
 * disprove it.
 */
export function keyProviderMismatch(providerId: ProviderId, key: string): string | null {
  const origin = identifyKeyOrigin(key);
  if (!origin) return null;

  const selected = providerOf(providerId);
  // `custom` accepts any key: we cannot know what a self-hosted endpoint wants,
  // and a proxy that forwards to OpenAI legitimately takes an OpenAI key.
  if (selected.id === 'custom') return null;
  if (origin.id === selected.id) return null;

  const supported = origin.id !== 'anthropic' ? PROVIDERS[origin.id] : null;
  const mine = `${article(selected.label)} ${selected.label} key from ${selected.keysUrl}`;
  const fix = supported
    ? `Switch Provider to ${supported.label}, or paste ${mine}.`
    : `${origin.label} is not an OpenAI-compatible provider JobFill can use. Paste ${mine}.`;

  return `This looks like ${article(origin.label)} ${origin.label} key, but the selected provider is ${selected.label}. ${fix}`;
}
