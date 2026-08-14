/**
 * Optional host permissions for the selected LLM provider.
 *
 * Every entry in `host_permissions` is a line in the install dialog that every
 * user accepts forever, including those who will only ever talk to Groq — adding
 * OpenRouter, OpenAI and Together there makes four people pay for a choice one of
 * them makes. So the extra origins live in `optional_host_permissions` and are
 * requested when the choice is made: Chrome demands a user gesture, which the
 * provider dropdown supplies, and the prompt names exactly one host.
 *
 * Everything here degrades to "assume it is granted": `chrome.permissions` does
 * not exist in tests, and where the origin sits in `host_permissions` (Groq
 * today) `contains` answers true without a prompt. Neither may block the form.
 */

/** The API surface used, narrowed so a missing `chrome.permissions` is typed. */
interface PermissionsApi {
  contains(p: { origins: string[] }): Promise<boolean>;
  request(p: { origins: string[] }): Promise<boolean>;
}

function api(): PermissionsApi | null {
  const perms = (chrome as { permissions?: Partial<PermissionsApi> } | undefined)?.permissions;
  return perms && typeof perms.contains === 'function' && typeof perms.request === 'function'
    ? (perms as PermissionsApi)
    : null;
}

/**
 * `true` when JobFill may already talk to this origin. A missing API or a thrown
 * call also answers `true`: this only decides whether a "Grant access" button is
 * shown, and a button that appears because a *check* failed would be a permanent,
 * unfixable prompt.
 */
export async function hasHostAccess(origin: string | null): Promise<boolean> {
  const perms = api();
  if (!perms || !origin) return true;
  try {
    const granted: unknown = await perms.contains({ origins: [origin] });
    // Firefox's MV2 `chrome.permissions` is callback-based and resolves to
    // `undefined`. That is not a "no", and treating it as one would put a
    // permanent, unanswerable button on the page.
    return typeof granted === 'boolean' ? granted : true;
  } catch {
    return true;
  }
}

/** Ask for the origin. `false` means the user said no, or could not be asked. */
export async function requestHostAccess(origin: string | null): Promise<boolean> {
  const perms = api();
  if (!perms || !origin) return true;
  try {
    return await perms.request({ origins: [origin] });
  } catch {
    return false;
  }
}
