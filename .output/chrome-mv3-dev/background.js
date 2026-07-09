var background = (function() {
  "use strict";
  var _a;
  function defineBackground(arg) {
    if (arg == null || typeof arg === "function") return { main: arg };
    return arg;
  }
  const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
  const TIMEOUT_MS = 15e3;
  class GroqApiError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
      this.name = "GroqApiError";
    }
    kind;
  }
  async function generateMotivation(jobInfo, profile, apiKey, model) {
    if (!apiKey) {
      throw new GroqApiError("MISSING_KEY", "Groq API key is not configured.");
    }
    const language = detectLanguage(jobInfo.description);
    const systemPrompt = `You are an assistant that writes concise, professional job application motivation paragraphs.
Write 3-5 sentences in ${language}. Be specific to the role and company. Do not use generic filler phrases.
Return only the paragraph — no preamble, no markdown.`;
    const userPrompt = `Job title: ${jobInfo.position ?? "unknown"}
Company: ${jobInfo.company ?? "unknown"}
Job description (excerpt): ${(jobInfo.description ?? "").slice(0, 800)}

Applicant summary: ${profile.about || `${profile.firstName} ${profile.lastName}`}
Skills: (derived from profile summary above)

Write a motivation paragraph.`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          max_tokens: 300,
          temperature: 0.7
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new GroqApiError("TIMEOUT", "Request timed out after 15 s.");
      }
      throw new GroqApiError("NETWORK_ERROR", `Network error: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401) {
      throw new GroqApiError("UNAUTHORIZED", "Invalid or expired Groq API key.");
    }
    if (response.status === 429) {
      throw new GroqApiError("RATE_LIMITED", "Groq rate limit exceeded.");
    }
    if (!response.ok) {
      throw new GroqApiError("NETWORK_ERROR", `Groq API error: HTTP ${response.status}`);
    }
    const data = await response.json();
    return data.choices[0]?.message.content?.trim() ?? "";
  }
  async function classifyFields(fingerprints, apiKey, model) {
    if (!apiKey) {
      throw new GroqApiError("MISSING_KEY", "Groq API key is not configured.");
    }
    const prompt = `You are a JSON API. Classify each HTML form field fingerprint by type.
Field types: firstName, lastName, fullName, email, phone, linkedin, github, website, salary, city, coverLetter, availability, workPermit, about, unknown.
Respond ONLY with a JSON object mapping each input fingerprint to its type.

Fingerprints:
${fingerprints.map((f, i) => `${i}: "${f}"`).join("\n")}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 500,
          temperature: 0,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new GroqApiError("TIMEOUT", "Request timed out.");
      }
      throw new GroqApiError("NETWORK_ERROR", `Network error: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new GroqApiError("NETWORK_ERROR", `Groq API error: HTTP ${response.status}`);
    }
    const data = await response.json();
    const raw = data.choices[0]?.message.content ?? "{}";
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  function detectLanguage(text) {
    if (!text) return "English";
    const czechIndicators = /[áčďéěíňóřšťúůžÁČĎÉĚÍŇÓŘŠŤÚŮŽ]/;
    return czechIndicators.test(text) ? "Czech" : "English";
  }
  const NOTION_API = "https://api.notion.com/v1";
  const NOTION_VERSION = "2022-06-28";
  async function logToNotion(entry, token, databaseId) {
    const response = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: {
          Name: { title: [{ text: { content: entry.position || "Unknown position" } }] },
          Company: { rich_text: [{ text: { content: entry.company || "" } }] },
          URL: { url: entry.url },
          Date: { date: { start: entry.timestamp } },
          Status: { select: { name: entry.status } },
          Profile: { rich_text: [{ text: { content: entry.profileId } }] }
        }
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Notion API error ${response.status}: ${body.slice(0, 200)}`);
    }
  }
  async function logToSheets(entry, endpoint) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      redirect: "follow"
      // Apps Script Web Apps often redirect
    });
    if (!response.ok) {
      throw new Error(`Sheets endpoint error: HTTP ${response.status}`);
    }
  }
  const KEYS = {
    groqApiKey: "groq_api_key",
    groqModel: "groq_model",
    notionToken: "notion_token",
    notionDatabaseId: "notion_db_id",
    sheetsEndpoint: "sheets_endpoint",
    applicationLog: "application_log"
  };
  async function getGroqApiKey() {
    const r = await chrome.storage.local.get(KEYS.groqApiKey);
    return r[KEYS.groqApiKey];
  }
  async function getGroqModel() {
    const r = await chrome.storage.local.get(KEYS.groqModel);
    return r[KEYS.groqModel] ?? "llama-3.3-70b-versatile";
  }
  async function getNotionCredentials() {
    const r = await chrome.storage.local.get([KEYS.notionToken, KEYS.notionDatabaseId]);
    return {
      notionToken: r[KEYS.notionToken],
      notionDatabaseId: r[KEYS.notionDatabaseId]
    };
  }
  async function getSheetsEndpoint() {
    const r = await chrome.storage.local.get(KEYS.sheetsEndpoint);
    return r[KEYS.sheetsEndpoint];
  }
  async function getApplicationLog() {
    const r = await chrome.storage.local.get(KEYS.applicationLog);
    return r[KEYS.applicationLog] ?? [];
  }
  async function appendLogEntry(entry) {
    const log = await getApplicationLog();
    log.unshift(entry);
    if (log.length > 500) log.splice(500);
    await chrome.storage.local.set({ [KEYS.applicationLog]: log });
  }
  async function updateLogEntrySync(id, remoteSync) {
    const log = await getApplicationLog();
    const entry = log.find((e) => e.id === id);
    if (entry) {
      entry.remoteSync = remoteSync;
      await chrome.storage.local.set({ [KEYS.applicationLog]: log });
    }
  }
  const DEFAULT_SETTINGS = {
    highlightDurationMs: 3e3,
    logBackend: "off"
  };
  const DEFAULT_SYNC_DATA = {
    schemaVersion: 1,
    profiles: [],
    activeProfileId: "",
    coverTemplates: [],
    settings: DEFAULT_SETTINGS
  };
  const STORAGE_KEY = "jobfill_sync";
  async function getSyncData() {
    const result2 = await chrome.storage.sync.get(STORAGE_KEY);
    return { ...DEFAULT_SYNC_DATA, ...result2[STORAGE_KEY] };
  }
  async function getProfiles() {
    return (await getSyncData()).profiles;
  }
  async function getSettings() {
    return (await getSyncData()).settings;
  }
  const definition = defineBackground(() => {
    chrome.runtime.onMessage.addListener(
      (message, _sender, sendResponse) => {
        if (message.type === "GENERATE_COVER") {
          handleGenerateCover(message.jobInfo, message.profileId).then(sendResponse).catch(() => sendResponse({ type: "API_ERROR", kind: "NETWORK_ERROR", message: "Unknown error." }));
          return true;
        }
        if (message.type === "CLASSIFY_FIELDS") {
          handleClassifyFields(message.fingerprints).then(sendResponse).catch(() => sendResponse({}));
          return true;
        }
        if (message.type === "LOG_APPLICATION") {
          handleLogApplication(message.entry).then(sendResponse).catch(() => sendResponse({ type: "LOG_RESULT", success: false }));
          return true;
        }
        return false;
      }
    );
  });
  async function handleGenerateCover(jobInfo, profileId) {
    const apiKey = await getGroqApiKey();
    const model = await getGroqModel();
    if (!apiKey) {
      return { type: "API_ERROR", kind: "MISSING_KEY", message: "No Groq API key." };
    }
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      return { type: "API_ERROR", kind: "NETWORK_ERROR", message: "Profile not found." };
    }
    try {
      const text = await generateMotivation(jobInfo, profile, apiKey, model);
      return { type: "GENERATION_RESULT", text };
    } catch (err) {
      if (err instanceof GroqApiError) {
        return { type: "API_ERROR", kind: err.kind, message: err.message };
      }
      return { type: "API_ERROR", kind: "NETWORK_ERROR", message: String(err) };
    }
  }
  async function handleClassifyFields(fingerprints) {
    const apiKey = await getGroqApiKey();
    const model = await getGroqModel();
    if (!apiKey) return {};
    try {
      return await classifyFields(fingerprints, apiKey, model);
    } catch {
      return {};
    }
  }
  async function handleLogApplication(entry) {
    await appendLogEntry(entry);
    const settings = await getSettings();
    if (settings.logBackend === "off") {
      return { type: "LOG_RESULT", success: true };
    }
    try {
      if (settings.logBackend === "notion") {
        const { notionToken, notionDatabaseId } = await getNotionCredentials();
        if (notionToken && notionDatabaseId) {
          await logToNotion(entry, notionToken, notionDatabaseId);
          await updateLogEntrySync(entry.id, "ok");
        }
      } else if (settings.logBackend === "sheets") {
        const endpoint = await getSheetsEndpoint();
        if (endpoint) {
          await logToSheets(entry, endpoint);
          await updateLogEntrySync(entry.id, "ok");
        }
      }
      return { type: "LOG_RESULT", success: true };
    } catch {
      await updateLogEntrySync(entry.id, "failed");
      return { type: "LOG_RESULT", success: false };
    }
  }
  function initPlugins() {
  }
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  var MatchPattern = (_a = class {
    /**
    * Parse a match pattern string. If it is invalid, the constructor will throw an
    * `InvalidMatchPattern` error.
    *
    * @param matchPattern The match pattern to parse.
    */
    constructor(matchPattern) {
      if (matchPattern === "<all_urls>") {
        this.isAllUrls = true;
        this.protocolMatches = [..._a.PROTOCOLS];
        this.hostnameMatch = "*";
        this.pathnameMatch = "*";
      } else {
        const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
        if (groups == null) throw new InvalidMatchPattern(matchPattern, "Incorrect format");
        const [_, protocol, hostname, pathname] = groups;
        validateProtocol(matchPattern, protocol);
        validateHostname(matchPattern, hostname);
        this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
        this.hostnameMatch = hostname;
        this.pathnameMatch = pathname;
      }
    }
    /** Check if a URL is included in a pattern. */
    includes(url) {
      const u = typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
      if (this.isAllUrls) return !this.isUnknownProtocol(u);
      return !!this.protocolMatches.find((protocol) => {
        if (protocol === "http") return this.isHttpMatch(u);
        if (protocol === "https") return this.isHttpsMatch(u);
        if (protocol === "file") return this.isFileMatch(u);
        if (protocol === "ftp") return this.isFtpMatch(u);
        if (protocol === "urn") return this.isUrnMatch(u);
      });
    }
    isHttpMatch(url) {
      return url.protocol === "http:" && this.isHostPathMatch(url);
    }
    isHttpsMatch(url) {
      return url.protocol === "https:" && this.isHostPathMatch(url);
    }
    isHostPathMatch(url) {
      if (!this.hostnameMatch || !this.pathnameMatch) return false;
      const hostnameMatchRegexs = [this.convertPatternToRegex(this.hostnameMatch), this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, ""))];
      const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
      return !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) && pathnameMatchRegex.test(url.pathname);
    }
    isUnknownProtocol(url) {
      return !this.protocolMatches.includes(url.protocol.slice(0, -1));
    }
    isPathMatch(url) {
      if (!this.pathnameMatch) return false;
      return this.convertPatternToRegex(this.pathnameMatch).test(url.pathname);
    }
    isFileMatch(url) {
      return url.protocol === "file:" && this.isPathMatch(url);
    }
    isFtpMatch(_url) {
      throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
    }
    isUrnMatch(_url) {
      throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
    }
    convertPatternToRegex(pattern) {
      const starsReplaced = this.escapeForRegex(pattern).replace(/\\\*/g, ".*");
      return RegExp(`^${starsReplaced}$`);
    }
    escapeForRegex(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }, _a.PROTOCOLS = [
    "http",
    "https",
    "file",
    "ftp",
    "urn",
    "ws",
    "wss"
  ], _a);
  var InvalidMatchPattern = class extends Error {
    constructor(matchPattern, reason) {
      super(`Invalid match pattern "${matchPattern}": ${reason}`);
    }
  };
  function validateProtocol(matchPattern, protocol) {
    if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*") throw new InvalidMatchPattern(matchPattern, `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`);
  }
  function validateHostname(matchPattern, hostname) {
    if (hostname.includes(":")) throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
    if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*.")) throw new InvalidMatchPattern(matchPattern, `If using a wildcard (*), it must go at the start of the hostname`);
  }
  function print(method, ...args) {
    if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
    else method("[wxt]", ...args);
  }
  const logger = {
    debug: (...args) => print(console.debug, ...args),
    log: (...args) => print(console.log, ...args),
    warn: (...args) => print(console.warn, ...args),
    error: (...args) => print(console.error, ...args)
  };
  let ws;
  function getDevServerWebSocket() {
    if (ws == null) {
      const serverUrl = "ws://localhost:3000";
      logger.debug("Connecting to dev server @", serverUrl);
      ws = new WebSocket(serverUrl, "vite-hmr");
      ws.addWxtEventListener = ws.addEventListener.bind(ws);
      ws.sendCustom = (event, payload) => ws?.send(JSON.stringify({
        type: "custom",
        event,
        payload
      }));
      ws.addEventListener("open", () => {
        logger.debug("Connected to dev server");
      });
      ws.addEventListener("close", () => {
        logger.debug("Disconnected from dev server");
      });
      ws.addEventListener("error", (event) => {
        logger.error("Failed to connect to dev server", event);
      });
      ws.addEventListener("message", (e) => {
        try {
          const message = JSON.parse(e.data);
          if (message.type === "custom") ws?.dispatchEvent(new CustomEvent(message.event, { detail: message.data }));
        } catch (err) {
          logger.error("Failed to handle message", err);
        }
      });
    }
    return ws;
  }
  function keepServiceWorkerAlive() {
    setInterval(async () => {
      await browser.runtime.getPlatformInfo();
    }, 5e3);
  }
  function reloadContentScript(payload) {
    if (browser.runtime.getManifest().manifest_version == 2) reloadContentScriptMv2();
    else reloadContentScriptMv3(payload);
  }
  async function reloadContentScriptMv3({ registration, contentScript }) {
    if (registration === "runtime") await reloadRuntimeContentScriptMv3(contentScript);
    else await reloadManifestContentScriptMv3(contentScript);
  }
  async function reloadManifestContentScriptMv3(contentScript) {
    const id = `wxt:${contentScript.js[0]}`;
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const existing = registered.find((cs) => cs.id === id);
    if (existing) {
      logger.debug("Updating content script", existing);
      await browser.scripting.updateContentScripts([{
        ...contentScript,
        id,
        css: contentScript.css ?? []
      }]);
    } else {
      logger.debug("Registering new content script...");
      await browser.scripting.registerContentScripts([{
        ...contentScript,
        id,
        css: contentScript.css ?? []
      }]);
    }
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadRuntimeContentScriptMv3(contentScript) {
    logger.log("Reloading content script:", contentScript);
    const registered = await browser.scripting.getRegisteredContentScripts();
    logger.debug("Existing scripts:", registered);
    const matches = registered.filter((cs) => {
      const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
      const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
      return hasJs || hasCss;
    });
    if (matches.length === 0) {
      logger.log("Content script is not registered yet, nothing to reload", contentScript);
      return;
    }
    await browser.scripting.updateContentScripts(matches);
    await reloadTabsForContentScript(contentScript);
  }
  async function reloadTabsForContentScript(contentScript) {
    const allTabs = await browser.tabs.query({});
    const matchPatterns = contentScript.matches.map((match) => new MatchPattern(match));
    const matchingTabs = allTabs.filter((tab) => {
      const url = tab.url;
      if (!url) return false;
      return !!matchPatterns.find((pattern) => pattern.includes(url));
    });
    await Promise.all(matchingTabs.map(async (tab) => {
      try {
        await browser.tabs.reload(tab.id);
      } catch (err) {
        logger.warn("Failed to reload tab:", err);
      }
    }));
  }
  async function reloadContentScriptMv2(_payload) {
    throw Error("TODO: reloadContentScriptMv2");
  }
  {
    try {
      const ws2 = getDevServerWebSocket();
      ws2.addWxtEventListener("wxt:reload-extension", () => {
        browser.runtime.reload();
      });
      ws2.addWxtEventListener("wxt:reload-content-script", (event) => {
        reloadContentScript(event.detail);
      });
      if (true) {
        ws2.addEventListener("open", () => ws2.sendCustom("wxt:background-initialized"));
        keepServiceWorkerAlive();
      }
    } catch (err) {
      logger.error("Failed to setup web socket connection with dev server", err);
    }
    browser.commands.onCommand.addListener((command) => {
      if (command === "wxt:reload-extension") browser.runtime.reload();
    });
  }
  let result;
  try {
    initPlugins();
    result = definition.main();
    if (result instanceof Promise) console.warn("The background's main() function return a promise, but it must be synchronous");
  } catch (err) {
    logger.error("The background crashed on startup!");
    throw err;
  }
  var background_entrypoint_default = result;
  return background_entrypoint_default;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL3NoYXJlZC9hcGkvZ3JvcS50cyIsIi4uLy4uL3NoYXJlZC9hcGkvbm90aW9uLnRzIiwiLi4vLi4vc2hhcmVkL2FwaS9zaGVldHMudHMiLCIuLi8uLi9zaGFyZWQvc3RvcmFnZS9sb2NhbC50cyIsIi4uLy4uL3NoYXJlZC90eXBlcy50cyIsIi4uLy4uL3NoYXJlZC9zdG9yYWdlL3N5bmMudHMiLCIuLi8uLi9lbnRyeXBvaW50cy9iYWNrZ3JvdW5kLnRzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3eHQtZGV2L2Jyb3dzZXIvc3JjL2luZGV4Lm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC9icm93c2VyLm1qcyIsIi4uLy4uL25vZGVfbW9kdWxlcy9Ad2ViZXh0LWNvcmUvbWF0Y2gtcGF0dGVybnMvbGliL2luZGV4Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyNyZWdpb24gc3JjL3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLnRzXG5mdW5jdGlvbiBkZWZpbmVCYWNrZ3JvdW5kKGFyZykge1xuXHRpZiAoYXJnID09IG51bGwgfHwgdHlwZW9mIGFyZyA9PT0gXCJmdW5jdGlvblwiKSByZXR1cm4geyBtYWluOiBhcmcgfTtcblx0cmV0dXJuIGFyZztcbn1cblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBkZWZpbmVCYWNrZ3JvdW5kIH07IiwiaW1wb3J0IHR5cGUgeyBKb2JJbmZvLCBQcm9maWxlIH0gZnJvbSAnLi4vdHlwZXMnO1xuaW1wb3J0IHR5cGUgeyBBcGlFcnJvcktpbmQgfSBmcm9tICcuLi9tZXNzYWdlcyc7XG5cbmNvbnN0IEdST1FfQVBJX1VSTCA9ICdodHRwczovL2FwaS5ncm9xLmNvbS9vcGVuYWkvdjEvY2hhdC9jb21wbGV0aW9ucyc7XG5jb25zdCBUSU1FT1VUX01TID0gMTVfMDAwO1xuXG5leHBvcnQgY2xhc3MgR3JvcUFwaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBwdWJsaWMgcmVhZG9ubHkga2luZDogQXBpRXJyb3JLaW5kLFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ0dyb3FBcGlFcnJvcic7XG4gIH1cbn1cblxuaW50ZXJmYWNlIEdyb3FSZXNwb25zZSB7XG4gIGNob2ljZXM6IEFycmF5PHsgbWVzc2FnZTogeyBjb250ZW50OiBzdHJpbmcgfSB9Pjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlTW90aXZhdGlvbihcbiAgam9iSW5mbzogSm9iSW5mbyxcbiAgcHJvZmlsZTogUHJvZmlsZSxcbiAgYXBpS2V5OiBzdHJpbmcsXG4gIG1vZGVsOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBpZiAoIWFwaUtleSkge1xuICAgIHRocm93IG5ldyBHcm9xQXBpRXJyb3IoJ01JU1NJTkdfS0VZJywgJ0dyb3EgQVBJIGtleSBpcyBub3QgY29uZmlndXJlZC4nKTtcbiAgfVxuXG4gIGNvbnN0IGxhbmd1YWdlID0gZGV0ZWN0TGFuZ3VhZ2Uoam9iSW5mby5kZXNjcmlwdGlvbik7XG5cbiAgY29uc3Qgc3lzdGVtUHJvbXB0ID0gYFlvdSBhcmUgYW4gYXNzaXN0YW50IHRoYXQgd3JpdGVzIGNvbmNpc2UsIHByb2Zlc3Npb25hbCBqb2IgYXBwbGljYXRpb24gbW90aXZhdGlvbiBwYXJhZ3JhcGhzLlxuV3JpdGUgMy01IHNlbnRlbmNlcyBpbiAke2xhbmd1YWdlfS4gQmUgc3BlY2lmaWMgdG8gdGhlIHJvbGUgYW5kIGNvbXBhbnkuIERvIG5vdCB1c2UgZ2VuZXJpYyBmaWxsZXIgcGhyYXNlcy5cblJldHVybiBvbmx5IHRoZSBwYXJhZ3JhcGgg4oCUIG5vIHByZWFtYmxlLCBubyBtYXJrZG93bi5gO1xuXG4gIGNvbnN0IHVzZXJQcm9tcHQgPSBgSm9iIHRpdGxlOiAke2pvYkluZm8ucG9zaXRpb24gPz8gJ3Vua25vd24nfVxuQ29tcGFueTogJHtqb2JJbmZvLmNvbXBhbnkgPz8gJ3Vua25vd24nfVxuSm9iIGRlc2NyaXB0aW9uIChleGNlcnB0KTogJHsoam9iSW5mby5kZXNjcmlwdGlvbiA/PyAnJykuc2xpY2UoMCwgODAwKX1cblxuQXBwbGljYW50IHN1bW1hcnk6ICR7cHJvZmlsZS5hYm91dCB8fCBgJHtwcm9maWxlLmZpcnN0TmFtZX0gJHtwcm9maWxlLmxhc3ROYW1lfWB9XG5Ta2lsbHM6IChkZXJpdmVkIGZyb20gcHJvZmlsZSBzdW1tYXJ5IGFib3ZlKVxuXG5Xcml0ZSBhIG1vdGl2YXRpb24gcGFyYWdyYXBoLmA7XG5cbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBUSU1FT1VUX01TKTtcblxuICBsZXQgcmVzcG9uc2U6IFJlc3BvbnNlO1xuICB0cnkge1xuICAgIHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goR1JPUV9BUElfVVJMLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke2FwaUtleX1gLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbW9kZWwsXG4gICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgeyByb2xlOiAnc3lzdGVtJywgY29udGVudDogc3lzdGVtUHJvbXB0IH0sXG4gICAgICAgICAgeyByb2xlOiAndXNlcicsIGNvbnRlbnQ6IHVzZXJQcm9tcHQgfSxcbiAgICAgICAgXSxcbiAgICAgICAgbWF4X3Rva2VuczogMzAwLFxuICAgICAgICB0ZW1wZXJhdHVyZTogMC43LFxuICAgICAgfSksXG4gICAgICBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsLFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoKGVyciBhcyBFcnJvcikubmFtZSA9PT0gJ0Fib3J0RXJyb3InKSB7XG4gICAgICB0aHJvdyBuZXcgR3JvcUFwaUVycm9yKCdUSU1FT1VUJywgJ1JlcXVlc3QgdGltZWQgb3V0IGFmdGVyIDE1IHMuJyk7XG4gICAgfVxuICAgIHRocm93IG5ldyBHcm9xQXBpRXJyb3IoJ05FVFdPUktfRVJST1InLCBgTmV0d29yayBlcnJvcjogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgfVxuXG4gIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwMSkge1xuICAgIHRocm93IG5ldyBHcm9xQXBpRXJyb3IoJ1VOQVVUSE9SSVpFRCcsICdJbnZhbGlkIG9yIGV4cGlyZWQgR3JvcSBBUEkga2V5LicpO1xuICB9XG4gIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xuICAgIHRocm93IG5ldyBHcm9xQXBpRXJyb3IoJ1JBVEVfTElNSVRFRCcsICdHcm9xIHJhdGUgbGltaXQgZXhjZWVkZWQuJyk7XG4gIH1cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIHRocm93IG5ldyBHcm9xQXBpRXJyb3IoJ05FVFdPUktfRVJST1InLCBgR3JvcSBBUEkgZXJyb3I6IEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gIH1cblxuICBjb25zdCBkYXRhID0gKGF3YWl0IHJlc3BvbnNlLmpzb24oKSkgYXMgR3JvcVJlc3BvbnNlO1xuICByZXR1cm4gZGF0YS5jaG9pY2VzWzBdPy5tZXNzYWdlLmNvbnRlbnQ/LnRyaW0oKSA/PyAnJztcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSBmaWVsZCBmaW5nZXJwcmludHMgdmlhIExMTSDigJQgb3B0aW9uYWwgZmVhdHVyZSBmbGFnIChGUi01LjMpLlxuICogU2VuZHMgb25seSBzZXJpYWxpemVkIGZpbmdlcnByaW50IHN0cmluZ3Mg4oCUIG5vIHVzZXIgZGF0YS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsYXNzaWZ5RmllbGRzKFxuICBmaW5nZXJwcmludHM6IHN0cmluZ1tdLFxuICBhcGlLZXk6IHN0cmluZyxcbiAgbW9kZWw6IHN0cmluZyxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xuICBpZiAoIWFwaUtleSkge1xuICAgIHRocm93IG5ldyBHcm9xQXBpRXJyb3IoJ01JU1NJTkdfS0VZJywgJ0dyb3EgQVBJIGtleSBpcyBub3QgY29uZmlndXJlZC4nKTtcbiAgfVxuXG4gIGNvbnN0IHByb21wdCA9IGBZb3UgYXJlIGEgSlNPTiBBUEkuIENsYXNzaWZ5IGVhY2ggSFRNTCBmb3JtIGZpZWxkIGZpbmdlcnByaW50IGJ5IHR5cGUuXG5GaWVsZCB0eXBlczogZmlyc3ROYW1lLCBsYXN0TmFtZSwgZnVsbE5hbWUsIGVtYWlsLCBwaG9uZSwgbGlua2VkaW4sIGdpdGh1Yiwgd2Vic2l0ZSwgc2FsYXJ5LCBjaXR5LCBjb3ZlckxldHRlciwgYXZhaWxhYmlsaXR5LCB3b3JrUGVybWl0LCBhYm91dCwgdW5rbm93bi5cblJlc3BvbmQgT05MWSB3aXRoIGEgSlNPTiBvYmplY3QgbWFwcGluZyBlYWNoIGlucHV0IGZpbmdlcnByaW50IHRvIGl0cyB0eXBlLlxuXG5GaW5nZXJwcmludHM6XG4ke2ZpbmdlcnByaW50cy5tYXAoKGYsIGkpID0+IGAke2l9OiBcIiR7Zn1cImApLmpvaW4oJ1xcbicpfWA7XG5cbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBUSU1FT1VUX01TKTtcblxuICBsZXQgcmVzcG9uc2U6IFJlc3BvbnNlO1xuICB0cnkge1xuICAgIHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goR1JPUV9BUElfVVJMLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke2FwaUtleX1gLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbW9kZWwsXG4gICAgICAgIG1lc3NhZ2VzOiBbeyByb2xlOiAndXNlcicsIGNvbnRlbnQ6IHByb21wdCB9XSxcbiAgICAgICAgbWF4X3Rva2VuczogNTAwLFxuICAgICAgICB0ZW1wZXJhdHVyZTogMCxcbiAgICAgICAgcmVzcG9uc2VfZm9ybWF0OiB7IHR5cGU6ICdqc29uX29iamVjdCcgfSxcbiAgICAgIH0pLFxuICAgICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKChlcnIgYXMgRXJyb3IpLm5hbWUgPT09ICdBYm9ydEVycm9yJykge1xuICAgICAgdGhyb3cgbmV3IEdyb3FBcGlFcnJvcignVElNRU9VVCcsICdSZXF1ZXN0IHRpbWVkIG91dC4nKTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEdyb3FBcGlFcnJvcignTkVUV09SS19FUlJPUicsIGBOZXR3b3JrIGVycm9yOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICB9XG5cbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIHRocm93IG5ldyBHcm9xQXBpRXJyb3IoJ05FVFdPUktfRVJST1InLCBgR3JvcSBBUEkgZXJyb3I6IEhUVFAgJHtyZXNwb25zZS5zdGF0dXN9YCk7XG4gIH1cblxuICBjb25zdCBkYXRhID0gKGF3YWl0IHJlc3BvbnNlLmpzb24oKSkgYXMgR3JvcVJlc3BvbnNlO1xuICBjb25zdCByYXcgPSBkYXRhLmNob2ljZXNbMF0/Lm1lc3NhZ2UuY29udGVudCA/PyAne30nO1xuXG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICB9IGNhdGNoIHtcbiAgICAvLyBPbiBpbnZhbGlkIEpTT04sIHJldHVybiBlbXB0eSDigJQgZmllbGRzIHJlbWFpbiB1bmNsYXNzaWZpZWQgKEZSLTUuMylcbiAgICByZXR1cm4ge307XG4gIH1cbn1cblxuZnVuY3Rpb24gZGV0ZWN0TGFuZ3VhZ2UodGV4dD86IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghdGV4dCkgcmV0dXJuICdFbmdsaXNoJztcbiAgY29uc3QgY3plY2hJbmRpY2F0b3JzID0gL1vDocSNxI/DqcSbw63FiMOzxZnFocWlw7rFr8W+w4HEjMSOw4nEmsONxYfDk8WYxaDFpMOaxa7FvV0vO1xuICByZXR1cm4gY3plY2hJbmRpY2F0b3JzLnRlc3QodGV4dCkgPyAnQ3plY2gnIDogJ0VuZ2xpc2gnO1xufVxuIiwiaW1wb3J0IHR5cGUgeyBBcHBsaWNhdGlvbkVudHJ5IH0gZnJvbSAnLi4vdHlwZXMnO1xuXG5jb25zdCBOT1RJT05fQVBJID0gJ2h0dHBzOi8vYXBpLm5vdGlvbi5jb20vdjEnO1xuY29uc3QgTk9USU9OX1ZFUlNJT04gPSAnMjAyMi0wNi0yOCc7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2dUb05vdGlvbihcbiAgZW50cnk6IEFwcGxpY2F0aW9uRW50cnksXG4gIHRva2VuOiBzdHJpbmcsXG4gIGRhdGFiYXNlSWQ6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGAke05PVElPTl9BUEl9L3BhZ2VzYCwge1xuICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCxcbiAgICAgICdOb3Rpb24tVmVyc2lvbic6IE5PVElPTl9WRVJTSU9OLFxuICAgIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcGFyZW50OiB7IGRhdGFiYXNlX2lkOiBkYXRhYmFzZUlkIH0sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIE5hbWU6IHsgdGl0bGU6IFt7IHRleHQ6IHsgY29udGVudDogZW50cnkucG9zaXRpb24gfHwgJ1Vua25vd24gcG9zaXRpb24nIH0gfV0gfSxcbiAgICAgICAgQ29tcGFueTogeyByaWNoX3RleHQ6IFt7IHRleHQ6IHsgY29udGVudDogZW50cnkuY29tcGFueSB8fCAnJyB9IH1dIH0sXG4gICAgICAgIFVSTDogeyB1cmw6IGVudHJ5LnVybCB9LFxuICAgICAgICBEYXRlOiB7IGRhdGU6IHsgc3RhcnQ6IGVudHJ5LnRpbWVzdGFtcCB9IH0sXG4gICAgICAgIFN0YXR1czogeyBzZWxlY3Q6IHsgbmFtZTogZW50cnkuc3RhdHVzIH0gfSxcbiAgICAgICAgUHJvZmlsZTogeyByaWNoX3RleHQ6IFt7IHRleHQ6IHsgY29udGVudDogZW50cnkucHJvZmlsZUlkIH0gfV0gfSxcbiAgICAgIH0sXG4gICAgfSksXG4gIH0pO1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+ICcnKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYE5vdGlvbiBBUEkgZXJyb3IgJHtyZXNwb25zZS5zdGF0dXN9OiAke2JvZHkuc2xpY2UoMCwgMjAwKX1gKTtcbiAgfVxufVxuIiwiaW1wb3J0IHR5cGUgeyBBcHBsaWNhdGlvbkVudHJ5IH0gZnJvbSAnLi4vdHlwZXMnO1xuXG4vKipcbiAqIFBPU1QgYW4gYXBwbGljYXRpb24gZW50cnkgdG8gYSB1c2VyLWRlcGxveWVkIEdvb2dsZSBBcHBzIFNjcmlwdCBXZWIgQXBwLlxuICogVGhlIGVuZHBvaW50IG11c3QgYWNjZXB0IEpTT04gUE9TVCB3aXRoIHRoZSBBcHBsaWNhdGlvbkVudHJ5IHNoYXBlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9nVG9TaGVldHMoZW50cnk6IEFwcGxpY2F0aW9uRW50cnksIGVuZHBvaW50OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChlbmRwb2ludCwge1xuICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGVudHJ5KSxcbiAgICByZWRpcmVjdDogJ2ZvbGxvdycsIC8vIEFwcHMgU2NyaXB0IFdlYiBBcHBzIG9mdGVuIHJlZGlyZWN0XG4gIH0pO1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFNoZWV0cyBlbmRwb2ludCBlcnJvcjogSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgfVxufVxuIiwiaW1wb3J0IHR5cGUgeyBMb2NhbERhdGEsIEFwcGxpY2F0aW9uRW50cnkgfSBmcm9tICcuLi90eXBlcyc7XG5cbmNvbnN0IEtFWVMgPSB7XG4gIGdyb3FBcGlLZXk6ICdncm9xX2FwaV9rZXknLFxuICBncm9xTW9kZWw6ICdncm9xX21vZGVsJyxcbiAgbm90aW9uVG9rZW46ICdub3Rpb25fdG9rZW4nLFxuICBub3Rpb25EYXRhYmFzZUlkOiAnbm90aW9uX2RiX2lkJyxcbiAgc2hlZXRzRW5kcG9pbnQ6ICdzaGVldHNfZW5kcG9pbnQnLFxuICBhcHBsaWNhdGlvbkxvZzogJ2FwcGxpY2F0aW9uX2xvZycsXG59IGFzIGNvbnN0O1xuXG4vLyDilIDilIDilIAgQVBJIGNyZWRlbnRpYWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0R3JvcUFwaUtleSgpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCByID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KEtFWVMuZ3JvcUFwaUtleSk7XG4gIHJldHVybiByW0tFWVMuZ3JvcUFwaUtleV0gYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0R3JvcUFwaUtleShrZXk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5ncm9xQXBpS2V5XToga2V5IH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0R3JvcU1vZGVsKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHIgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoS0VZUy5ncm9xTW9kZWwpO1xuICByZXR1cm4gKHJbS0VZUy5ncm9xTW9kZWxdIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gJ2xsYW1hLTMuMy03MGItdmVyc2F0aWxlJztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldEdyb3FNb2RlbChtb2RlbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtLRVlTLmdyb3FNb2RlbF06IG1vZGVsIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0Tm90aW9uQ3JlZGVudGlhbHMoKTogUHJvbWlzZTxcbiAgUGljazxMb2NhbERhdGEsICdub3Rpb25Ub2tlbicgfCAnbm90aW9uRGF0YWJhc2VJZCc+XG4+IHtcbiAgY29uc3QgciA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbS0VZUy5ub3Rpb25Ub2tlbiwgS0VZUy5ub3Rpb25EYXRhYmFzZUlkXSk7XG4gIHJldHVybiB7XG4gICAgbm90aW9uVG9rZW46IHJbS0VZUy5ub3Rpb25Ub2tlbl0gYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgIG5vdGlvbkRhdGFiYXNlSWQ6IHJbS0VZUy5ub3Rpb25EYXRhYmFzZUlkXSBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXROb3Rpb25DcmVkZW50aWFscyh0b2tlbjogc3RyaW5nLCBkYXRhYmFzZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICBbS0VZUy5ub3Rpb25Ub2tlbl06IHRva2VuLFxuICAgIFtLRVlTLm5vdGlvbkRhdGFiYXNlSWRdOiBkYXRhYmFzZUlkLFxuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNoZWV0c0VuZHBvaW50KCk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IHIgPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoS0VZUy5zaGVldHNFbmRwb2ludCk7XG4gIHJldHVybiByW0tFWVMuc2hlZXRzRW5kcG9pbnRdIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldFNoZWV0c0VuZHBvaW50KHVybDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtLRVlTLnNoZWV0c0VuZHBvaW50XTogdXJsIH0pO1xufVxuXG4vLyDilIDilIDilIAgQXBwbGljYXRpb24gbG9nIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QXBwbGljYXRpb25Mb2coKTogUHJvbWlzZTxBcHBsaWNhdGlvbkVudHJ5W10+IHtcbiAgY29uc3QgciA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChLRVlTLmFwcGxpY2F0aW9uTG9nKTtcbiAgcmV0dXJuIChyW0tFWVMuYXBwbGljYXRpb25Mb2ddIGFzIEFwcGxpY2F0aW9uRW50cnlbXSB8IHVuZGVmaW5lZCkgPz8gW107XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhcHBlbmRMb2dFbnRyeShlbnRyeTogQXBwbGljYXRpb25FbnRyeSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBsb2cgPSBhd2FpdCBnZXRBcHBsaWNhdGlvbkxvZygpO1xuICBsb2cudW5zaGlmdChlbnRyeSk7IC8vIG5ld2VzdCBmaXJzdFxuICAvLyBLZWVwIGF0IG1vc3QgNTAwIGVudHJpZXMgbG9jYWxseVxuICBpZiAobG9nLmxlbmd0aCA+IDUwMCkgbG9nLnNwbGljZSg1MDApO1xuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBbS0VZUy5hcHBsaWNhdGlvbkxvZ106IGxvZyB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHVwZGF0ZUxvZ0VudHJ5U3luYyhcbiAgaWQ6IHN0cmluZyxcbiAgcmVtb3RlU3luYzogQXBwbGljYXRpb25FbnRyeVsncmVtb3RlU3luYyddLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGxvZyA9IGF3YWl0IGdldEFwcGxpY2F0aW9uTG9nKCk7XG4gIGNvbnN0IGVudHJ5ID0gbG9nLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKGVudHJ5KSB7XG4gICAgZW50cnkucmVtb3RlU3luYyA9IHJlbW90ZVN5bmM7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW0tFWVMuYXBwbGljYXRpb25Mb2ddOiBsb2cgfSk7XG4gIH1cbn1cbiIsIi8vIOKUgOKUgOKUgCBEb21haW4gdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvZmlsZSB7XG4gIGlkOiBzdHJpbmc7XG4gIC8qKiBEaXNwbGF5IGxhYmVsLCBlLmcuIFwiRnJvbnRlbmRcIiwgXCJRQVwiICovXG4gIGxhYmVsOiBzdHJpbmc7XG4gIGZpcnN0TmFtZTogc3RyaW5nO1xuICBsYXN0TmFtZTogc3RyaW5nO1xuICBlbWFpbDogc3RyaW5nO1xuICAvKiogRS4xNjQgZm9ybWF0LCBkZWZhdWx0IHJlZ2lvbiArNDIwICovXG4gIHBob25lOiBzdHJpbmc7XG4gIGNpdHk6IHN0cmluZztcbiAgbGlua2VkaW46IHN0cmluZztcbiAgZ2l0aHViOiBzdHJpbmc7XG4gIHdlYnNpdGU6IHN0cmluZztcbiAgc2FsYXJ5RXhwZWN0YXRpb246IHN0cmluZztcbiAgYXZhaWxhYmlsaXR5OiBzdHJpbmc7XG4gIHdvcmtQZXJtaXQ6IHN0cmluZztcbiAgYWJvdXQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb3ZlclRlbXBsYXRlIHtcbiAgaWQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgLyoqIFN1cHBvcnRzIHtjb21wYW55fSwge3Bvc2l0aW9ufSwge3NvdXJjZX0gcGxhY2Vob2xkZXJzICovXG4gIGJvZHk6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBsaWNhdGlvbkVudHJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgdGltZXN0YW1wOiBzdHJpbmc7IC8vIElTTyA4NjAxXG4gIGNvbXBhbnk6IHN0cmluZztcbiAgcG9zaXRpb246IHN0cmluZztcbiAgdXJsOiBzdHJpbmc7XG4gIHByb2ZpbGVJZDogc3RyaW5nO1xuICBzdGF0dXM6ICdzdWJtaXR0ZWQnO1xuICByZW1vdGVTeW5jOiAnb2snIHwgJ3BlbmRpbmcnIHwgJ2ZhaWxlZCc7XG59XG5cbi8vIOKUgOKUgOKUgCBTdG9yYWdlIHNoYXBlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqIGNocm9tZS5zdG9yYWdlLnN5bmMg4oCUIGNyb3NzLWRldmljZSwg4omkIDEwMCBLQiAqL1xuZXhwb3J0IGludGVyZmFjZSBTeW5jRGF0YSB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIHByb2ZpbGVzOiBQcm9maWxlW107XG4gIGFjdGl2ZVByb2ZpbGVJZDogc3RyaW5nO1xuICBjb3ZlclRlbXBsYXRlczogQ292ZXJUZW1wbGF0ZVtdO1xuICBzZXR0aW5nczogQXBwU2V0dGluZ3M7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwU2V0dGluZ3Mge1xuICBoaWdobGlnaHREdXJhdGlvbk1zOiBudW1iZXI7XG4gIGxvZ0JhY2tlbmQ6ICdub3Rpb24nIHwgJ3NoZWV0cycgfCAnb2ZmJztcbn1cblxuLyoqIGNocm9tZS5zdG9yYWdlLmxvY2FsIOKAlCBzZWNyZXRzICsgYnVsa3kgZGF0YSwgbmV2ZXIgc3luY2VkICovXG5leHBvcnQgaW50ZXJmYWNlIExvY2FsRGF0YSB7XG4gIGdyb3FBcGlLZXk/OiBzdHJpbmc7XG4gIGdyb3FNb2RlbD86IHN0cmluZztcbiAgbm90aW9uVG9rZW4/OiBzdHJpbmc7XG4gIG5vdGlvbkRhdGFiYXNlSWQ/OiBzdHJpbmc7XG4gIHNoZWV0c0VuZHBvaW50Pzogc3RyaW5nO1xuICBhcHBsaWNhdGlvbkxvZzogQXBwbGljYXRpb25FbnRyeVtdO1xufVxuXG4vLyDilIDilIDilIAgRmllbGQtbWF0Y2hpbmcgdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEZpZWxkQ29uZmlkZW5jZSA9ICdoaWdoJyB8ICdtZWRpdW0nIHwgJ2xvdycgfCAnbm9uZSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmllbGRNYXRjaCB7XG4gIGVsZW1lbnQ6IEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MVGV4dEFyZWFFbGVtZW50IHwgSFRNTFNlbGVjdEVsZW1lbnQ7XG4gIGZpZWxkVHlwZTogc3RyaW5nO1xuICBjb25maWRlbmNlOiBGaWVsZENvbmZpZGVuY2U7XG4gIC8qKiBSZXNvbHZlZCB2YWx1ZSBmcm9tIHRoZSBhY3RpdmUgcHJvZmlsZSAqL1xuICB2YWx1ZTogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEZpbGxTdW1tYXJ5IHtcbiAgdG90YWw6IG51bWJlcjtcbiAgaGlnaDogbnVtYmVyO1xuICBtZWRpdW06IG51bWJlcjtcbiAgdW5yZWNvZ25pemVkOiBudW1iZXI7XG4gIGZpbGVJbnB1dHM6IG51bWJlcjtcbn1cblxuLy8g4pSA4pSA4pSAIEpvYi1pbmZvIGV4dHJhY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBpbnRlcmZhY2UgSm9iSW5mbyB7XG4gIGNvbXBhbnk/OiBzdHJpbmc7XG4gIHBvc2l0aW9uPzogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbn1cblxuLy8g4pSA4pSA4pSAIERlZmF1bHRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogQXBwU2V0dGluZ3MgPSB7XG4gIGhpZ2hsaWdodER1cmF0aW9uTXM6IDMwMDAsXG4gIGxvZ0JhY2tlbmQ6ICdvZmYnLFxufTtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfU1lOQ19EQVRBOiBTeW5jRGF0YSA9IHtcbiAgc2NoZW1hVmVyc2lvbjogMSxcbiAgcHJvZmlsZXM6IFtdLFxuICBhY3RpdmVQcm9maWxlSWQ6ICcnLFxuICBjb3ZlclRlbXBsYXRlczogW10sXG4gIHNldHRpbmdzOiBERUZBVUxUX1NFVFRJTkdTLFxufTtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfTE9DQUxfREFUQTogUGFydGlhbDxMb2NhbERhdGE+ID0ge1xuICBhcHBsaWNhdGlvbkxvZzogW10sXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRW1wdHlQcm9maWxlKG92ZXJyaWRlczogUGFydGlhbDxQcm9maWxlPiA9IHt9KTogUHJvZmlsZSB7XG4gIHJldHVybiB7XG4gICAgaWQ6IGNyeXB0by5yYW5kb21VVUlEKCksXG4gICAgbGFiZWw6ICdNeSBQcm9maWxlJyxcbiAgICBmaXJzdE5hbWU6ICcnLFxuICAgIGxhc3ROYW1lOiAnJyxcbiAgICBlbWFpbDogJycsXG4gICAgcGhvbmU6ICcnLFxuICAgIGNpdHk6ICcnLFxuICAgIGxpbmtlZGluOiAnJyxcbiAgICBnaXRodWI6ICcnLFxuICAgIHdlYnNpdGU6ICcnLFxuICAgIHNhbGFyeUV4cGVjdGF0aW9uOiAnJyxcbiAgICBhdmFpbGFiaWxpdHk6ICcnLFxuICAgIHdvcmtQZXJtaXQ6ICcnLFxuICAgIGFib3V0OiAnJyxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG4iLCJpbXBvcnQgdHlwZSB7IFN5bmNEYXRhLCBQcm9maWxlLCBDb3ZlclRlbXBsYXRlLCBBcHBTZXR0aW5ncyB9IGZyb20gJy4uL3R5cGVzJztcbmltcG9ydCB7IERFRkFVTFRfU1lOQ19EQVRBIH0gZnJvbSAnLi4vdHlwZXMnO1xuXG5jb25zdCBTVE9SQUdFX0tFWSA9ICdqb2JmaWxsX3N5bmMnO1xuXG5hc3luYyBmdW5jdGlvbiBnZXRTeW5jRGF0YSgpOiBQcm9taXNlPFN5bmNEYXRhPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMuZ2V0KFNUT1JBR0VfS0VZKTtcbiAgcmV0dXJuIHsgLi4uREVGQVVMVF9TWU5DX0RBVEEsIC4uLihyZXN1bHRbU1RPUkFHRV9LRVldIGFzIFBhcnRpYWw8U3luY0RhdGE+KSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBzZXRTeW5jRGF0YShkYXRhOiBQYXJ0aWFsPFN5bmNEYXRhPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U3luY0RhdGEoKTtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5zZXQoeyBbU1RPUkFHRV9LRVldOiB7IC4uLmN1cnJlbnQsIC4uLmRhdGEgfSB9KTtcbn1cblxuLy8g4pSA4pSA4pSAIFByb2ZpbGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0UHJvZmlsZXMoKTogUHJvbWlzZTxQcm9maWxlW10+IHtcbiAgcmV0dXJuIChhd2FpdCBnZXRTeW5jRGF0YSgpKS5wcm9maWxlcztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVQcm9maWxlcyhwcm9maWxlczogUHJvZmlsZVtdKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHNldFN5bmNEYXRhKHsgcHJvZmlsZXMgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRBY3RpdmVQcm9maWxlSWQoKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgcmV0dXJuIChhd2FpdCBnZXRTeW5jRGF0YSgpKS5hY3RpdmVQcm9maWxlSWQ7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXRBY3RpdmVQcm9maWxlSWQoaWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBzZXRTeW5jRGF0YSh7IGFjdGl2ZVByb2ZpbGVJZDogaWQgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRBY3RpdmVQcm9maWxlKCk6IFByb21pc2U8UHJvZmlsZSB8IHVuZGVmaW5lZD4ge1xuICBjb25zdCB7IHByb2ZpbGVzLCBhY3RpdmVQcm9maWxlSWQgfSA9IGF3YWl0IGdldFN5bmNEYXRhKCk7XG4gIHJldHVybiBwcm9maWxlcy5maW5kKChwKSA9PiBwLmlkID09PSBhY3RpdmVQcm9maWxlSWQpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBzZXJ0UHJvZmlsZShwcm9maWxlOiBQcm9maWxlKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHByb2ZpbGVzID0gYXdhaXQgZ2V0UHJvZmlsZXMoKTtcbiAgY29uc3QgaWR4ID0gcHJvZmlsZXMuZmluZEluZGV4KChwKSA9PiBwLmlkID09PSBwcm9maWxlLmlkKTtcbiAgaWYgKGlkeCA+PSAwKSB7XG4gICAgcHJvZmlsZXNbaWR4XSA9IHByb2ZpbGU7XG4gIH0gZWxzZSB7XG4gICAgcHJvZmlsZXMucHVzaChwcm9maWxlKTtcbiAgfVxuICBhd2FpdCBzYXZlUHJvZmlsZXMocHJvZmlsZXMpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVsZXRlUHJvZmlsZShpZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHByb2ZpbGVzID0gYXdhaXQgZ2V0UHJvZmlsZXMoKTtcbiAgYXdhaXQgc2F2ZVByb2ZpbGVzKHByb2ZpbGVzLmZpbHRlcigocCkgPT4gcC5pZCAhPT0gaWQpKTtcbn1cblxuLy8g4pSA4pSA4pSAIENvdmVyIHRlbXBsYXRlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldENvdmVyVGVtcGxhdGVzKCk6IFByb21pc2U8Q292ZXJUZW1wbGF0ZVtdPiB7XG4gIHJldHVybiAoYXdhaXQgZ2V0U3luY0RhdGEoKSkuY292ZXJUZW1wbGF0ZXM7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlQ292ZXJUZW1wbGF0ZXModGVtcGxhdGVzOiBDb3ZlclRlbXBsYXRlW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgc2V0U3luY0RhdGEoeyBjb3ZlclRlbXBsYXRlczogdGVtcGxhdGVzIH0pO1xufVxuXG4vLyDilIDilIDilIAgU2V0dGluZ3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5ncygpOiBQcm9taXNlPEFwcFNldHRpbmdzPiB7XG4gIHJldHVybiAoYXdhaXQgZ2V0U3luY0RhdGEoKSkuc2V0dGluZ3M7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3Moc2V0dGluZ3M6IFBhcnRpYWw8QXBwU2V0dGluZ3M+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBnZXRTZXR0aW5ncygpO1xuICBhd2FpdCBzZXRTeW5jRGF0YSh7IHNldHRpbmdzOiB7IC4uLmN1cnJlbnQsIC4uLnNldHRpbmdzIH0gfSk7XG59XG5cbi8vIOKUgOKUgOKUgCBTY2hlbWEgbWFuYWdlbWVudCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFN0b3JhZ2VVc2FnZVBlcmNlbnQoKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXRCeXRlc0luVXNlKG51bGwsIChieXRlcykgPT4ge1xuICAgICAgcmVzb2x2ZShNYXRoLnJvdW5kKChieXRlcyAvIGNocm9tZS5zdG9yYWdlLnN5bmMuUVVPVEFfQllURVMpICogMTAwKSk7XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vLyDilIDilIDilIAgRXhwb3J0IC8gSW1wb3J0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhwb3J0U3luY0RhdGEoKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGdldFN5bmNEYXRhKCk7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCAyKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGltcG9ydFN5bmNEYXRhKGpzb246IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UoanNvbik7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBKU09OIGZpbGUuJyk7XG4gIH1cblxuICBpZiAoXG4gICAgdHlwZW9mIHBhcnNlZCAhPT0gJ29iamVjdCcgfHxcbiAgICBwYXJzZWQgPT09IG51bGwgfHxcbiAgICAocGFyc2VkIGFzIFN5bmNEYXRhKS5zY2hlbWFWZXJzaW9uICE9PSAxXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcignVW5yZWNvZ25pc2VkIGZpbGUgZm9ybWF0LiBFeHBlY3RlZCBKb2JGaWxsIGV4cG9ydCB3aXRoIHNjaGVtYVZlcnNpb246IDEuJyk7XG4gIH1cblxuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLnNldCh7IFtTVE9SQUdFX0tFWV06IHBhcnNlZCB9KTtcbn1cbiIsImltcG9ydCB7IGRlZmluZUJhY2tncm91bmQgfSBmcm9tICd3eHQvdXRpbHMvZGVmaW5lLWJhY2tncm91bmQnO1xuaW1wb3J0IHsgZ2VuZXJhdGVNb3RpdmF0aW9uLCBjbGFzc2lmeUZpZWxkcywgR3JvcUFwaUVycm9yIH0gZnJvbSAnLi4vc2hhcmVkL2FwaS9ncm9xJztcbmltcG9ydCB7IGxvZ1RvTm90aW9uIH0gZnJvbSAnLi4vc2hhcmVkL2FwaS9ub3Rpb24nO1xuaW1wb3J0IHsgbG9nVG9TaGVldHMgfSBmcm9tICcuLi9zaGFyZWQvYXBpL3NoZWV0cyc7XG5pbXBvcnQgeyBnZXRHcm9xQXBpS2V5LCBnZXRHcm9xTW9kZWwsIGdldE5vdGlvbkNyZWRlbnRpYWxzLCBnZXRTaGVldHNFbmRwb2ludCwgYXBwZW5kTG9nRW50cnksIHVwZGF0ZUxvZ0VudHJ5U3luYyB9IGZyb20gJy4uL3NoYXJlZC9zdG9yYWdlL2xvY2FsJztcbmltcG9ydCB7IGdldFNldHRpbmdzLCBnZXRQcm9maWxlcyB9IGZyb20gJy4uL3NoYXJlZC9zdG9yYWdlL3N5bmMnO1xuaW1wb3J0IHR5cGUgeyBUb0JhY2tncm91bmRNZXNzYWdlLCBBcGlFcnJvcktpbmQgfSBmcm9tICcuLi9zaGFyZWQvbWVzc2FnZXMnO1xuaW1wb3J0IHR5cGUgeyBBcHBsaWNhdGlvbkVudHJ5IH0gZnJvbSAnLi4vc2hhcmVkL3R5cGVzJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQmFja2dyb3VuZCgoKSA9PiB7XG4gIGNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihcbiAgICAobWVzc2FnZTogVG9CYWNrZ3JvdW5kTWVzc2FnZSwgX3NlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAobWVzc2FnZS50eXBlID09PSAnR0VORVJBVEVfQ09WRVInKSB7XG4gICAgICAgIGhhbmRsZUdlbmVyYXRlQ292ZXIobWVzc2FnZS5qb2JJbmZvLCBtZXNzYWdlLnByb2ZpbGVJZClcbiAgICAgICAgICAudGhlbihzZW5kUmVzcG9uc2UpXG4gICAgICAgICAgLmNhdGNoKCgpID0+IHNlbmRSZXNwb25zZSh7IHR5cGU6ICdBUElfRVJST1InLCBraW5kOiAnTkVUV09SS19FUlJPUicsIG1lc3NhZ2U6ICdVbmtub3duIGVycm9yLicgfSkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ0NMQVNTSUZZX0ZJRUxEUycpIHtcbiAgICAgICAgaGFuZGxlQ2xhc3NpZnlGaWVsZHMobWVzc2FnZS5maW5nZXJwcmludHMpXG4gICAgICAgICAgLnRoZW4oc2VuZFJlc3BvbnNlKVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBzZW5kUmVzcG9uc2Uoe30pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdMT0dfQVBQTElDQVRJT04nKSB7XG4gICAgICAgIGhhbmRsZUxvZ0FwcGxpY2F0aW9uKG1lc3NhZ2UuZW50cnkpXG4gICAgICAgICAgLnRoZW4oc2VuZFJlc3BvbnNlKVxuICAgICAgICAgIC5jYXRjaCgoKSA9PiBzZW5kUmVzcG9uc2UoeyB0eXBlOiAnTE9HX1JFU1VMVCcsIHN1Y2Nlc3M6IGZhbHNlIH0pKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9LFxuICApO1xufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUdlbmVyYXRlQ292ZXIoXG4gIGpvYkluZm86IFBhcmFtZXRlcnM8dHlwZW9mIGdlbmVyYXRlTW90aXZhdGlvbj5bMV0gZXh0ZW5kcyBpbmZlciBfUCA/IFBhcmFtZXRlcnM8dHlwZW9mIGdlbmVyYXRlTW90aXZhdGlvbj5bMF0gOiBuZXZlcixcbiAgcHJvZmlsZUlkOiBzdHJpbmcsXG4pIHtcbiAgY29uc3QgYXBpS2V5ID0gYXdhaXQgZ2V0R3JvcUFwaUtleSgpO1xuICBjb25zdCBtb2RlbCA9IGF3YWl0IGdldEdyb3FNb2RlbCgpO1xuXG4gIGlmICghYXBpS2V5KSB7XG4gICAgcmV0dXJuIHsgdHlwZTogJ0FQSV9FUlJPUicsIGtpbmQ6ICdNSVNTSU5HX0tFWScgYXMgQXBpRXJyb3JLaW5kLCBtZXNzYWdlOiAnTm8gR3JvcSBBUEkga2V5LicgfTtcbiAgfVxuXG4gIGNvbnN0IHByb2ZpbGVzID0gYXdhaXQgZ2V0UHJvZmlsZXMoKTtcbiAgY29uc3QgcHJvZmlsZSA9IHByb2ZpbGVzLmZpbmQoKHApID0+IHAuaWQgPT09IHByb2ZpbGVJZCk7XG5cbiAgaWYgKCFwcm9maWxlKSB7XG4gICAgcmV0dXJuIHsgdHlwZTogJ0FQSV9FUlJPUicsIGtpbmQ6ICdORVRXT1JLX0VSUk9SJyBhcyBBcGlFcnJvcktpbmQsIG1lc3NhZ2U6ICdQcm9maWxlIG5vdCBmb3VuZC4nIH07XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IHRleHQgPSBhd2FpdCBnZW5lcmF0ZU1vdGl2YXRpb24oam9iSW5mbywgcHJvZmlsZSwgYXBpS2V5LCBtb2RlbCk7XG4gICAgcmV0dXJuIHsgdHlwZTogJ0dFTkVSQVRJT05fUkVTVUxUJywgdGV4dCB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoZXJyIGluc3RhbmNlb2YgR3JvcUFwaUVycm9yKSB7XG4gICAgICByZXR1cm4geyB0eXBlOiAnQVBJX0VSUk9SJywga2luZDogZXJyLmtpbmQsIG1lc3NhZ2U6IGVyci5tZXNzYWdlIH07XG4gICAgfVxuICAgIHJldHVybiB7IHR5cGU6ICdBUElfRVJST1InLCBraW5kOiAnTkVUV09SS19FUlJPUicgYXMgQXBpRXJyb3JLaW5kLCBtZXNzYWdlOiBTdHJpbmcoZXJyKSB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUNsYXNzaWZ5RmllbGRzKGZpbmdlcnByaW50czogc3RyaW5nW10pIHtcbiAgY29uc3QgYXBpS2V5ID0gYXdhaXQgZ2V0R3JvcUFwaUtleSgpO1xuICBjb25zdCBtb2RlbCA9IGF3YWl0IGdldEdyb3FNb2RlbCgpO1xuICBpZiAoIWFwaUtleSkgcmV0dXJuIHt9O1xuXG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGNsYXNzaWZ5RmllbGRzKGZpbmdlcnByaW50cywgYXBpS2V5LCBtb2RlbCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7fTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVMb2dBcHBsaWNhdGlvbihlbnRyeTogQXBwbGljYXRpb25FbnRyeSkge1xuICAvLyBBbHdheXMgd3JpdGUgbG9jYWxseSBmaXJzdFxuICBhd2FpdCBhcHBlbmRMb2dFbnRyeShlbnRyeSk7XG5cbiAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBnZXRTZXR0aW5ncygpO1xuXG4gIGlmIChzZXR0aW5ncy5sb2dCYWNrZW5kID09PSAnb2ZmJykge1xuICAgIHJldHVybiB7IHR5cGU6ICdMT0dfUkVTVUxUJywgc3VjY2VzczogdHJ1ZSB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICBpZiAoc2V0dGluZ3MubG9nQmFja2VuZCA9PT0gJ25vdGlvbicpIHtcbiAgICAgIGNvbnN0IHsgbm90aW9uVG9rZW4sIG5vdGlvbkRhdGFiYXNlSWQgfSA9IGF3YWl0IGdldE5vdGlvbkNyZWRlbnRpYWxzKCk7XG4gICAgICBpZiAobm90aW9uVG9rZW4gJiYgbm90aW9uRGF0YWJhc2VJZCkge1xuICAgICAgICBhd2FpdCBsb2dUb05vdGlvbihlbnRyeSwgbm90aW9uVG9rZW4sIG5vdGlvbkRhdGFiYXNlSWQpO1xuICAgICAgICBhd2FpdCB1cGRhdGVMb2dFbnRyeVN5bmMoZW50cnkuaWQsICdvaycpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoc2V0dGluZ3MubG9nQmFja2VuZCA9PT0gJ3NoZWV0cycpIHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgZ2V0U2hlZXRzRW5kcG9pbnQoKTtcbiAgICAgIGlmIChlbmRwb2ludCkge1xuICAgICAgICBhd2FpdCBsb2dUb1NoZWV0cyhlbnRyeSwgZW5kcG9pbnQpO1xuICAgICAgICBhd2FpdCB1cGRhdGVMb2dFbnRyeVN5bmMoZW50cnkuaWQsICdvaycpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4geyB0eXBlOiAnTE9HX1JFU1VMVCcsIHN1Y2Nlc3M6IHRydWUgfTtcbiAgfSBjYXRjaCB7XG4gICAgYXdhaXQgdXBkYXRlTG9nRW50cnlTeW5jKGVudHJ5LmlkLCAnZmFpbGVkJyk7XG4gICAgLy8gU3VyZmFjZSBub24tYmxvY2tpbmdseSDigJQgY2FsbGVyIHNob3dzIHdhcm5pbmdcbiAgICByZXR1cm4geyB0eXBlOiAnTE9HX1JFU1VMVCcsIHN1Y2Nlc3M6IGZhbHNlIH07XG4gIH1cbn1cbiIsIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgYnJvd3NlciQxIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcblxuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb24gQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pXG4qIGBgYFxuKiBAbW9kdWxlIHd4dC9icm93c2VyXG4qL1xuY29uc3QgYnJvd3NlciA9IGJyb3dzZXIkMTtcblxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBicm93c2VyIH07IiwiLy8jcmVnaW9uIHNyYy9pbmRleC50c1xuLyoqXG4qIENsYXNzIGZvciBwYXJzaW5nIGFuZCBwZXJmb3JtaW5nIG9wZXJhdGlvbnMgb24gbWF0Y2ggcGF0dGVybnMuXG4qXG4qIEBleGFtcGxlXG4qICAgY29uc3QgcGF0dGVybiA9IG5ldyBNYXRjaFBhdHRlcm4oJyo6Ly9nb29nbGUuY29tLyonKTtcbipcbiogICBwYXR0ZXJuLmluY2x1ZGVzKCdodHRwczovL2dvb2dsZS5jb20nKTsgLy8gdHJ1ZVxuKiAgIHBhdHRlcm4uaW5jbHVkZXMoJ2h0dHA6Ly95b3V0dWJlLmNvbS93YXRjaD92PTEyMycpOyAvLyBmYWxzZVxuKi9cbnZhciBNYXRjaFBhdHRlcm4gPSBjbGFzcyBNYXRjaFBhdHRlcm4ge1xuXHRzdGF0aWMge1xuXHRcdHRoaXMuUFJPVE9DT0xTID0gW1xuXHRcdFx0XCJodHRwXCIsXG5cdFx0XHRcImh0dHBzXCIsXG5cdFx0XHRcImZpbGVcIixcblx0XHRcdFwiZnRwXCIsXG5cdFx0XHRcInVyblwiLFxuXHRcdFx0XCJ3c1wiLFxuXHRcdFx0XCJ3c3NcIlxuXHRcdF07XG5cdH1cblx0LyoqXG5cdCogUGFyc2UgYSBtYXRjaCBwYXR0ZXJuIHN0cmluZy4gSWYgaXQgaXMgaW52YWxpZCwgdGhlIGNvbnN0cnVjdG9yIHdpbGwgdGhyb3cgYW5cblx0KiBgSW52YWxpZE1hdGNoUGF0dGVybmAgZXJyb3IuXG5cdCpcblx0KiBAcGFyYW0gbWF0Y2hQYXR0ZXJuIFRoZSBtYXRjaCBwYXR0ZXJuIHRvIHBhcnNlLlxuXHQqL1xuXHRjb25zdHJ1Y3RvcihtYXRjaFBhdHRlcm4pIHtcblx0XHRpZiAobWF0Y2hQYXR0ZXJuID09PSBcIjxhbGxfdXJscz5cIikge1xuXHRcdFx0dGhpcy5pc0FsbFVybHMgPSB0cnVlO1xuXHRcdFx0dGhpcy5wcm90b2NvbE1hdGNoZXMgPSBbLi4uTWF0Y2hQYXR0ZXJuLlBST1RPQ09MU107XG5cdFx0XHR0aGlzLmhvc3RuYW1lTWF0Y2ggPSBcIipcIjtcblx0XHRcdHRoaXMucGF0aG5hbWVNYXRjaCA9IFwiKlwiO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zdCBncm91cHMgPSAvKC4qKTpcXC9cXC8oLio/KShcXC8uKikvLmV4ZWMobWF0Y2hQYXR0ZXJuKTtcblx0XHRcdGlmIChncm91cHMgPT0gbnVsbCkgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBcIkluY29ycmVjdCBmb3JtYXRcIik7XG5cdFx0XHRjb25zdCBbXywgcHJvdG9jb2wsIGhvc3RuYW1lLCBwYXRobmFtZV0gPSBncm91cHM7XG5cdFx0XHR2YWxpZGF0ZVByb3RvY29sKG1hdGNoUGF0dGVybiwgcHJvdG9jb2wpO1xuXHRcdFx0dmFsaWRhdGVIb3N0bmFtZShtYXRjaFBhdHRlcm4sIGhvc3RuYW1lKTtcblx0XHRcdHRoaXMucHJvdG9jb2xNYXRjaGVzID0gcHJvdG9jb2wgPT09IFwiKlwiID8gW1wiaHR0cFwiLCBcImh0dHBzXCJdIDogW3Byb3RvY29sXTtcblx0XHRcdHRoaXMuaG9zdG5hbWVNYXRjaCA9IGhvc3RuYW1lO1xuXHRcdFx0dGhpcy5wYXRobmFtZU1hdGNoID0gcGF0aG5hbWU7XG5cdFx0fVxuXHR9XG5cdC8qKiBDaGVjayBpZiBhIFVSTCBpcyBpbmNsdWRlZCBpbiBhIHBhdHRlcm4uICovXG5cdGluY2x1ZGVzKHVybCkge1xuXHRcdGNvbnN0IHUgPSB0eXBlb2YgdXJsID09PSBcInN0cmluZ1wiID8gbmV3IFVSTCh1cmwpIDogdXJsIGluc3RhbmNlb2YgTG9jYXRpb24gPyBuZXcgVVJMKHVybC5ocmVmKSA6IHVybDtcblx0XHRpZiAodGhpcy5pc0FsbFVybHMpIHJldHVybiAhdGhpcy5pc1Vua25vd25Qcm90b2NvbCh1KTtcblx0XHRyZXR1cm4gISF0aGlzLnByb3RvY29sTWF0Y2hlcy5maW5kKChwcm90b2NvbCkgPT4ge1xuXHRcdFx0aWYgKHByb3RvY29sID09PSBcImh0dHBcIikgcmV0dXJuIHRoaXMuaXNIdHRwTWF0Y2godSk7XG5cdFx0XHRpZiAocHJvdG9jb2wgPT09IFwiaHR0cHNcIikgcmV0dXJuIHRoaXMuaXNIdHRwc01hdGNoKHUpO1xuXHRcdFx0aWYgKHByb3RvY29sID09PSBcImZpbGVcIikgcmV0dXJuIHRoaXMuaXNGaWxlTWF0Y2godSk7XG5cdFx0XHRpZiAocHJvdG9jb2wgPT09IFwiZnRwXCIpIHJldHVybiB0aGlzLmlzRnRwTWF0Y2godSk7XG5cdFx0XHRpZiAocHJvdG9jb2wgPT09IFwidXJuXCIpIHJldHVybiB0aGlzLmlzVXJuTWF0Y2godSk7XG5cdFx0fSk7XG5cdH1cblx0aXNIdHRwTWF0Y2godXJsKSB7XG5cdFx0cmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG5cdH1cblx0aXNIdHRwc01hdGNoKHVybCkge1xuXHRcdHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcblx0fVxuXHRpc0hvc3RQYXRoTWF0Y2godXJsKSB7XG5cdFx0aWYgKCF0aGlzLmhvc3RuYW1lTWF0Y2ggfHwgIXRoaXMucGF0aG5hbWVNYXRjaCkgcmV0dXJuIGZhbHNlO1xuXHRcdGNvbnN0IGhvc3RuYW1lTWF0Y2hSZWdleHMgPSBbdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoKSwgdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5ob3N0bmFtZU1hdGNoLnJlcGxhY2UoL15cXCpcXC4vLCBcIlwiKSldO1xuXHRcdGNvbnN0IHBhdGhuYW1lTWF0Y2hSZWdleCA9IHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMucGF0aG5hbWVNYXRjaCk7XG5cdFx0cmV0dXJuICEhaG9zdG5hbWVNYXRjaFJlZ2V4cy5maW5kKChyZWdleCkgPT4gcmVnZXgudGVzdCh1cmwuaG9zdG5hbWUpKSAmJiBwYXRobmFtZU1hdGNoUmVnZXgudGVzdCh1cmwucGF0aG5hbWUpO1xuXHR9XG5cdGlzVW5rbm93blByb3RvY29sKHVybCkge1xuXHRcdHJldHVybiAhdGhpcy5wcm90b2NvbE1hdGNoZXMuaW5jbHVkZXModXJsLnByb3RvY29sLnNsaWNlKDAsIC0xKSk7XG5cdH1cblx0aXNQYXRoTWF0Y2godXJsKSB7XG5cdFx0aWYgKCF0aGlzLnBhdGhuYW1lTWF0Y2gpIHJldHVybiBmYWxzZTtcblx0XHRyZXR1cm4gdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5wYXRobmFtZU1hdGNoKS50ZXN0KHVybC5wYXRobmFtZSk7XG5cdH1cblx0aXNGaWxlTWF0Y2godXJsKSB7XG5cdFx0cmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJmaWxlOlwiICYmIHRoaXMuaXNQYXRoTWF0Y2godXJsKTtcblx0fVxuXHRpc0Z0cE1hdGNoKF91cmwpIHtcblx0XHR0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogZnRwOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcblx0fVxuXHRpc1Vybk1hdGNoKF91cmwpIHtcblx0XHR0aHJvdyBFcnJvcihcIk5vdCBpbXBsZW1lbnRlZDogdXJuOi8vIHBhdHRlcm4gbWF0Y2hpbmcuIE9wZW4gYSBQUiB0byBhZGQgc3VwcG9ydFwiKTtcblx0fVxuXHRjb252ZXJ0UGF0dGVyblRvUmVnZXgocGF0dGVybikge1xuXHRcdGNvbnN0IHN0YXJzUmVwbGFjZWQgPSB0aGlzLmVzY2FwZUZvclJlZ2V4KHBhdHRlcm4pLnJlcGxhY2UoL1xcXFxcXCovZywgXCIuKlwiKTtcblx0XHRyZXR1cm4gUmVnRXhwKGBeJHtzdGFyc1JlcGxhY2VkfSRgKTtcblx0fVxuXHRlc2NhcGVGb3JSZWdleChzdHJpbmcpIHtcblx0XHRyZXR1cm4gc3RyaW5nLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKTtcblx0fVxufTtcbnZhciBJbnZhbGlkTWF0Y2hQYXR0ZXJuID0gY2xhc3MgZXh0ZW5kcyBFcnJvciB7XG5cdGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybiwgcmVhc29uKSB7XG5cdFx0c3VwZXIoYEludmFsaWQgbWF0Y2ggcGF0dGVybiBcIiR7bWF0Y2hQYXR0ZXJufVwiOiAke3JlYXNvbn1gKTtcblx0fVxufTtcbmZ1bmN0aW9uIHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCkge1xuXHRpZiAoIU1hdGNoUGF0dGVybi5QUk9UT0NPTFMuaW5jbHVkZXMocHJvdG9jb2wpICYmIHByb3RvY29sICE9PSBcIipcIikgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBgJHtwcm90b2NvbH0gbm90IGEgdmFsaWQgcHJvdG9jb2wgKCR7TWF0Y2hQYXR0ZXJuLlBST1RPQ09MUy5qb2luKFwiLCBcIil9KWApO1xufVxuZnVuY3Rpb24gdmFsaWRhdGVIb3N0bmFtZShtYXRjaFBhdHRlcm4sIGhvc3RuYW1lKSB7XG5cdGlmIChob3N0bmFtZS5pbmNsdWRlcyhcIjpcIikpIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgYEhvc3RuYW1lIGNhbm5vdCBpbmNsdWRlIGEgcG9ydGApO1xuXHRpZiAoaG9zdG5hbWUuaW5jbHVkZXMoXCIqXCIpICYmIGhvc3RuYW1lLmxlbmd0aCA+IDEgJiYgIWhvc3RuYW1lLnN0YXJ0c1dpdGgoXCIqLlwiKSkgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBgSWYgdXNpbmcgYSB3aWxkY2FyZCAoKiksIGl0IG11c3QgZ28gYXQgdGhlIHN0YXJ0IG9mIHRoZSBob3N0bmFtZWApO1xufVxuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBJbnZhbGlkTWF0Y2hQYXR0ZXJuLCBNYXRjaFBhdHRlcm4gfTtcbiJdLCJuYW1lcyI6WyJyZXN1bHQiLCJicm93c2VyIl0sIm1hcHBpbmdzIjoiOzs7QUFDQSxXQUFTLGlCQUFpQixLQUFLO0FBQzlCLFFBQUksT0FBTyxRQUFRLE9BQU8sUUFBUSxXQUFZLFFBQU8sRUFBRSxNQUFNLElBQUc7QUFDaEUsV0FBTztBQUFBLEVBQ1I7QUNEQSxRQUFNLGVBQWU7QUFDckIsUUFBTSxhQUFhO0FBQUEsRUFFWixNQUFNLHFCQUFxQixNQUFNO0FBQUEsSUFDdEMsWUFDa0IsTUFDaEIsU0FDQTtBQUNBLFlBQU0sT0FBTztBQUhHLFdBQUEs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
