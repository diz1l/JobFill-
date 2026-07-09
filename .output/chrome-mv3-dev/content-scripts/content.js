var content = (function() {
  "use strict";
  function defineContentScript(definition2) {
    return definition2;
  }
  function getLabelText(el) {
    const id = el.getAttribute("id");
    if (id) {
      const label = el.ownerDocument.querySelector(
        `label[for="${CSS.escape(id)}"]`
      );
      if (label) return label.textContent?.trim() ?? "";
    }
    const ancestor = el.closest("label");
    if (ancestor) {
      const clone = ancestor.cloneNode(true);
      clone.querySelectorAll("input,textarea,select").forEach((c) => c.remove());
      return clone.textContent?.trim() ?? "";
    }
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = el.ownerDocument.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent?.trim() ?? "";
    }
    return "";
  }
  function getContextHeading(el) {
    let node = el;
    while (node && node !== el.ownerDocument.body) {
      let prev = node.previousElementSibling;
      while (prev) {
        const tag = prev.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag) || tag === "legend" || tag === "dt") {
          return prev.textContent?.trim() ?? "";
        }
        if (tag === "div" || tag === "span" || tag === "p") {
          const text = prev.textContent?.trim() ?? "";
          if (text.length > 0 && text.length < 80) return text;
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }
  function buildFingerprint(el) {
    return {
      element: el,
      autocomplete: el.getAttribute("autocomplete") ?? "",
      name: el.getAttribute("name") ?? "",
      id: el.getAttribute("id") ?? "",
      placeholder: el.placeholder ?? "",
      ariaLabel: el.getAttribute("aria-label") ?? "",
      labelText: getLabelText(el),
      contextHeading: getContextHeading(el)
    };
  }
  function enumerateFillable(root = document) {
    const selector = [
      'input:not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="checkbox"]):not([type="radio"])',
      "textarea",
      "select"
    ].join(",");
    return Array.from(root.querySelectorAll(selector)).filter((el) => {
      if (el.disabled) return false;
      const consentPattern = /consent|gdpr|agree|privacy|terms/i;
      const fp = buildFingerprint(el);
      const combined = [fp.name, fp.id, fp.ariaLabel, fp.labelText].join(" ");
      if (consentPattern.test(combined)) return false;
      return true;
    });
  }
  const FIELD_RULES = [
    {
      type: "firstName",
      autocomplete: ["given-name"],
      pattern: /first[.\s_-]?name|given[.\s_-]?name|forename|jm[eé]no|jmeno|křestn[ií]|krestni/i
    },
    {
      type: "lastName",
      autocomplete: ["family-name"],
      pattern: /last[.\s_-]?name|family[.\s_-]?name|surname|příjmen[ií]|prijmeni/i
    },
    {
      type: "fullName",
      autocomplete: ["name"],
      pattern: /\bfull[.\s_-]?name\b|cel[eé][.\s_-]?jm[eé]no/i
    },
    {
      type: "email",
      autocomplete: ["email"],
      pattern: /e-?mail/i
    },
    {
      type: "phone",
      autocomplete: ["tel", "tel-national"],
      pattern: /phone|tel(?!l)[.\s_-]?|mobil|telefon/i
    },
    {
      type: "linkedin",
      autocomplete: [],
      pattern: /linkedin/i
    },
    {
      type: "github",
      autocomplete: [],
      pattern: /github/i
    },
    {
      type: "website",
      autocomplete: ["url"],
      pattern: /website|portfolio|personal[.\s_-]?url|web[.\s_-]?page|osobn[ií][.\s_-]?web/i
    },
    {
      type: "salary",
      autocomplete: [],
      pattern: /salary|compensation|mzda|plat[.\s_-]|odm[eě]na/i
    },
    {
      type: "city",
      autocomplete: ["address-level2"],
      pattern: /\bcity\b|location|m[eě]sto|adresa|bydlišt[eě]/i
    },
    {
      type: "coverLetter",
      autocomplete: [],
      pattern: /cover[.\s_-]?letter|motivat|průvodn[ií]|motivačn[ií]/i
    },
    {
      type: "availability",
      autocomplete: [],
      pattern: /availab|notice[.\s_-]?period|start[.\s_-]?date|nastup|dostupnost/i
    },
    {
      type: "workPermit",
      autocomplete: [],
      pattern: /work[.\s_-]?permit|visa|citizen|authoriz|pracovn[ií][.\s_-]?povolen[ií]/i
    },
    {
      type: "about",
      autocomplete: [],
      pattern: /\babout\b|\bsummary\b|\bbio\b|profil[.\s_-]|souhrn|o[.\s_-]sob[eě]/i
    }
  ];
  const HIGH_THRESHOLD = 70;
  const MEDIUM_THRESHOLD = 35;
  function test(pattern, value) {
    if (!value) return false;
    if (pattern.test(value)) return true;
    const stripped = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return stripped !== value && pattern.test(stripped);
  }
  function scoreField(fp) {
    let best = null;
    for (const rule of FIELD_RULES) {
      let score = 0;
      if (rule.autocomplete.length > 0 && fp.autocomplete) {
        if (rule.autocomplete.includes(fp.autocomplete)) score += 70;
      }
      if (test(rule.pattern, fp.name) || test(rule.pattern, fp.id)) score += 30;
      if (test(rule.pattern, fp.ariaLabel)) score += 20;
      if (test(rule.pattern, fp.labelText)) score += 20;
      if (test(rule.pattern, fp.placeholder)) score += 15;
      if (test(rule.pattern, fp.contextHeading)) score += 10;
      if (score > 0 && (!best || score > best.score)) {
        const confidence = score >= HIGH_THRESHOLD ? "high" : score >= MEDIUM_THRESHOLD ? "medium" : "low";
        best = { fieldType: rule.type, score, confidence };
      }
    }
    return best;
  }
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (!descriptor?.set) return;
    descriptor.set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const SIMILARITY_THRESHOLD = 0.5;
  function normalize(str) {
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s]/g, "").trim();
  }
  function containsScore(source, target) {
    if (!source || !target) return 0;
    const s = normalize(source);
    const t = normalize(target);
    if (s === t) return 1;
    if (s.includes(t) || t.includes(s)) return 0.8;
    const sWords = new Set(s.split(/\s+/));
    const tWords = t.split(/\s+/);
    const overlap = tWords.filter((w) => sWords.has(w)).length;
    return overlap / Math.max(sWords.size, tWords.length);
  }
  function fillSelect(el, value) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      const scoreByText = containsScore(opt.text, value);
      const scoreByValue = containsScore(opt.value, value);
      const score = Math.max(scoreByText, scoreByValue);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestScore >= SIMILARITY_THRESHOLD && bestIndex >= 0) {
      el.selectedIndex = bestIndex;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }
  const STYLE_ID = "__jobfill-styles";
  const DISMISS_ATTR = "data-jobfill-dismiss";
  const HIGHLIGHT_CSS = `
.__jobfill-high {
  outline: 2px solid #22c55e !important;
  outline-offset: 1px !important;
  background-color: rgba(34,197,94,0.08) !important;
}
.__jobfill-medium {
  outline: 2px solid #eab308 !important;
  outline-offset: 1px !important;
  background-color: rgba(234,179,8,0.08) !important;
}
.__jobfill-low, .__jobfill-none {
  outline: 2px dashed #9ca3af !important;
  outline-offset: 1px !important;
}
.__jobfill-file {
  outline: 2px dashed #3b82f6 !important;
  outline-offset: 1px !important;
}
.__jobfill-badge {
  position: absolute;
  z-index: 2147483647;
  font-size: 10px;
  font-family: system-ui, sans-serif;
  padding: 2px 5px;
  border-radius: 3px;
  pointer-events: none;
  white-space: nowrap;
  background: #1e293b;
  color: #f1f5f9;
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
}
`;
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = HIGHLIGHT_CSS;
    document.head.appendChild(style);
  }
  function highlightField(el, confidence, durationMs) {
    ensureStyles();
    const cls = `__jobfill-${confidence}`;
    el.classList.add(cls);
    el.setAttribute(DISMISS_ATTR, "1");
    const dismiss = () => removeHighlight(el, cls);
    el.addEventListener("click", dismiss, { once: true });
    setTimeout(dismiss, durationMs);
  }
  function removeHighlight(el, cls) {
    el.classList.remove(cls);
    el.removeAttribute(DISMISS_ATTR);
  }
  function resolveValue(fieldType, profile) {
    const map = {
      firstName: profile.firstName,
      lastName: profile.lastName,
      fullName: `${profile.firstName} ${profile.lastName}`.trim(),
      email: profile.email,
      phone: profile.phone,
      linkedin: profile.linkedin,
      github: profile.github,
      website: profile.website,
      salary: profile.salaryExpectation,
      city: profile.city,
      coverLetter: "",
      // populated by template resolver
      availability: profile.availability,
      workPermit: profile.workPermit,
      about: profile.about
    };
    return map[fieldType] ?? "";
  }
  function fillPage(profile, opts = {}) {
    const durationMs = opts.highlightDurationMs ?? 3e3;
    const elements = enumerateFillable();
    const summary = {
      total: elements.length,
      high: 0,
      medium: 0,
      unrecognized: 0,
      fileInputs: 0
    };
    document.querySelectorAll('input[type="file"]').forEach((el) => {
      summary.fileInputs++;
      highlightField(el, "file", durationMs);
    });
    for (const el of elements) {
      const fp = buildFingerprint(el);
      const match = scoreField(fp);
      if (!match || match.confidence === "low" || match.confidence === "none") {
        summary.unrecognized++;
        highlightField(el, "none", durationMs);
        continue;
      }
      const value = resolveValue(match.fieldType, profile);
      if (!value) {
        summary.unrecognized++;
        continue;
      }
      if (el instanceof HTMLSelectElement) {
        const filled = fillSelect(el, value);
        if (filled) {
          match.confidence === "high" ? summary.high++ : summary.medium++;
          highlightField(el, match.confidence, durationMs);
        } else {
          summary.unrecognized++;
          highlightField(el, "none", durationMs);
        }
      } else {
        setNativeValue(el, value);
        match.confidence === "high" ? summary.high++ : summary.medium++;
        highlightField(el, match.confidence, durationMs);
      }
    }
    return summary;
  }
  function extractFromJsonLd(doc = document) {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent ?? "");
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const jobPosting = findJobPosting(node);
          if (jobPosting) {
            return {
              company: jobPosting.hiringOrganization?.name ?? void 0,
              position: jobPosting.title ?? void 0,
              description: stripHtml(jobPosting.description ?? "")
            };
          }
        }
      } catch {
      }
    }
    return {};
  }
  function findJobPosting(node) {
    if (!node || typeof node !== "object") return null;
    const type = node["@type"];
    if (type === "JobPosting" || Array.isArray(type) && type.includes("JobPosting")) {
      return node;
    }
    if (Array.isArray(node["@graph"])) {
      for (const item of node["@graph"]) {
        const found = findJobPosting(item);
        if (found) return found;
      }
    }
    return null;
  }
  function stripHtml(html) {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2e3);
  }
  function extractFromOpenGraph(doc = document) {
    const get = (property) => {
      const el = doc.querySelector(`meta[property="${property}"]`);
      return el?.content?.trim() || void 0;
    };
    const title = get("og:title");
    const siteName = get("og:site_name");
    if (!title && !siteName) return {};
    let position;
    let company;
    if (title) {
      const separators = [" at ", " bei ", " chez ", " @ ", " | ", " - ", " — "];
      for (const sep of separators) {
        const idx = title.indexOf(sep);
        if (idx > 0) {
          position = title.slice(0, idx).trim();
          company = title.slice(idx + sep.length).trim();
          break;
        }
      }
      if (!position) position = title;
    }
    if (!company && siteName) {
      company = siteName;
    }
    return { company, position };
  }
  function extractFromHeadings(doc = document) {
    const h1 = doc.querySelector("h1")?.textContent?.trim();
    const titleRaw = doc.title?.trim();
    const position = h1 || void 0;
    let company;
    if (titleRaw) {
      const separators = [" - ", " | ", " — ", " · ", " at ", " @ "];
      for (const sep of separators) {
        const parts = titleRaw.split(sep);
        if (parts.length >= 2) {
          const lastPart = parts[parts.length - 1].trim();
          if (lastPart.length > 0 && lastPart.length < 60) {
            company = lastPart;
            break;
          }
        }
      }
    }
    return { position, company };
  }
  function extractJobInfo(doc = document) {
    const jsonLd = extractFromJsonLd(doc);
    const og = extractFromOpenGraph(doc);
    const headings = extractFromHeadings(doc);
    return {
      company: jsonLd.company ?? og.company ?? headings.company,
      position: jsonLd.position ?? og.position ?? headings.position,
      description: jsonLd.description
    };
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
  async function getActiveProfile() {
    const { profiles, activeProfileId } = await getSyncData();
    return profiles.find((p) => p.id === activeProfileId);
  }
  async function getSettings() {
    return (await getSyncData()).settings;
  }
  const sync = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
    __proto__: null,
    getActiveProfile,
    getProfiles,
    getSettings
  }, Symbol.toStringTag, { value: "Module" }));
  const definition = defineContentScript({
    matches: ["<all_urls>"],
    allFrames: true,
    runAt: "document_idle",
    main() {
      chrome.runtime.onMessage.addListener(
        (message, _sender, sendResponse) => {
          if (message.type === "FILL_FORM") {
            handleFill(message.profileId).then(sendResponse).catch((err) => {
              sendResponse({ error: err.message });
            });
            return true;
          }
          if (message.type === "EXTRACT_JOB_INFO") {
            const jobInfo = extractJobInfo();
            sendResponse({ type: "JOB_INFO", jobInfo });
            return false;
          }
          return false;
        }
      );
    }
  });
  async function handleFill(profileId) {
    let profile = profileId !== "__active__" ? await getActiveProfile() : await getActiveProfile();
    if (!profile) {
      const { getProfiles: getProfiles2 } = await Promise.resolve().then(() => sync);
      const profiles = await getProfiles2();
      profile = profiles.find((p) => p.id === profileId);
    }
    if (!profile) {
      return { type: "FILL_RESULT", summary: null, error: "Profile not found." };
    }
    const settings = await getSettings();
    const summary = fillPage(profile, { highlightDurationMs: settings.highlightDurationMs });
    return { type: "FILL_RESULT", summary };
  }
  function print$1(method, ...args) {
    if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
    else method("[wxt]", ...args);
  }
  const logger$1 = {
    debug: (...args) => print$1(console.debug, ...args),
    log: (...args) => print$1(console.log, ...args),
    warn: (...args) => print$1(console.warn, ...args),
    error: (...args) => print$1(console.error, ...args)
  };
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  var WxtLocationChangeEvent = class WxtLocationChangeEvent2 extends Event {
    static EVENT_NAME = getUniqueEventName("wxt:locationchange");
    constructor(newUrl, oldUrl) {
      super(WxtLocationChangeEvent2.EVENT_NAME, {});
      this.newUrl = newUrl;
      this.oldUrl = oldUrl;
    }
  };
  function getUniqueEventName(eventName) {
    return `${browser?.runtime?.id}:${"content"}:${eventName}`;
  }
  const supportsNavigationApi = typeof globalThis.navigation?.addEventListener === "function";
  function createLocationWatcher(ctx) {
    let lastUrl;
    let watching = false;
    return { run() {
      if (watching) return;
      watching = true;
      lastUrl = new URL(location.href);
      if (supportsNavigationApi) globalThis.navigation.addEventListener("navigate", (event) => {
        const newUrl = new URL(event.destination.url);
        if (newUrl.href === lastUrl.href) return;
        window.dispatchEvent(new WxtLocationChangeEvent(newUrl, lastUrl));
        lastUrl = newUrl;
      }, { signal: ctx.signal });
      else ctx.setInterval(() => {
        const newUrl = new URL(location.href);
        if (newUrl.href !== lastUrl.href) {
          window.dispatchEvent(new WxtLocationChangeEvent(newUrl, lastUrl));
          lastUrl = newUrl;
        }
      }, 1e3);
    } };
  }
  var ContentScriptContext = class ContentScriptContext2 {
    static SCRIPT_STARTED_MESSAGE_TYPE = getUniqueEventName("wxt:content-script-started");
    id;
    abortController;
    locationWatcher = createLocationWatcher(this);
    constructor(contentScriptName, options) {
      this.contentScriptName = contentScriptName;
      this.options = options;
      this.id = Math.random().toString(36).slice(2);
      this.abortController = new AbortController();
      this.stopOldScripts();
      this.listenForNewerScripts();
    }
    get signal() {
      return this.abortController.signal;
    }
    abort(reason) {
      return this.abortController.abort(reason);
    }
    get isInvalid() {
      if (browser.runtime?.id == null) this.notifyInvalidated();
      return this.signal.aborted;
    }
    get isValid() {
      return !this.isInvalid;
    }
    /**
    * Add a listener that is called when the content script's context is invalidated.
    *
    * @returns A function to remove the listener.
    *
    * @example
    * browser.runtime.onMessage.addListener(cb);
    * const removeInvalidatedListener = ctx.onInvalidated(() => {
    *   browser.runtime.onMessage.removeListener(cb);
    * })
    * // ...
    * removeInvalidatedListener();
    */
    onInvalidated(cb) {
      this.signal.addEventListener("abort", cb);
      return () => this.signal.removeEventListener("abort", cb);
    }
    /**
    * Return a promise that never resolves. Useful if you have an async function that shouldn't run
    * after the context is expired.
    *
    * @example
    * const getValueFromStorage = async () => {
    *   if (ctx.isInvalid) return ctx.block();
    *
    *   // ...
    * }
    */
    block() {
      return new Promise(() => {
      });
    }
    /**
    * Wrapper around `window.setInterval` that automatically clears the interval when invalidated.
    *
    * Intervals can be cleared by calling the normal `clearInterval` function.
    */
    setInterval(handler, timeout) {
      const id = setInterval(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearInterval(id));
      return id;
    }
    /**
    * Wrapper around `window.setTimeout` that automatically clears the interval when invalidated.
    *
    * Timeouts can be cleared by calling the normal `setTimeout` function.
    */
    setTimeout(handler, timeout) {
      const id = setTimeout(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearTimeout(id));
      return id;
    }
    /**
    * Wrapper around `window.requestAnimationFrame` that automatically cancels the request when
    * invalidated.
    *
    * Callbacks can be canceled by calling the normal `cancelAnimationFrame` function.
    */
    requestAnimationFrame(callback) {
      const id = requestAnimationFrame((...args) => {
        if (this.isValid) callback(...args);
      });
      this.onInvalidated(() => cancelAnimationFrame(id));
      return id;
    }
    /**
    * Wrapper around `window.requestIdleCallback` that automatically cancels the request when
    * invalidated.
    *
    * Callbacks can be canceled by calling the normal `cancelIdleCallback` function.
    */
    requestIdleCallback(callback, options) {
      const id = requestIdleCallback((...args) => {
        if (!this.signal.aborted) callback(...args);
      }, options);
      this.onInvalidated(() => cancelIdleCallback(id));
      return id;
    }
    addEventListener(target, type, handler, options) {
      if (type === "wxt:locationchange") {
        if (this.isValid) this.locationWatcher.run();
      }
      target.addEventListener?.(type.startsWith("wxt:") ? getUniqueEventName(type) : type, handler, {
        ...options,
        signal: this.signal
      });
    }
    /**
    * @internal
    * Abort the abort controller and execute all `onInvalidated` listeners.
    */
    notifyInvalidated() {
      this.abort("Content script context invalidated");
      logger$1.debug(`Content script "${this.contentScriptName}" context invalidated`);
    }
    stopOldScripts() {
      document.dispatchEvent(new CustomEvent(ContentScriptContext2.SCRIPT_STARTED_MESSAGE_TYPE, { detail: {
        contentScriptName: this.contentScriptName,
        messageId: this.id
      } }));
      window.postMessage({
        type: ContentScriptContext2.SCRIPT_STARTED_MESSAGE_TYPE,
        contentScriptName: this.contentScriptName,
        messageId: this.id
      }, "*");
    }
    verifyScriptStartedEvent(event) {
      const isSameContentScript = event.detail?.contentScriptName === this.contentScriptName;
      const isFromSelf = event.detail?.messageId === this.id;
      return isSameContentScript && !isFromSelf;
    }
    listenForNewerScripts() {
      const cb = (event) => {
        if (!(event instanceof CustomEvent) || !this.verifyScriptStartedEvent(event)) return;
        this.notifyInvalidated();
      };
      document.addEventListener(ContentScriptContext2.SCRIPT_STARTED_MESSAGE_TYPE, cb);
      this.onInvalidated(() => document.removeEventListener(ContentScriptContext2.SCRIPT_STARTED_MESSAGE_TYPE, cb));
    }
  };
  function initPlugins() {
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
  const result = (async () => {
    try {
      initPlugins();
      const { main, ...options } = definition;
      return await main(new ContentScriptContext("content", options));
    } catch (err) {
      logger.error(`The content script "${"content"}" crashed on startup!`, err);
      throw err;
    }
  })();
  return result;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9zaGFyZWQvZmllbGQtbWF0Y2hlci9maW5nZXJwcmludC50cyIsIi4uLy4uLy4uL3NoYXJlZC9maWVsZC1tYXRjaGVyL2RpY3Rpb25hcnkudHMiLCIuLi8uLi8uLi9zaGFyZWQvZmllbGQtbWF0Y2hlci9zY29yZXIudHMiLCIuLi8uLi8uLi9zaGFyZWQvZmlsbGVyL3NldE5hdGl2ZVZhbHVlLnRzIiwiLi4vLi4vLi4vc2hhcmVkL2ZpbGxlci9zZWxlY3RTdHJhdGVneS50cyIsIi4uLy4uLy4uL3NoYXJlZC9maWxsZXIvaGlnaGxpZ2h0LnRzIiwiLi4vLi4vLi4vc2hhcmVkL2ZpbGxlci9pbmRleC50cyIsIi4uLy4uLy4uL3NoYXJlZC9leHRyYWN0b3JzL2pzb25MZC50cyIsIi4uLy4uLy4uL3NoYXJlZC9leHRyYWN0b3JzL29wZW5HcmFwaC50cyIsIi4uLy4uLy4uL3NoYXJlZC9leHRyYWN0b3JzL2hlYWRpbmdIZXVyaXN0aWNzLnRzIiwiLi4vLi4vLi4vc2hhcmVkL2V4dHJhY3RvcnMvaW5kZXgudHMiLCIuLi8uLi8uLi9zaGFyZWQvdHlwZXMudHMiLCIuLi8uLi8uLi9zaGFyZWQvc3RvcmFnZS9zeW5jLnRzIiwiLi4vLi4vLi4vZW50cnlwb2ludHMvY29udGVudC50cyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9pbnRlcm5hbC9sb2dnZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0B3eHQtZGV2L2Jyb3dzZXIvc3JjL2luZGV4Lm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC9icm93c2VyLm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9pbnRlcm5hbC9jdXN0b20tZXZlbnRzLm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9jb250ZW50LXNjcmlwdC1jb250ZXh0Lm1qcyJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyNyZWdpb24gc3JjL3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC50c1xuZnVuY3Rpb24gZGVmaW5lQ29udGVudFNjcmlwdChkZWZpbml0aW9uKSB7XG5cdHJldHVybiBkZWZpbml0aW9uO1xufVxuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGRlZmluZUNvbnRlbnRTY3JpcHQgfTsiLCJleHBvcnQgdHlwZSBGaWxsYWJsZUVsZW1lbnQgPSBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFRleHRBcmVhRWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50O1xuXG5leHBvcnQgaW50ZXJmYWNlIEZpZWxkRmluZ2VycHJpbnQge1xuICBlbGVtZW50OiBGaWxsYWJsZUVsZW1lbnQ7XG4gIGF1dG9jb21wbGV0ZTogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIGlkOiBzdHJpbmc7XG4gIHBsYWNlaG9sZGVyOiBzdHJpbmc7XG4gIGFyaWFMYWJlbDogc3RyaW5nO1xuICBsYWJlbFRleHQ6IHN0cmluZztcbiAgY29udGV4dEhlYWRpbmc6IHN0cmluZztcbn1cblxuLyoqIFN0cmlwIGRpYWNyaXRpY3MgYW5kIGxvd2VyY2FzZSBmb3IgY3Jvc3MtbGluZ3VhbCBtYXRjaGluZyAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dFxuICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgLm5vcm1hbGl6ZSgnTkZEJylcbiAgICAucmVwbGFjZSgvW1xcdTAzMDAtXFx1MDM2Zl0vZywgJycpXG4gICAgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gZ2V0TGFiZWxUZXh0KGVsOiBIVE1MRWxlbWVudCk6IHN0cmluZyB7XG4gIC8vIDEuIDxsYWJlbCBmb3I9XCJpZFwiPlxuICBjb25zdCBpZCA9IGVsLmdldEF0dHJpYnV0ZSgnaWQnKTtcbiAgaWYgKGlkKSB7XG4gICAgY29uc3QgbGFiZWwgPSBlbC5vd25lckRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTExhYmVsRWxlbWVudD4oXG4gICAgICBgbGFiZWxbZm9yPVwiJHtDU1MuZXNjYXBlKGlkKX1cIl1gLFxuICAgICk7XG4gICAgaWYgKGxhYmVsKSByZXR1cm4gbGFiZWwudGV4dENvbnRlbnQ/LnRyaW0oKSA/PyAnJztcbiAgfVxuXG4gIC8vIDIuIFdyYXBwaW5nIDxsYWJlbD5cbiAgY29uc3QgYW5jZXN0b3IgPSBlbC5jbG9zZXN0KCdsYWJlbCcpO1xuICBpZiAoYW5jZXN0b3IpIHtcbiAgICBjb25zdCBjbG9uZSA9IGFuY2VzdG9yLmNsb25lTm9kZSh0cnVlKSBhcyBIVE1MRWxlbWVudDtcbiAgICBjbG9uZS5xdWVyeVNlbGVjdG9yQWxsKCdpbnB1dCx0ZXh0YXJlYSxzZWxlY3QnKS5mb3JFYWNoKChjKSA9PiBjLnJlbW92ZSgpKTtcbiAgICByZXR1cm4gY2xvbmUudGV4dENvbnRlbnQ/LnRyaW0oKSA/PyAnJztcbiAgfVxuXG4gIC8vIDMuIGFyaWEtbGFiZWxsZWRieVxuICBjb25zdCBsYWJlbGxlZEJ5ID0gZWwuZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsbGVkYnknKTtcbiAgaWYgKGxhYmVsbGVkQnkpIHtcbiAgICBjb25zdCBsYWJlbEVsID0gZWwub3duZXJEb2N1bWVudC5nZXRFbGVtZW50QnlJZChsYWJlbGxlZEJ5KTtcbiAgICBpZiAobGFiZWxFbCkgcmV0dXJuIGxhYmVsRWwudGV4dENvbnRlbnQ/LnRyaW0oKSA/PyAnJztcbiAgfVxuXG4gIHJldHVybiAnJztcbn1cblxuZnVuY3Rpb24gZ2V0Q29udGV4dEhlYWRpbmcoZWw6IEhUTUxFbGVtZW50KTogc3RyaW5nIHtcbiAgbGV0IG5vZGU6IEVsZW1lbnQgfCBudWxsID0gZWw7XG4gIHdoaWxlIChub2RlICYmIG5vZGUgIT09IGVsLm93bmVyRG9jdW1lbnQuYm9keSkge1xuICAgIGxldCBwcmV2OiBFbGVtZW50IHwgbnVsbCA9IG5vZGUucHJldmlvdXNFbGVtZW50U2libGluZztcbiAgICB3aGlsZSAocHJldikge1xuICAgICAgY29uc3QgdGFnID0gcHJldi50YWdOYW1lLnRvTG93ZXJDYXNlKCk7XG4gICAgICBpZiAoL15oWzEtNl0kLy50ZXN0KHRhZykgfHwgdGFnID09PSAnbGVnZW5kJyB8fCB0YWcgPT09ICdkdCcpIHtcbiAgICAgICAgcmV0dXJuIHByZXYudGV4dENvbnRlbnQ/LnRyaW0oKSA/PyAnJztcbiAgICAgIH1cbiAgICAgIC8vIFNvbWUgZm9ybXMgcHV0IGxhYmVsLWxpa2UgdGV4dCBpbiBhIHNpYmxpbmcgZGl2XG4gICAgICBpZiAodGFnID09PSAnZGl2JyB8fCB0YWcgPT09ICdzcGFuJyB8fCB0YWcgPT09ICdwJykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gcHJldi50ZXh0Q29udGVudD8udHJpbSgpID8/ICcnO1xuICAgICAgICBpZiAodGV4dC5sZW5ndGggPiAwICYmIHRleHQubGVuZ3RoIDwgODApIHJldHVybiB0ZXh0O1xuICAgICAgfVxuICAgICAgcHJldiA9IHByZXYucHJldmlvdXNFbGVtZW50U2libGluZztcbiAgICB9XG4gICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgfVxuICByZXR1cm4gJyc7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZpbmdlcnByaW50KGVsOiBGaWxsYWJsZUVsZW1lbnQpOiBGaWVsZEZpbmdlcnByaW50IHtcbiAgcmV0dXJuIHtcbiAgICBlbGVtZW50OiBlbCxcbiAgICBhdXRvY29tcGxldGU6IGVsLmdldEF0dHJpYnV0ZSgnYXV0b2NvbXBsZXRlJykgPz8gJycsXG4gICAgbmFtZTogZWwuZ2V0QXR0cmlidXRlKCduYW1lJykgPz8gJycsXG4gICAgaWQ6IGVsLmdldEF0dHJpYnV0ZSgnaWQnKSA/PyAnJyxcbiAgICBwbGFjZWhvbGRlcjogKGVsIGFzIEhUTUxJbnB1dEVsZW1lbnQpLnBsYWNlaG9sZGVyID8/ICcnLFxuICAgIGFyaWFMYWJlbDogZWwuZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJykgPz8gJycsXG4gICAgbGFiZWxUZXh0OiBnZXRMYWJlbFRleHQoZWwpLFxuICAgIGNvbnRleHRIZWFkaW5nOiBnZXRDb250ZXh0SGVhZGluZyhlbCksXG4gIH07XG59XG5cbi8qKiBTZXJpYWxpemUgYSBmaW5nZXJwcmludCBmb3IgdHJhbnNtaXNzaW9uIChubyBET00gcmVmZXJlbmNlcykgKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJpYWxpemVGaW5nZXJwcmludChmcDogRmllbGRGaW5nZXJwcmludCk6IHN0cmluZyB7XG4gIHJldHVybiBbZnAuYXV0b2NvbXBsZXRlLCBmcC5uYW1lLCBmcC5pZCwgZnAuYXJpYUxhYmVsLCBmcC5sYWJlbFRleHQsIGZwLnBsYWNlaG9sZGVyXS5qb2luKCd8Jyk7XG59XG5cbi8qKiBFbnVtZXJhdGUgYWxsIGZpbGxhYmxlIGVsZW1lbnRzIG9uIHRoZSBwYWdlICovXG5leHBvcnQgZnVuY3Rpb24gZW51bWVyYXRlRmlsbGFibGUocm9vdDogRG9jdW1lbnQgfCBFbGVtZW50ID0gZG9jdW1lbnQpOiBGaWxsYWJsZUVsZW1lbnRbXSB7XG4gIGNvbnN0IHNlbGVjdG9yID0gW1xuICAgICdpbnB1dDpub3QoW3R5cGU9XCJmaWxlXCJdKTpub3QoW3R5cGU9XCJoaWRkZW5cIl0pOm5vdChbdHlwZT1cInN1Ym1pdFwiXSk6bm90KFt0eXBlPVwiYnV0dG9uXCJdKTpub3QoW3R5cGU9XCJyZXNldFwiXSk6bm90KFt0eXBlPVwiaW1hZ2VcIl0pOm5vdChbdHlwZT1cImNoZWNrYm94XCJdKTpub3QoW3R5cGU9XCJyYWRpb1wiXSknLFxuICAgICd0ZXh0YXJlYScsXG4gICAgJ3NlbGVjdCcsXG4gIF0uam9pbignLCcpO1xuXG4gIHJldHVybiBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxGaWxsYWJsZUVsZW1lbnQ+KHNlbGVjdG9yKSkuZmlsdGVyKChlbCkgPT4ge1xuICAgIC8vIFNraXAgZGlzYWJsZWQgLyByZWFkb25seSAob3B0aW9uYWw6IG1pZ2h0IHdhbnQgdG8gaGlnaGxpZ2h0IGJ1dCBub3QgZmlsbClcbiAgICBpZiAoKGVsIGFzIEhUTUxJbnB1dEVsZW1lbnQpLmRpc2FibGVkKSByZXR1cm4gZmFsc2U7XG4gICAgLy8gU2tpcCBjb25zZW50LWxpa2UgZmllbGRzIChuZXZlciB0b3VjaClcbiAgICBjb25zdCBjb25zZW50UGF0dGVybiA9IC9jb25zZW50fGdkcHJ8YWdyZWV8cHJpdmFjeXx0ZXJtcy9pO1xuICAgIGNvbnN0IGZwID0gYnVpbGRGaW5nZXJwcmludChlbCk7XG4gICAgY29uc3QgY29tYmluZWQgPSBbZnAubmFtZSwgZnAuaWQsIGZwLmFyaWFMYWJlbCwgZnAubGFiZWxUZXh0XS5qb2luKCcgJyk7XG4gICAgaWYgKGNvbnNlbnRQYXR0ZXJuLnRlc3QoY29tYmluZWQpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0pO1xufVxuIiwiLyoqXG4gKiBCaWxpbmd1YWwgKEVuZ2xpc2ggKyBDemVjaCkgcnVsZSBkaWN0aW9uYXJ5IGZvciBmaWVsZCBjbGFzc2lmaWNhdGlvbi5cbiAqIEFkZCBuZXcgcnVsZXMgaGVyZSB3aXRob3V0IHRvdWNoaW5nIGVuZ2luZSBjb2RlLlxuICovXG5cbmV4cG9ydCB0eXBlIEZpZWxkVHlwZSA9XG4gIHwgJ2ZpcnN0TmFtZSdcbiAgfCAnbGFzdE5hbWUnXG4gIHwgJ2Z1bGxOYW1lJ1xuICB8ICdlbWFpbCdcbiAgfCAncGhvbmUnXG4gIHwgJ2xpbmtlZGluJ1xuICB8ICdnaXRodWInXG4gIHwgJ3dlYnNpdGUnXG4gIHwgJ3NhbGFyeSdcbiAgfCAnY2l0eSdcbiAgfCAnY292ZXJMZXR0ZXInXG4gIHwgJ2F2YWlsYWJpbGl0eSdcbiAgfCAnd29ya1Blcm1pdCdcbiAgfCAnYWJvdXQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZpZWxkUnVsZSB7XG4gIHR5cGU6IEZpZWxkVHlwZTtcbiAgLyoqIEV4YWN0IGF1dG9jb21wbGV0ZSBhdHRyaWJ1dGUgdmFsdWVzIHRoYXQgdW5hbWJpZ3VvdXNseSBpZGVudGlmeSB0aGlzIGZpZWxkICovXG4gIGF1dG9jb21wbGV0ZTogc3RyaW5nW107XG4gIC8qKiBSZWdleCB0ZXN0ZWQgYWdhaW5zdCBuYW1lIC8gaWQgLyBsYWJlbCAvIHBsYWNlaG9sZGVyIC8gYXJpYS1sYWJlbCAvIGhlYWRpbmcgKi9cbiAgcGF0dGVybjogUmVnRXhwO1xufVxuXG5leHBvcnQgY29uc3QgRklFTERfUlVMRVM6IEZpZWxkUnVsZVtdID0gW1xuICB7XG4gICAgdHlwZTogJ2ZpcnN0TmFtZScsXG4gICAgYXV0b2NvbXBsZXRlOiBbJ2dpdmVuLW5hbWUnXSxcbiAgICBwYXR0ZXJuOiAvZmlyc3RbLlxcc18tXT9uYW1lfGdpdmVuWy5cXHNfLV0/bmFtZXxmb3JlbmFtZXxqbVtlw6ldbm98am1lbm98a8WZZXN0bltpw61dfGtyZXN0bmkvaSxcbiAgfSxcbiAge1xuICAgIHR5cGU6ICdsYXN0TmFtZScsXG4gICAgYXV0b2NvbXBsZXRlOiBbJ2ZhbWlseS1uYW1lJ10sXG4gICAgcGF0dGVybjogL2xhc3RbLlxcc18tXT9uYW1lfGZhbWlseVsuXFxzXy1dP25hbWV8c3VybmFtZXxwxZnDrWptZW5bacOtXXxwcmlqbWVuaS9pLFxuICB9LFxuICB7XG4gICAgdHlwZTogJ2Z1bGxOYW1lJyxcbiAgICBhdXRvY29tcGxldGU6IFsnbmFtZSddLFxuICAgIHBhdHRlcm46IC9cXGJmdWxsWy5cXHNfLV0/bmFtZVxcYnxjZWxbZcOpXVsuXFxzXy1dP2ptW2XDqV1uby9pLFxuICB9LFxuICB7XG4gICAgdHlwZTogJ2VtYWlsJyxcbiAgICBhdXRvY29tcGxldGU6IFsnZW1haWwnXSxcbiAgICBwYXR0ZXJuOiAvZS0/bWFpbC9pLFxuICB9LFxuICB7XG4gICAgdHlwZTogJ3Bob25lJyxcbiAgICBhdXRvY29tcGxldGU6IFsndGVsJywgJ3RlbC1uYXRpb25hbCddLFxuICAgIHBhdHRlcm46IC9waG9uZXx0ZWwoPyFsKVsuXFxzXy1dP3xtb2JpbHx0ZWxlZm9uL2ksXG4gIH0sXG4gIHtcbiAgICB0eXBlOiAnbGlua2VkaW4nLFxuICAgIGF1dG9jb21wbGV0ZTogW10sXG4gICAgcGF0dGVybjogL2xpbmtlZGluL2ksXG4gIH0sXG4gIHtcbiAgICB0eXBlOiAnZ2l0aHViJyxcbiAgICBhdXRvY29tcGxldGU6IFtdLFxuICAgIHBhdHRlcm46IC9naXRodWIvaSxcbiAgfSxcbiAge1xuICAgIHR5cGU6ICd3ZWJzaXRlJyxcbiAgICBhdXRvY29tcGxldGU6IFsndXJsJ10sXG4gICAgcGF0dGVybjogL3dlYnNpdGV8cG9ydGZvbGlvfHBlcnNvbmFsWy5cXHNfLV0/dXJsfHdlYlsuXFxzXy1dP3BhZ2V8b3NvYm5bacOtXVsuXFxzXy1dP3dlYi9pLFxuICB9LFxuICB7XG4gICAgdHlwZTogJ3NhbGFyeScsXG4gICAgYXV0b2NvbXBsZXRlOiBbXSxcbiAgICBwYXR0ZXJuOiAvc2FsYXJ5fGNvbXBlbnNhdGlvbnxtemRhfHBsYXRbLlxcc18tXXxvZG1bZcSbXW5hL2ksXG4gIH0sXG4gIHtcbiAgICB0eXBlOiAnY2l0eScsXG4gICAgYXV0b2NvbXBsZXRlOiBbJ2FkZHJlc3MtbGV2ZWwyJ10sXG4gICAgcGF0dGVybjogL1xcYmNpdHlcXGJ8bG9jYXRpb258bVtlxJtdc3RvfGFkcmVzYXxieWRsacWhdFtlxJtdL2ksXG4gIH0sXG4gIHtcbiAgICB0eXBlOiAnY292ZXJMZXR0ZXInLFxuICAgIGF1dG9jb21wbGV0ZTogW10sXG4gICAgcGF0dGVybjogL2NvdmVyWy5cXHNfLV0/bGV0dGVyfG1vdGl2YXR8cHLFr3ZvZG5bacOtXXxtb3RpdmHEjW5bacOtXS9pLFxuICB9LFxuICB7XG4gICAgdHlwZTogJ2F2YWlsYWJpbGl0eScsXG4gICAgYXV0b2NvbXBsZXRlOiBbXSxcbiAgICBwYXR0ZXJuOiAvYXZhaWxhYnxub3RpY2VbLlxcc18tXT9wZXJpb2R8c3RhcnRbLlxcc18tXT9kYXRlfG5hc3R1cHxkb3N0dXBub3N0L2ksXG4gIH0sXG4gIHtcbiAgICB0eXBlOiAnd29ya1Blcm1pdCcsXG4gICAgYXV0b2NvbXBsZXRlOiBbXSxcbiAgICBwYXR0ZXJuOiAvd29ya1suXFxzXy1dP3Blcm1pdHx2aXNhfGNpdGl6ZW58YXV0aG9yaXp8cHJhY292bltpw61dWy5cXHNfLV0/cG92b2xlbltpw61dL2ksXG4gIH0sXG4gIHtcbiAgICB0eXBlOiAnYWJvdXQnLFxuICAgIGF1dG9jb21wbGV0ZTogW10sXG4gICAgcGF0dGVybjogL1xcYmFib3V0XFxifFxcYnN1bW1hcnlcXGJ8XFxiYmlvXFxifHByb2ZpbFsuXFxzXy1dfHNvdWhybnxvWy5cXHNfLV1zb2JbZcSbXS9pLFxuICB9LFxuXTtcbiIsImltcG9ydCB0eXBlIHsgRmllbGRDb25maWRlbmNlIH0gZnJvbSAnLi4vdHlwZXMnO1xuaW1wb3J0IHR5cGUgeyBGaWVsZEZpbmdlcnByaW50IH0gZnJvbSAnLi9maW5nZXJwcmludCc7XG5pbXBvcnQgeyBGSUVMRF9SVUxFUywgdHlwZSBGaWVsZFR5cGUgfSBmcm9tICcuL2RpY3Rpb25hcnknO1xuXG5leHBvcnQgY29uc3QgSElHSF9USFJFU0hPTEQgPSA3MDtcbmV4cG9ydCBjb25zdCBNRURJVU1fVEhSRVNIT0xEID0gMzU7XG5cbi8qKiBUZXN0IGEgcGF0dGVybiBhZ2FpbnN0IHRoZSByYXcgc3RyaW5nIEFORCBpdHMgZGlhY3JpdGljcy1zdHJpcHBlZCBmb3JtICovXG5mdW5jdGlvbiB0ZXN0KHBhdHRlcm46IFJlZ0V4cCwgdmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIXZhbHVlKSByZXR1cm4gZmFsc2U7XG4gIGlmIChwYXR0ZXJuLnRlc3QodmFsdWUpKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3Qgc3RyaXBwZWQgPSB2YWx1ZS5ub3JtYWxpemUoJ05GRCcpLnJlcGxhY2UoL1tcXHUwMzAwLVxcdTAzNmZdL2csICcnKTtcbiAgcmV0dXJuIHN0cmlwcGVkICE9PSB2YWx1ZSAmJiBwYXR0ZXJuLnRlc3Qoc3RyaXBwZWQpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNjb3JlZE1hdGNoIHtcbiAgZmllbGRUeXBlOiBGaWVsZFR5cGU7XG4gIHNjb3JlOiBudW1iZXI7XG4gIGNvbmZpZGVuY2U6IEZpZWxkQ29uZmlkZW5jZTtcbn1cblxuLyoqXG4gKiBTY29yZSBhIHNpbmdsZSBmaWVsZCBmaW5nZXJwcmludCBhZ2FpbnN0IGFsbCBydWxlcy5cbiAqIFJldHVybnMgdGhlIGJlc3QgbWF0Y2ggb3IgbnVsbCBpZiBub3RoaW5nIG1hdGNoZWQuXG4gKlxuICogV2VpZ2h0IGxhZGRlciAoaGlnaGVzdCDihpIgbG93ZXN0KTpcbiAqICAgYXV0b2NvbXBsZXRlIGV4YWN0IG1hdGNoICDihpIgKzUwXG4gKiAgIG5hbWUgLyBpZCBtYXRjaCAgICAgICAgICAg4oaSICszMFxuICogICBhcmlhLWxhYmVsIG1hdGNoICAgICAgICAgIOKGkiArMjBcbiAqICAgbGFiZWwgdGV4dCBtYXRjaCAgICAgICAgICDihpIgKzIwXG4gKiAgIHBsYWNlaG9sZGVyIG1hdGNoICAgICAgICAg4oaSICsxNVxuICogICBjb250ZXh0IGhlYWRpbmcgbWF0Y2ggICAgIOKGkiArMTBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjb3JlRmllbGQoZnA6IEZpZWxkRmluZ2VycHJpbnQpOiBTY29yZWRNYXRjaCB8IG51bGwge1xuICBsZXQgYmVzdDogU2NvcmVkTWF0Y2ggfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IHJ1bGUgb2YgRklFTERfUlVMRVMpIHtcbiAgICBsZXQgc2NvcmUgPSAwO1xuXG4gICAgLy8gMS4gYXV0b2NvbXBsZXRlIGV4YWN0IG1hdGNoIOKAlCBoaWdoZXN0IHNpZ25hbCwgc3VmZmljaWVudCBmb3IgJ2hpZ2gnIGFsb25lXG4gICAgaWYgKHJ1bGUuYXV0b2NvbXBsZXRlLmxlbmd0aCA+IDAgJiYgZnAuYXV0b2NvbXBsZXRlKSB7XG4gICAgICBpZiAocnVsZS5hdXRvY29tcGxldGUuaW5jbHVkZXMoZnAuYXV0b2NvbXBsZXRlKSkgc2NvcmUgKz0gNzA7XG4gICAgfVxuXG4gICAgLy8gMi4gbmFtZSAvIGlkXG4gICAgaWYgKHRlc3QocnVsZS5wYXR0ZXJuLCBmcC5uYW1lKSB8fCB0ZXN0KHJ1bGUucGF0dGVybiwgZnAuaWQpKSBzY29yZSArPSAzMDtcblxuICAgIC8vIDMuIGFyaWEtbGFiZWxcbiAgICBpZiAodGVzdChydWxlLnBhdHRlcm4sIGZwLmFyaWFMYWJlbCkpIHNjb3JlICs9IDIwO1xuXG4gICAgLy8gNC4gbGFiZWwgdGV4dFxuICAgIGlmICh0ZXN0KHJ1bGUucGF0dGVybiwgZnAubGFiZWxUZXh0KSkgc2NvcmUgKz0gMjA7XG5cbiAgICAvLyA1LiBwbGFjZWhvbGRlclxuICAgIGlmICh0ZXN0KHJ1bGUucGF0dGVybiwgZnAucGxhY2Vob2xkZXIpKSBzY29yZSArPSAxNTtcblxuICAgIC8vIDYuIGNvbnRleHQgaGVhZGluZ1xuICAgIGlmICh0ZXN0KHJ1bGUucGF0dGVybiwgZnAuY29udGV4dEhlYWRpbmcpKSBzY29yZSArPSAxMDtcblxuICAgIGlmIChzY29yZSA+IDAgJiYgKCFiZXN0IHx8IHNjb3JlID4gYmVzdC5zY29yZSkpIHtcbiAgICAgIGNvbnN0IGNvbmZpZGVuY2U6IEZpZWxkQ29uZmlkZW5jZSA9XG4gICAgICAgIHNjb3JlID49IEhJR0hfVEhSRVNIT0xEID8gJ2hpZ2gnIDogc2NvcmUgPj0gTUVESVVNX1RIUkVTSE9MRCA/ICdtZWRpdW0nIDogJ2xvdyc7XG4gICAgICBiZXN0ID0geyBmaWVsZFR5cGU6IHJ1bGUudHlwZSwgc2NvcmUsIGNvbmZpZGVuY2UgfTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYmVzdDtcbn1cbiIsIi8qKlxuICogV3JpdGUgYSB2YWx1ZSBpbnRvIGEgZnJhbWV3b3JrLWNvbnRyb2xsZWQgaW5wdXQvdGV4dGFyZWEgd2hpbGVcbiAqIHRyaWdnZXJpbmcgdGhlIHN5bnRoZXRpYyBldmVudHMgUmVhY3QvVnVlL0FuZ3VsYXIgbGlzdGVuIHRvLlxuICpcbiAqIFNwZWM6IEZSLTMuMVxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0TmF0aXZlVmFsdWUoXG4gIGVsOiBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFRleHRBcmVhRWxlbWVudCxcbiAgdmFsdWU6IHN0cmluZyxcbik6IHZvaWQge1xuICBjb25zdCBwcm90byA9XG4gICAgZWwgaW5zdGFuY2VvZiBIVE1MVGV4dEFyZWFFbGVtZW50ID8gSFRNTFRleHRBcmVhRWxlbWVudC5wcm90b3R5cGUgOiBIVE1MSW5wdXRFbGVtZW50LnByb3RvdHlwZTtcbiAgY29uc3QgZGVzY3JpcHRvciA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IocHJvdG8sICd2YWx1ZScpO1xuICBpZiAoIWRlc2NyaXB0b3I/LnNldCkgcmV0dXJuO1xuICBkZXNjcmlwdG9yLnNldC5jYWxsKGVsLCB2YWx1ZSk7XG4gIGVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG4gIGVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xufVxuIiwiLyoqXG4gKiBTdHJhdGVneSBmb3IgZmlsbGluZyBuYXRpdmUgPHNlbGVjdD4gZWxlbWVudHMuXG4gKiBDaG9vc2VzIHRoZSBvcHRpb24gd2hvc2UgdGV4dCBvciB2YWx1ZSBiZXN0IG1hdGNoZXMgdGhlIHByb2ZpbGUgZGF0dW1cbiAqIChub3JtYWxpemVkLCBkaWFjcml0aWNzLWZvbGRlZCwgY2FzZS1pbnNlbnNpdGl2ZSkuXG4gKlxuICogUmV0dXJucyB0cnVlIGlmIGFuIG9wdGlvbiB3YXMgc2VsZWN0ZWQsIGZhbHNlIGlmIG5vbmUgbWF0Y2hlZC5cbiAqL1xuXG5jb25zdCBTSU1JTEFSSVRZX1RIUkVTSE9MRCA9IDAuNTtcblxuZnVuY3Rpb24gbm9ybWFsaXplKHN0cjogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHN0clxuICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgLm5vcm1hbGl6ZSgnTkZEJylcbiAgICAucmVwbGFjZSgvW1xcdTAzMDAtXFx1MDM2Zl0vZywgJycpXG4gICAgLnJlcGxhY2UoL1teXFx3XFxzXS9nLCAnJylcbiAgICAudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBjb250YWluc1Njb3JlKHNvdXJjZTogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGlmICghc291cmNlIHx8ICF0YXJnZXQpIHJldHVybiAwO1xuICBjb25zdCBzID0gbm9ybWFsaXplKHNvdXJjZSk7XG4gIGNvbnN0IHQgPSBub3JtYWxpemUodGFyZ2V0KTtcbiAgaWYgKHMgPT09IHQpIHJldHVybiAxO1xuICBpZiAocy5pbmNsdWRlcyh0KSB8fCB0LmluY2x1ZGVzKHMpKSByZXR1cm4gMC44O1xuICAvLyBXb3JkIG92ZXJsYXBcbiAgY29uc3Qgc1dvcmRzID0gbmV3IFNldChzLnNwbGl0KC9cXHMrLykpO1xuICBjb25zdCB0V29yZHMgPSB0LnNwbGl0KC9cXHMrLyk7XG4gIGNvbnN0IG92ZXJsYXAgPSB0V29yZHMuZmlsdGVyKCh3KSA9PiBzV29yZHMuaGFzKHcpKS5sZW5ndGg7XG4gIHJldHVybiBvdmVybGFwIC8gTWF0aC5tYXgoc1dvcmRzLnNpemUsIHRXb3Jkcy5sZW5ndGgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZmlsbFNlbGVjdChlbDogSFRNTFNlbGVjdEVsZW1lbnQsIHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgbGV0IGJlc3RJbmRleCA9IC0xO1xuICBsZXQgYmVzdFNjb3JlID0gMDtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGVsLm9wdGlvbnMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBvcHQgPSBlbC5vcHRpb25zW2ldO1xuICAgIGNvbnN0IHNjb3JlQnlUZXh0ID0gY29udGFpbnNTY29yZShvcHQudGV4dCwgdmFsdWUpO1xuICAgIGNvbnN0IHNjb3JlQnlWYWx1ZSA9IGNvbnRhaW5zU2NvcmUob3B0LnZhbHVlLCB2YWx1ZSk7XG4gICAgY29uc3Qgc2NvcmUgPSBNYXRoLm1heChzY29yZUJ5VGV4dCwgc2NvcmVCeVZhbHVlKTtcbiAgICBpZiAoc2NvcmUgPiBiZXN0U2NvcmUpIHtcbiAgICAgIGJlc3RTY29yZSA9IHNjb3JlO1xuICAgICAgYmVzdEluZGV4ID0gaTtcbiAgICB9XG4gIH1cblxuICBpZiAoYmVzdFNjb3JlID49IFNJTUlMQVJJVFlfVEhSRVNIT0xEICYmIGJlc3RJbmRleCA+PSAwKSB7XG4gICAgZWwuc2VsZWN0ZWRJbmRleCA9IGJlc3RJbmRleDtcbiAgICBlbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJywgeyBidWJibGVzOiB0cnVlIH0pKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cbiIsImltcG9ydCB0eXBlIHsgRmllbGRDb25maWRlbmNlIH0gZnJvbSAnLi4vdHlwZXMnO1xuXG5jb25zdCBTVFlMRV9JRCA9ICdfX2pvYmZpbGwtc3R5bGVzJztcbmNvbnN0IERJU01JU1NfQVRUUiA9ICdkYXRhLWpvYmZpbGwtZGlzbWlzcyc7XG5cbmNvbnN0IEhJR0hMSUdIVF9DU1MgPSBgXG4uX19qb2JmaWxsLWhpZ2gge1xuICBvdXRsaW5lOiAycHggc29saWQgIzIyYzU1ZSAhaW1wb3J0YW50O1xuICBvdXRsaW5lLW9mZnNldDogMXB4ICFpbXBvcnRhbnQ7XG4gIGJhY2tncm91bmQtY29sb3I6IHJnYmEoMzQsMTk3LDk0LDAuMDgpICFpbXBvcnRhbnQ7XG59XG4uX19qb2JmaWxsLW1lZGl1bSB7XG4gIG91dGxpbmU6IDJweCBzb2xpZCAjZWFiMzA4ICFpbXBvcnRhbnQ7XG4gIG91dGxpbmUtb2Zmc2V0OiAxcHggIWltcG9ydGFudDtcbiAgYmFja2dyb3VuZC1jb2xvcjogcmdiYSgyMzQsMTc5LDgsMC4wOCkgIWltcG9ydGFudDtcbn1cbi5fX2pvYmZpbGwtbG93LCAuX19qb2JmaWxsLW5vbmUge1xuICBvdXRsaW5lOiAycHggZGFzaGVkICM5Y2EzYWYgIWltcG9ydGFudDtcbiAgb3V0bGluZS1vZmZzZXQ6IDFweCAhaW1wb3J0YW50O1xufVxuLl9fam9iZmlsbC1maWxlIHtcbiAgb3V0bGluZTogMnB4IGRhc2hlZCAjM2I4MmY2ICFpbXBvcnRhbnQ7XG4gIG91dGxpbmUtb2Zmc2V0OiAxcHggIWltcG9ydGFudDtcbn1cbi5fX2pvYmZpbGwtYmFkZ2Uge1xuICBwb3NpdGlvbjogYWJzb2x1dGU7XG4gIHotaW5kZXg6IDIxNDc0ODM2NDc7XG4gIGZvbnQtc2l6ZTogMTBweDtcbiAgZm9udC1mYW1pbHk6IHN5c3RlbS11aSwgc2Fucy1zZXJpZjtcbiAgcGFkZGluZzogMnB4IDVweDtcbiAgYm9yZGVyLXJhZGl1czogM3B4O1xuICBwb2ludGVyLWV2ZW50czogbm9uZTtcbiAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgYmFja2dyb3VuZDogIzFlMjkzYjtcbiAgY29sb3I6ICNmMWY1Zjk7XG4gIGJveC1zaGFkb3c6IDAgMXB4IDNweCByZ2JhKDAsMCwwLC4zKTtcbn1cbmA7XG5cbmZ1bmN0aW9uIGVuc3VyZVN0eWxlcygpOiB2b2lkIHtcbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFNUWUxFX0lEKSkgcmV0dXJuO1xuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0eWxlJyk7XG4gIHN0eWxlLmlkID0gU1RZTEVfSUQ7XG4gIHN0eWxlLnRleHRDb250ZW50ID0gSElHSExJR0hUX0NTUztcbiAgZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChzdHlsZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBoaWdobGlnaHRGaWVsZChcbiAgZWw6IEhUTUxFbGVtZW50LFxuICBjb25maWRlbmNlOiBGaWVsZENvbmZpZGVuY2UgfCAnZmlsZScsXG4gIGR1cmF0aW9uTXM6IG51bWJlcixcbik6IHZvaWQge1xuICBlbnN1cmVTdHlsZXMoKTtcbiAgY29uc3QgY2xzID0gYF9fam9iZmlsbC0ke2NvbmZpZGVuY2V9YDtcbiAgZWwuY2xhc3NMaXN0LmFkZChjbHMpO1xuICBlbC5zZXRBdHRyaWJ1dGUoRElTTUlTU19BVFRSLCAnMScpO1xuXG4gIGNvbnN0IGRpc21pc3MgPSAoKSA9PiByZW1vdmVIaWdobGlnaHQoZWwsIGNscyk7XG4gIGVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZGlzbWlzcywgeyBvbmNlOiB0cnVlIH0pO1xuICBzZXRUaW1lb3V0KGRpc21pc3MsIGR1cmF0aW9uTXMpO1xufVxuXG5mdW5jdGlvbiByZW1vdmVIaWdobGlnaHQoZWw6IEhUTUxFbGVtZW50LCBjbHM6IHN0cmluZyk6IHZvaWQge1xuICBlbC5jbGFzc0xpc3QucmVtb3ZlKGNscyk7XG4gIGVsLnJlbW92ZUF0dHJpYnV0ZShESVNNSVNTX0FUVFIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlQWxsSGlnaGxpZ2h0cygpOiB2b2lkIHtcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oYFske0RJU01JU1NfQVRUUn1dYCkuZm9yRWFjaCgoZWwpID0+IHtcbiAgICBbJ2hpZ2gnLCAnbWVkaXVtJywgJ2xvdycsICdub25lJywgJ2ZpbGUnXS5mb3JFYWNoKChjKSA9PlxuICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZShgX19qb2JmaWxsLSR7Y31gKSxcbiAgICApO1xuICAgIGVsLnJlbW92ZUF0dHJpYnV0ZShESVNNSVNTX0FUVFIpO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVN0eWxlcygpOiB2b2lkIHtcbiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoU1RZTEVfSUQpPy5yZW1vdmUoKTtcbn1cbiIsImltcG9ydCB0eXBlIHsgUHJvZmlsZSwgRmlsbFN1bW1hcnkgfSBmcm9tICcuLi90eXBlcyc7XG5pbXBvcnQgeyBidWlsZEZpbmdlcnByaW50LCBlbnVtZXJhdGVGaWxsYWJsZSB9IGZyb20gJy4uL2ZpZWxkLW1hdGNoZXIvZmluZ2VycHJpbnQnO1xuaW1wb3J0IHsgc2NvcmVGaWVsZCB9IGZyb20gJy4uL2ZpZWxkLW1hdGNoZXIvc2NvcmVyJztcbmltcG9ydCB7IHNldE5hdGl2ZVZhbHVlIH0gZnJvbSAnLi9zZXROYXRpdmVWYWx1ZSc7XG5pbXBvcnQgeyBmaWxsU2VsZWN0IH0gZnJvbSAnLi9zZWxlY3RTdHJhdGVneSc7XG5pbXBvcnQgeyBoaWdobGlnaHRGaWVsZCB9IGZyb20gJy4vaGlnaGxpZ2h0JztcblxuLyoqIE1hcCBhIG1hdGNoZWQgZmllbGQgdHlwZSB0byB0aGUgY29ycmVzcG9uZGluZyBwcm9maWxlIHZhbHVlICovXG5mdW5jdGlvbiByZXNvbHZlVmFsdWUoZmllbGRUeXBlOiBzdHJpbmcsIHByb2ZpbGU6IFByb2ZpbGUpOiBzdHJpbmcge1xuICBjb25zdCBtYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgZmlyc3ROYW1lOiBwcm9maWxlLmZpcnN0TmFtZSxcbiAgICBsYXN0TmFtZTogcHJvZmlsZS5sYXN0TmFtZSxcbiAgICBmdWxsTmFtZTogYCR7cHJvZmlsZS5maXJzdE5hbWV9ICR7cHJvZmlsZS5sYXN0TmFtZX1gLnRyaW0oKSxcbiAgICBlbWFpbDogcHJvZmlsZS5lbWFpbCxcbiAgICBwaG9uZTogcHJvZmlsZS5waG9uZSxcbiAgICBsaW5rZWRpbjogcHJvZmlsZS5saW5rZWRpbixcbiAgICBnaXRodWI6IHByb2ZpbGUuZ2l0aHViLFxuICAgIHdlYnNpdGU6IHByb2ZpbGUud2Vic2l0ZSxcbiAgICBzYWxhcnk6IHByb2ZpbGUuc2FsYXJ5RXhwZWN0YXRpb24sXG4gICAgY2l0eTogcHJvZmlsZS5jaXR5LFxuICAgIGNvdmVyTGV0dGVyOiAnJywgLy8gcG9wdWxhdGVkIGJ5IHRlbXBsYXRlIHJlc29sdmVyXG4gICAgYXZhaWxhYmlsaXR5OiBwcm9maWxlLmF2YWlsYWJpbGl0eSxcbiAgICB3b3JrUGVybWl0OiBwcm9maWxlLndvcmtQZXJtaXQsXG4gICAgYWJvdXQ6IHByb2ZpbGUuYWJvdXQsXG4gIH07XG4gIHJldHVybiBtYXBbZmllbGRUeXBlXSA/PyAnJztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBGaWxsT3B0aW9ucyB7XG4gIGhpZ2hsaWdodER1cmF0aW9uTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogTWFpbiBmaWxsIGVudHJ5IHBvaW50LiAgRW51bWVyYXRlcyB0aGUgcGFnZSwgc2NvcmVzIGVhY2ggZmllbGQsXG4gKiBmaWxscyBoaWdoL21lZGl1bSBjb25maWRlbmNlIG9uZXMsIGhpZ2hsaWdodHMgZXZlcnl0aGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbGxQYWdlKHByb2ZpbGU6IFByb2ZpbGUsIG9wdHM6IEZpbGxPcHRpb25zID0ge30pOiBGaWxsU3VtbWFyeSB7XG4gIGNvbnN0IGR1cmF0aW9uTXMgPSBvcHRzLmhpZ2hsaWdodER1cmF0aW9uTXMgPz8gMzAwMDtcbiAgY29uc3QgZWxlbWVudHMgPSBlbnVtZXJhdGVGaWxsYWJsZSgpO1xuXG4gIGNvbnN0IHN1bW1hcnk6IEZpbGxTdW1tYXJ5ID0ge1xuICAgIHRvdGFsOiBlbGVtZW50cy5sZW5ndGgsXG4gICAgaGlnaDogMCxcbiAgICBtZWRpdW06IDAsXG4gICAgdW5yZWNvZ25pemVkOiAwLFxuICAgIGZpbGVJbnB1dHM6IDAsXG4gIH07XG5cbiAgLy8gSGlnaGxpZ2h0IGZpbGUgaW5wdXRzIHNlcGFyYXRlbHkgKG5ldmVyIGZpbGwpXG4gIGRvY3VtZW50XG4gICAgLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oJ2lucHV0W3R5cGU9XCJmaWxlXCJdJylcbiAgICAuZm9yRWFjaCgoZWwpID0+IHtcbiAgICAgIHN1bW1hcnkuZmlsZUlucHV0cysrO1xuICAgICAgaGlnaGxpZ2h0RmllbGQoZWwsICdmaWxlJywgZHVyYXRpb25Ncyk7XG4gICAgfSk7XG5cbiAgZm9yIChjb25zdCBlbCBvZiBlbGVtZW50cykge1xuICAgIGNvbnN0IGZwID0gYnVpbGRGaW5nZXJwcmludChlbCk7XG4gICAgY29uc3QgbWF0Y2ggPSBzY29yZUZpZWxkKGZwKTtcblxuICAgIGlmICghbWF0Y2ggfHwgbWF0Y2guY29uZmlkZW5jZSA9PT0gJ2xvdycgfHwgbWF0Y2guY29uZmlkZW5jZSA9PT0gJ25vbmUnKSB7XG4gICAgICBzdW1tYXJ5LnVucmVjb2duaXplZCsrO1xuICAgICAgaGlnaGxpZ2h0RmllbGQoZWwsICdub25lJywgZHVyYXRpb25Ncyk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB2YWx1ZSA9IHJlc29sdmVWYWx1ZShtYXRjaC5maWVsZFR5cGUsIHByb2ZpbGUpO1xuXG4gICAgaWYgKCF2YWx1ZSkge1xuICAgICAgLy8gRmllbGQgdHlwZSByZWNvZ25pemVkIGJ1dCBwcm9maWxlIHZhbHVlIGlzIGVtcHR5IOKAlCBza2lwIHNpbGVudGx5XG4gICAgICBzdW1tYXJ5LnVucmVjb2duaXplZCsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKGVsIGluc3RhbmNlb2YgSFRNTFNlbGVjdEVsZW1lbnQpIHtcbiAgICAgIGNvbnN0IGZpbGxlZCA9IGZpbGxTZWxlY3QoZWwsIHZhbHVlKTtcbiAgICAgIGlmIChmaWxsZWQpIHtcbiAgICAgICAgbWF0Y2guY29uZmlkZW5jZSA9PT0gJ2hpZ2gnID8gc3VtbWFyeS5oaWdoKysgOiBzdW1tYXJ5Lm1lZGl1bSsrO1xuICAgICAgICBoaWdobGlnaHRGaWVsZChlbCwgbWF0Y2guY29uZmlkZW5jZSwgZHVyYXRpb25Ncyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdW1tYXJ5LnVucmVjb2duaXplZCsrO1xuICAgICAgICBoaWdobGlnaHRGaWVsZChlbCwgJ25vbmUnLCBkdXJhdGlvbk1zKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgc2V0TmF0aXZlVmFsdWUoZWwsIHZhbHVlKTtcbiAgICAgIG1hdGNoLmNvbmZpZGVuY2UgPT09ICdoaWdoJyA/IHN1bW1hcnkuaGlnaCsrIDogc3VtbWFyeS5tZWRpdW0rKztcbiAgICAgIGhpZ2hsaWdodEZpZWxkKGVsLCBtYXRjaC5jb25maWRlbmNlLCBkdXJhdGlvbk1zKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gc3VtbWFyeTtcbn1cblxuZXhwb3J0IHsgc2V0TmF0aXZlVmFsdWUgfSBmcm9tICcuL3NldE5hdGl2ZVZhbHVlJztcbmV4cG9ydCB7IGZpbGxTZWxlY3QgfSBmcm9tICcuL3NlbGVjdFN0cmF0ZWd5JztcbmV4cG9ydCB7IGhpZ2hsaWdodEZpZWxkLCByZW1vdmVBbGxIaWdobGlnaHRzLCByZW1vdmVTdHlsZXMgfSBmcm9tICcuL2hpZ2hsaWdodCc7XG4iLCJpbXBvcnQgdHlwZSB7IEpvYkluZm8gfSBmcm9tICcuLi90eXBlcyc7XG5cbi8qKlxuICogRXh0cmFjdCBqb2IgaW5mbyBmcm9tIEpTT04tTEQgSm9iUG9zdGluZyBzdHJ1Y3R1cmVkIGRhdGEuXG4gKiBQcmlvcml0eTogbW9zdCByZWxpYWJsZSBzb3VyY2Ug4oCUIHByZXNlbnQgb24gbWFqb3Igam9iIGJvYXJkcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RGcm9tSnNvbkxkKGRvYzogRG9jdW1lbnQgPSBkb2N1bWVudCk6IFBhcnRpYWw8Sm9iSW5mbz4ge1xuICBjb25zdCBzY3JpcHRzID0gZG9jLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFNjcmlwdEVsZW1lbnQ+KCdzY3JpcHRbdHlwZT1cImFwcGxpY2F0aW9uL2xkK2pzb25cIl0nKTtcblxuICBmb3IgKGNvbnN0IHNjcmlwdCBvZiBzY3JpcHRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHNjcmlwdC50ZXh0Q29udGVudCA/PyAnJyk7XG4gICAgICBjb25zdCBub2RlczogdW5rbm93bltdID0gQXJyYXkuaXNBcnJheShkYXRhKSA/IGRhdGEgOiBbZGF0YV07XG5cbiAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgICAgICBjb25zdCBqb2JQb3N0aW5nID0gZmluZEpvYlBvc3Rpbmcobm9kZSk7XG4gICAgICAgIGlmIChqb2JQb3N0aW5nKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGNvbXBhbnk6IGpvYlBvc3RpbmcuaGlyaW5nT3JnYW5pemF0aW9uPy5uYW1lID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHBvc2l0aW9uOiBqb2JQb3N0aW5nLnRpdGxlID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBzdHJpcEh0bWwoam9iUG9zdGluZy5kZXNjcmlwdGlvbiA/PyAnJyksXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTWFsZm9ybWVkIEpTT04tTEQg4oCUIHNraXBcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge307XG59XG5cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG5mdW5jdGlvbiBmaW5kSm9iUG9zdGluZyhub2RlOiBhbnkpOiBhbnkgfCBudWxsIHtcbiAgaWYgKCFub2RlIHx8IHR5cGVvZiBub2RlICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgdHlwZSA9IG5vZGVbJ0B0eXBlJ107XG4gIGlmICh0eXBlID09PSAnSm9iUG9zdGluZycgfHwgKEFycmF5LmlzQXJyYXkodHlwZSkgJiYgdHlwZS5pbmNsdWRlcygnSm9iUG9zdGluZycpKSkge1xuICAgIHJldHVybiBub2RlO1xuICB9XG5cbiAgLy8gV2FsayBAZ3JhcGhcbiAgaWYgKEFycmF5LmlzQXJyYXkobm9kZVsnQGdyYXBoJ10pKSB7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIG5vZGVbJ0BncmFwaCddKSB7XG4gICAgICBjb25zdCBmb3VuZCA9IGZpbmRKb2JQb3N0aW5nKGl0ZW0pO1xuICAgICAgaWYgKGZvdW5kKSByZXR1cm4gZm91bmQ7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHN0cmlwSHRtbChodG1sOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gaHRtbC5yZXBsYWNlKC88W14+XSs+L2csICcgJykucmVwbGFjZSgvXFxzKy9nLCAnICcpLnRyaW0oKS5zbGljZSgwLCAyMDAwKTtcbn1cbiIsImltcG9ydCB0eXBlIHsgSm9iSW5mbyB9IGZyb20gJy4uL3R5cGVzJztcblxuLyoqXG4gKiBFeHRyYWN0IGpvYiBpbmZvIGZyb20gT3BlbiBHcmFwaCBtZXRhIHRhZ3MuXG4gKiBVc2VkIGFzIGEgZmFsbGJhY2sgd2hlbiBKU09OLUxEIGlzIGFic2VudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RGcm9tT3BlbkdyYXBoKGRvYzogRG9jdW1lbnQgPSBkb2N1bWVudCk6IFBhcnRpYWw8Sm9iSW5mbz4ge1xuICBjb25zdCBnZXQgPSAocHJvcGVydHk6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gICAgY29uc3QgZWwgPSBkb2MucXVlcnlTZWxlY3RvcjxIVE1MTWV0YUVsZW1lbnQ+KGBtZXRhW3Byb3BlcnR5PVwiJHtwcm9wZXJ0eX1cIl1gKTtcbiAgICByZXR1cm4gZWw/LmNvbnRlbnQ/LnRyaW0oKSB8fCB1bmRlZmluZWQ7XG4gIH07XG5cbiAgY29uc3QgdGl0bGUgPSBnZXQoJ29nOnRpdGxlJyk7XG4gIGNvbnN0IHNpdGVOYW1lID0gZ2V0KCdvZzpzaXRlX25hbWUnKTtcblxuICBpZiAoIXRpdGxlICYmICFzaXRlTmFtZSkgcmV0dXJuIHt9O1xuXG4gIC8vIG9nOnRpdGxlIGlzIHVzdWFsbHkgXCJKb2IgVGl0bGUgYXQgQ29tcGFueVwiIG9yIFwiSm9iIFRpdGxlIHwgQ29tcGFueVwiXG4gIGxldCBwb3NpdGlvbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgY29tcGFueTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG4gIGlmICh0aXRsZSkge1xuICAgIGNvbnN0IHNlcGFyYXRvcnMgPSBbJyBhdCAnLCAnIGJlaSAnLCAnIGNoZXogJywgJyBAICcsICcgfCAnLCAnIC0gJywgJyDigJQgJ107XG4gICAgZm9yIChjb25zdCBzZXAgb2Ygc2VwYXJhdG9ycykge1xuICAgICAgY29uc3QgaWR4ID0gdGl0bGUuaW5kZXhPZihzZXApO1xuICAgICAgaWYgKGlkeCA+IDApIHtcbiAgICAgICAgcG9zaXRpb24gPSB0aXRsZS5zbGljZSgwLCBpZHgpLnRyaW0oKTtcbiAgICAgICAgY29tcGFueSA9IHRpdGxlLnNsaWNlKGlkeCArIHNlcC5sZW5ndGgpLnRyaW0oKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghcG9zaXRpb24pIHBvc2l0aW9uID0gdGl0bGU7XG4gIH1cblxuICBpZiAoIWNvbXBhbnkgJiYgc2l0ZU5hbWUpIHtcbiAgICBjb21wYW55ID0gc2l0ZU5hbWU7XG4gIH1cblxuICByZXR1cm4geyBjb21wYW55LCBwb3NpdGlvbiB9O1xufVxuIiwiaW1wb3J0IHR5cGUgeyBKb2JJbmZvIH0gZnJvbSAnLi4vdHlwZXMnO1xuXG4vKipcbiAqIExhc3QtcmVzb3J0IGV4dHJhY3Rpb24gZnJvbSB0aGUgcGFnZSdzIDxoMT4gYW5kIDx0aXRsZT4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0RnJvbUhlYWRpbmdzKGRvYzogRG9jdW1lbnQgPSBkb2N1bWVudCk6IFBhcnRpYWw8Sm9iSW5mbz4ge1xuICBjb25zdCBoMSA9IGRvYy5xdWVyeVNlbGVjdG9yKCdoMScpPy50ZXh0Q29udGVudD8udHJpbSgpO1xuICBjb25zdCB0aXRsZVJhdyA9IGRvYy50aXRsZT8udHJpbSgpO1xuXG4gIC8vIFByZWZlciBIMSBhcyB0aGUgam9iIHRpdGxlIChtb3N0IHNwZWNpZmljIHZpc2libGUgaGVhZGluZylcbiAgY29uc3QgcG9zaXRpb24gPSBoMSB8fCB1bmRlZmluZWQ7XG5cbiAgLy8gRXh0cmFjdCBjb21wYW55IGZyb20gPHRpdGxlPjogXCJKb2IgVGl0bGUgLSBDb21wYW55IE5hbWUgfCBTaXRlXCJcbiAgbGV0IGNvbXBhbnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgaWYgKHRpdGxlUmF3KSB7XG4gICAgY29uc3Qgc2VwYXJhdG9ycyA9IFsnIC0gJywgJyB8ICcsICcg4oCUICcsICcgwrcgJywgJyBhdCAnLCAnIEAgJ107XG4gICAgZm9yIChjb25zdCBzZXAgb2Ygc2VwYXJhdG9ycykge1xuICAgICAgY29uc3QgcGFydHMgPSB0aXRsZVJhdy5zcGxpdChzZXApO1xuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+PSAyKSB7XG4gICAgICAgIGNvbnN0IGxhc3RQYXJ0ID0gcGFydHNbcGFydHMubGVuZ3RoIC0gMV0udHJpbSgpO1xuICAgICAgICBpZiAobGFzdFBhcnQubGVuZ3RoID4gMCAmJiBsYXN0UGFydC5sZW5ndGggPCA2MCkge1xuICAgICAgICAgIGNvbXBhbnkgPSBsYXN0UGFydDtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IHBvc2l0aW9uLCBjb21wYW55IH07XG59XG4iLCJpbXBvcnQgdHlwZSB7IEpvYkluZm8gfSBmcm9tICcuLi90eXBlcyc7XG5pbXBvcnQgeyBleHRyYWN0RnJvbUpzb25MZCB9IGZyb20gJy4vanNvbkxkJztcbmltcG9ydCB7IGV4dHJhY3RGcm9tT3BlbkdyYXBoIH0gZnJvbSAnLi9vcGVuR3JhcGgnO1xuaW1wb3J0IHsgZXh0cmFjdEZyb21IZWFkaW5ncyB9IGZyb20gJy4vaGVhZGluZ0hldXJpc3RpY3MnO1xuXG4vKipcbiAqIEV4dHJhY3Qgam9iIGluZm8gd2l0aCBmYWxsYmFjayBjaGFpbjpcbiAqICAgSlNPTi1MRCAobW9zdCByZWxpYWJsZSkg4oaSIE9wZW4gR3JhcGgg4oaSIGhlYWRpbmcgaGV1cmlzdGljc1xuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEpvYkluZm8oZG9jOiBEb2N1bWVudCA9IGRvY3VtZW50KTogSm9iSW5mbyB7XG4gIGNvbnN0IGpzb25MZCA9IGV4dHJhY3RGcm9tSnNvbkxkKGRvYyk7XG4gIGNvbnN0IG9nID0gZXh0cmFjdEZyb21PcGVuR3JhcGgoZG9jKTtcbiAgY29uc3QgaGVhZGluZ3MgPSBleHRyYWN0RnJvbUhlYWRpbmdzKGRvYyk7XG5cbiAgcmV0dXJuIHtcbiAgICBjb21wYW55OiBqc29uTGQuY29tcGFueSA/PyBvZy5jb21wYW55ID8/IGhlYWRpbmdzLmNvbXBhbnksXG4gICAgcG9zaXRpb246IGpzb25MZC5wb3NpdGlvbiA/PyBvZy5wb3NpdGlvbiA/PyBoZWFkaW5ncy5wb3NpdGlvbixcbiAgICBkZXNjcmlwdGlvbjoganNvbkxkLmRlc2NyaXB0aW9uLFxuICB9O1xufVxuXG5leHBvcnQgeyBleHRyYWN0RnJvbUpzb25MZCB9IGZyb20gJy4vanNvbkxkJztcbmV4cG9ydCB7IGV4dHJhY3RGcm9tT3BlbkdyYXBoIH0gZnJvbSAnLi9vcGVuR3JhcGgnO1xuZXhwb3J0IHsgZXh0cmFjdEZyb21IZWFkaW5ncyB9IGZyb20gJy4vaGVhZGluZ0hldXJpc3RpY3MnO1xuIiwiLy8g4pSA4pSA4pSAIERvbWFpbiB0eXBlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGludGVyZmFjZSBQcm9maWxlIHtcbiAgaWQ6IHN0cmluZztcbiAgLyoqIERpc3BsYXkgbGFiZWwsIGUuZy4gXCJGcm9udGVuZFwiLCBcIlFBXCIgKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgZmlyc3ROYW1lOiBzdHJpbmc7XG4gIGxhc3ROYW1lOiBzdHJpbmc7XG4gIGVtYWlsOiBzdHJpbmc7XG4gIC8qKiBFLjE2NCBmb3JtYXQsIGRlZmF1bHQgcmVnaW9uICs0MjAgKi9cbiAgcGhvbmU6IHN0cmluZztcbiAgY2l0eTogc3RyaW5nO1xuICBsaW5rZWRpbjogc3RyaW5nO1xuICBnaXRodWI6IHN0cmluZztcbiAgd2Vic2l0ZTogc3RyaW5nO1xuICBzYWxhcnlFeHBlY3RhdGlvbjogc3RyaW5nO1xuICBhdmFpbGFiaWxpdHk6IHN0cmluZztcbiAgd29ya1Blcm1pdDogc3RyaW5nO1xuICBhYm91dDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvdmVyVGVtcGxhdGUge1xuICBpZDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICAvKiogU3VwcG9ydHMge2NvbXBhbnl9LCB7cG9zaXRpb259LCB7c291cmNlfSBwbGFjZWhvbGRlcnMgKi9cbiAgYm9keTogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcGxpY2F0aW9uRW50cnkge1xuICBpZDogc3RyaW5nO1xuICB0aW1lc3RhbXA6IHN0cmluZzsgLy8gSVNPIDg2MDFcbiAgY29tcGFueTogc3RyaW5nO1xuICBwb3NpdGlvbjogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbiAgcHJvZmlsZUlkOiBzdHJpbmc7XG4gIHN0YXR1czogJ3N1Ym1pdHRlZCc7XG4gIHJlbW90ZVN5bmM6ICdvaycgfCAncGVuZGluZycgfCAnZmFpbGVkJztcbn1cblxuLy8g4pSA4pSA4pSAIFN0b3JhZ2Ugc2hhcGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKiogY2hyb21lLnN0b3JhZ2Uuc3luYyDigJQgY3Jvc3MtZGV2aWNlLCDiiaQgMTAwIEtCICovXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNEYXRhIHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgcHJvZmlsZXM6IFByb2ZpbGVbXTtcbiAgYWN0aXZlUHJvZmlsZUlkOiBzdHJpbmc7XG4gIGNvdmVyVGVtcGxhdGVzOiBDb3ZlclRlbXBsYXRlW107XG4gIHNldHRpbmdzOiBBcHBTZXR0aW5ncztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBTZXR0aW5ncyB7XG4gIGhpZ2hsaWdodER1cmF0aW9uTXM6IG51bWJlcjtcbiAgbG9nQmFja2VuZDogJ25vdGlvbicgfCAnc2hlZXRzJyB8ICdvZmYnO1xufVxuXG4vKiogY2hyb21lLnN0b3JhZ2UubG9jYWwg4oCUIHNlY3JldHMgKyBidWxreSBkYXRhLCBuZXZlciBzeW5jZWQgKi9cbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxEYXRhIHtcbiAgZ3JvcUFwaUtleT86IHN0cmluZztcbiAgZ3JvcU1vZGVsPzogc3RyaW5nO1xuICBub3Rpb25Ub2tlbj86IHN0cmluZztcbiAgbm90aW9uRGF0YWJhc2VJZD86IHN0cmluZztcbiAgc2hlZXRzRW5kcG9pbnQ/OiBzdHJpbmc7XG4gIGFwcGxpY2F0aW9uTG9nOiBBcHBsaWNhdGlvbkVudHJ5W107XG59XG5cbi8vIOKUgOKUgOKUgCBGaWVsZC1tYXRjaGluZyB0eXBlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IHR5cGUgRmllbGRDb25maWRlbmNlID0gJ2hpZ2gnIHwgJ21lZGl1bScgfCAnbG93JyB8ICdub25lJztcblxuZXhwb3J0IGludGVyZmFjZSBGaWVsZE1hdGNoIHtcbiAgZWxlbWVudDogSFRNTElucHV0RWxlbWVudCB8IEhUTUxUZXh0QXJlYUVsZW1lbnQgfCBIVE1MU2VsZWN0RWxlbWVudDtcbiAgZmllbGRUeXBlOiBzdHJpbmc7XG4gIGNvbmZpZGVuY2U6IEZpZWxkQ29uZmlkZW5jZTtcbiAgLyoqIFJlc29sdmVkIHZhbHVlIGZyb20gdGhlIGFjdGl2ZSBwcm9maWxlICovXG4gIHZhbHVlOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmlsbFN1bW1hcnkge1xuICB0b3RhbDogbnVtYmVyO1xuICBoaWdoOiBudW1iZXI7XG4gIG1lZGl1bTogbnVtYmVyO1xuICB1bnJlY29nbml6ZWQ6IG51bWJlcjtcbiAgZmlsZUlucHV0czogbnVtYmVyO1xufVxuXG4vLyDilIDilIDilIAgSm9iLWluZm8gZXh0cmFjdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGludGVyZmFjZSBKb2JJbmZvIHtcbiAgY29tcGFueT86IHN0cmluZztcbiAgcG9zaXRpb24/OiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xufVxuXG4vLyDilIDilIDilIAgRGVmYXVsdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTOiBBcHBTZXR0aW5ncyA9IHtcbiAgaGlnaGxpZ2h0RHVyYXRpb25NczogMzAwMCxcbiAgbG9nQmFja2VuZDogJ29mZicsXG59O1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TWU5DX0RBVEE6IFN5bmNEYXRhID0ge1xuICBzY2hlbWFWZXJzaW9uOiAxLFxuICBwcm9maWxlczogW10sXG4gIGFjdGl2ZVByb2ZpbGVJZDogJycsXG4gIGNvdmVyVGVtcGxhdGVzOiBbXSxcbiAgc2V0dGluZ3M6IERFRkFVTFRfU0VUVElOR1MsXG59O1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9MT0NBTF9EQVRBOiBQYXJ0aWFsPExvY2FsRGF0YT4gPSB7XG4gIGFwcGxpY2F0aW9uTG9nOiBbXSxcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFbXB0eVByb2ZpbGUob3ZlcnJpZGVzOiBQYXJ0aWFsPFByb2ZpbGU+ID0ge30pOiBQcm9maWxlIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogY3J5cHRvLnJhbmRvbVVVSUQoKSxcbiAgICBsYWJlbDogJ015IFByb2ZpbGUnLFxuICAgIGZpcnN0TmFtZTogJycsXG4gICAgbGFzdE5hbWU6ICcnLFxuICAgIGVtYWlsOiAnJyxcbiAgICBwaG9uZTogJycsXG4gICAgY2l0eTogJycsXG4gICAgbGlua2VkaW46ICcnLFxuICAgIGdpdGh1YjogJycsXG4gICAgd2Vic2l0ZTogJycsXG4gICAgc2FsYXJ5RXhwZWN0YXRpb246ICcnLFxuICAgIGF2YWlsYWJpbGl0eTogJycsXG4gICAgd29ya1Blcm1pdDogJycsXG4gICAgYWJvdXQ6ICcnLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cbiIsImltcG9ydCB0eXBlIHsgU3luY0RhdGEsIFByb2ZpbGUsIENvdmVyVGVtcGxhdGUsIEFwcFNldHRpbmdzIH0gZnJvbSAnLi4vdHlwZXMnO1xuaW1wb3J0IHsgREVGQVVMVF9TWU5DX0RBVEEgfSBmcm9tICcuLi90eXBlcyc7XG5cbmNvbnN0IFNUT1JBR0VfS0VZID0gJ2pvYmZpbGxfc3luYyc7XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFN5bmNEYXRhKCk6IFByb21pc2U8U3luY0RhdGE+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2Uuc3luYy5nZXQoU1RPUkFHRV9LRVkpO1xuICByZXR1cm4geyAuLi5ERUZBVUxUX1NZTkNfREFUQSwgLi4uKHJlc3VsdFtTVE9SQUdFX0tFWV0gYXMgUGFydGlhbDxTeW5jRGF0YT4pIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNldFN5bmNEYXRhKGRhdGE6IFBhcnRpYWw8U3luY0RhdGE+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBnZXRTeW5jRGF0YSgpO1xuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLnNldCh7IFtTVE9SQUdFX0tFWV06IHsgLi4uY3VycmVudCwgLi4uZGF0YSB9IH0pO1xufVxuXG4vLyDilIDilIDilIAgUHJvZmlsZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRQcm9maWxlcygpOiBQcm9taXNlPFByb2ZpbGVbXT4ge1xuICByZXR1cm4gKGF3YWl0IGdldFN5bmNEYXRhKCkpLnByb2ZpbGVzO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVByb2ZpbGVzKHByb2ZpbGVzOiBQcm9maWxlW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgc2V0U3luY0RhdGEoeyBwcm9maWxlcyB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEFjdGl2ZVByb2ZpbGVJZCgpOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gKGF3YWl0IGdldFN5bmNEYXRhKCkpLmFjdGl2ZVByb2ZpbGVJZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldEFjdGl2ZVByb2ZpbGVJZChpZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHNldFN5bmNEYXRhKHsgYWN0aXZlUHJvZmlsZUlkOiBpZCB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEFjdGl2ZVByb2ZpbGUoKTogUHJvbWlzZTxQcm9maWxlIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IHsgcHJvZmlsZXMsIGFjdGl2ZVByb2ZpbGVJZCB9ID0gYXdhaXQgZ2V0U3luY0RhdGEoKTtcbiAgcmV0dXJuIHByb2ZpbGVzLmZpbmQoKHApID0+IHAuaWQgPT09IGFjdGl2ZVByb2ZpbGVJZCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB1cHNlcnRQcm9maWxlKHByb2ZpbGU6IFByb2ZpbGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcHJvZmlsZXMgPSBhd2FpdCBnZXRQcm9maWxlcygpO1xuICBjb25zdCBpZHggPSBwcm9maWxlcy5maW5kSW5kZXgoKHApID0+IHAuaWQgPT09IHByb2ZpbGUuaWQpO1xuICBpZiAoaWR4ID49IDApIHtcbiAgICBwcm9maWxlc1tpZHhdID0gcHJvZmlsZTtcbiAgfSBlbHNlIHtcbiAgICBwcm9maWxlcy5wdXNoKHByb2ZpbGUpO1xuICB9XG4gIGF3YWl0IHNhdmVQcm9maWxlcyhwcm9maWxlcyk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZWxldGVQcm9maWxlKGlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcHJvZmlsZXMgPSBhd2FpdCBnZXRQcm9maWxlcygpO1xuICBhd2FpdCBzYXZlUHJvZmlsZXMocHJvZmlsZXMuZmlsdGVyKChwKSA9PiBwLmlkICE9PSBpZCkpO1xufVxuXG4vLyDilIDilIDilIAgQ292ZXIgdGVtcGxhdGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0Q292ZXJUZW1wbGF0ZXMoKTogUHJvbWlzZTxDb3ZlclRlbXBsYXRlW10+IHtcbiAgcmV0dXJuIChhd2FpdCBnZXRTeW5jRGF0YSgpKS5jb3ZlclRlbXBsYXRlcztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVDb3ZlclRlbXBsYXRlcyh0ZW1wbGF0ZXM6IENvdmVyVGVtcGxhdGVbXSk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCBzZXRTeW5jRGF0YSh7IGNvdmVyVGVtcGxhdGVzOiB0ZW1wbGF0ZXMgfSk7XG59XG5cbi8vIOKUgOKUgOKUgCBTZXR0aW5ncyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8QXBwU2V0dGluZ3M+IHtcbiAgcmV0dXJuIChhd2FpdCBnZXRTeW5jRGF0YSgpKS5zZXR0aW5ncztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncyhzZXR0aW5nczogUGFydGlhbDxBcHBTZXR0aW5ncz4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzKCk7XG4gIGF3YWl0IHNldFN5bmNEYXRhKHsgc2V0dGluZ3M6IHsgLi4uY3VycmVudCwgLi4uc2V0dGluZ3MgfSB9KTtcbn1cblxuLy8g4pSA4pSA4pSAIFNjaGVtYSBtYW5hZ2VtZW50IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0U3RvcmFnZVVzYWdlUGVyY2VudCgpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBjaHJvbWUuc3RvcmFnZS5zeW5jLmdldEJ5dGVzSW5Vc2UobnVsbCwgKGJ5dGVzKSA9PiB7XG4gICAgICByZXNvbHZlKE1hdGgucm91bmQoKGJ5dGVzIC8gY2hyb21lLnN0b3JhZ2Uuc3luYy5RVU9UQV9CWVRFUykgKiAxMDApKTtcbiAgICB9KTtcbiAgfSk7XG59XG5cbi8vIOKUgOKUgOKUgCBFeHBvcnQgLyBJbXBvcnQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleHBvcnRTeW5jRGF0YSgpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBkYXRhID0gYXdhaXQgZ2V0U3luY0RhdGEoKTtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDIpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW1wb3J0U3luY0RhdGEoanNvbjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShqc29uKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIEpTT04gZmlsZS4nKTtcbiAgfVxuXG4gIGlmIChcbiAgICB0eXBlb2YgcGFyc2VkICE9PSAnb2JqZWN0JyB8fFxuICAgIHBhcnNlZCA9PT0gbnVsbCB8fFxuICAgIChwYXJzZWQgYXMgU3luY0RhdGEpLnNjaGVtYVZlcnNpb24gIT09IDFcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdVbnJlY29nbmlzZWQgZmlsZSBmb3JtYXQuIEV4cGVjdGVkIEpvYkZpbGwgZXhwb3J0IHdpdGggc2NoZW1hVmVyc2lvbjogMS4nKTtcbiAgfVxuXG4gIGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMuc2V0KHsgW1NUT1JBR0VfS0VZXTogcGFyc2VkIH0pO1xufVxuIiwiaW1wb3J0IHsgZGVmaW5lQ29udGVudFNjcmlwdCB9IGZyb20gJ3d4dC91dGlscy9kZWZpbmUtY29udGVudC1zY3JpcHQnO1xuaW1wb3J0IHsgZmlsbFBhZ2UgfSBmcm9tICcuLi9zaGFyZWQvZmlsbGVyJztcbmltcG9ydCB7IGV4dHJhY3RKb2JJbmZvIH0gZnJvbSAnLi4vc2hhcmVkL2V4dHJhY3RvcnMnO1xuaW1wb3J0IHsgZ2V0QWN0aXZlUHJvZmlsZSwgZ2V0U2V0dGluZ3MgfSBmcm9tICcuLi9zaGFyZWQvc3RvcmFnZS9zeW5jJztcbmltcG9ydCB0eXBlIHsgUG9wdXBUb0NvbnRlbnRNZXNzYWdlIH0gZnJvbSAnLi4vc2hhcmVkL21lc3NhZ2VzJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29udGVudFNjcmlwdCh7XG4gIG1hdGNoZXM6IFsnPGFsbF91cmxzPiddLFxuICBhbGxGcmFtZXM6IHRydWUsXG4gIHJ1bkF0OiAnZG9jdW1lbnRfaWRsZScsXG5cbiAgbWFpbigpIHtcbiAgICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoXG4gICAgICAoXG4gICAgICAgIG1lc3NhZ2U6IFBvcHVwVG9Db250ZW50TWVzc2FnZSxcbiAgICAgICAgX3NlbmRlcixcbiAgICAgICAgc2VuZFJlc3BvbnNlOiAocmVzcG9uc2U6IHVua25vd24pID0+IHZvaWQsXG4gICAgICApID0+IHtcbiAgICAgICAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gJ0ZJTExfRk9STScpIHtcbiAgICAgICAgICBoYW5kbGVGaWxsKG1lc3NhZ2UucHJvZmlsZUlkKS50aGVuKHNlbmRSZXNwb25zZSkuY2F0Y2goKGVycjogRXJyb3IpID0+IHtcbiAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTsgLy8gYXN5bmNcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChtZXNzYWdlLnR5cGUgPT09ICdFWFRSQUNUX0pPQl9JTkZPJykge1xuICAgICAgICAgIGNvbnN0IGpvYkluZm8gPSBleHRyYWN0Sm9iSW5mbygpO1xuICAgICAgICAgIHNlbmRSZXNwb25zZSh7IHR5cGU6ICdKT0JfSU5GTycsIGpvYkluZm8gfSk7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICApO1xuICB9LFxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUZpbGwocHJvZmlsZUlkOiBzdHJpbmcpIHtcbiAgLy8gUmVzb2x2ZSB3aGljaCBwcm9maWxlIHRvIHVzZVxuICBsZXQgcHJvZmlsZSA9XG4gICAgcHJvZmlsZUlkICE9PSAnX19hY3RpdmVfXydcbiAgICAgID8gKGF3YWl0IGdldEFjdGl2ZVByb2ZpbGUoKSkgLy8gZmFsbGJhY2tcbiAgICAgIDogYXdhaXQgZ2V0QWN0aXZlUHJvZmlsZSgpO1xuXG4gIGlmICghcHJvZmlsZSkge1xuICAgIC8vIFRyeSBieSBleHBsaWNpdCBwcm9maWxlSWRcbiAgICBjb25zdCB7IGdldFByb2ZpbGVzIH0gPSBhd2FpdCBpbXBvcnQoJy4uL3NoYXJlZC9zdG9yYWdlL3N5bmMnKTtcbiAgICBjb25zdCBwcm9maWxlcyA9IGF3YWl0IGdldFByb2ZpbGVzKCk7XG4gICAgcHJvZmlsZSA9IHByb2ZpbGVzLmZpbmQoKHApID0+IHAuaWQgPT09IHByb2ZpbGVJZCk7XG4gIH1cblxuICBpZiAoIXByb2ZpbGUpIHtcbiAgICByZXR1cm4geyB0eXBlOiAnRklMTF9SRVNVTFQnLCBzdW1tYXJ5OiBudWxsLCBlcnJvcjogJ1Byb2ZpbGUgbm90IGZvdW5kLicgfTtcbiAgfVxuXG4gIGNvbnN0IHNldHRpbmdzID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcbiAgY29uc3Qgc3VtbWFyeSA9IGZpbGxQYWdlKHByb2ZpbGUsIHsgaGlnaGxpZ2h0RHVyYXRpb25Nczogc2V0dGluZ3MuaGlnaGxpZ2h0RHVyYXRpb25NcyB9KTtcbiAgcmV0dXJuIHsgdHlwZTogJ0ZJTExfUkVTVUxUJywgc3VtbWFyeSB9O1xufVxuIiwiLy8jcmVnaW9uIHNyYy91dGlscy9pbnRlcm5hbC9sb2dnZXIudHNcbmZ1bmN0aW9uIHByaW50KG1ldGhvZCwgLi4uYXJncykge1xuXHRpZiAoaW1wb3J0Lm1ldGEuZW52Lk1PREUgPT09IFwicHJvZHVjdGlvblwiKSByZXR1cm47XG5cdGlmICh0eXBlb2YgYXJnc1swXSA9PT0gXCJzdHJpbmdcIikgbWV0aG9kKGBbd3h0XSAke2FyZ3Muc2hpZnQoKX1gLCAuLi5hcmdzKTtcblx0ZWxzZSBtZXRob2QoXCJbd3h0XVwiLCAuLi5hcmdzKTtcbn1cbi8qKlxuKiBXcmFwcGVyIGFyb3VuZCBgY29uc29sZWAgd2l0aCBhIFwiW3d4dF1cIiBwcmVmaXhcbiovXG5jb25zdCBsb2dnZXIgPSB7XG5cdGRlYnVnOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5kZWJ1ZywgLi4uYXJncyksXG5cdGxvZzogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUubG9nLCAuLi5hcmdzKSxcblx0d2FybjogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUud2FybiwgLi4uYXJncyksXG5cdGVycm9yOiAoLi4uYXJncykgPT4gcHJpbnQoY29uc29sZS5lcnJvciwgLi4uYXJncylcbn07XG5cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgbG9nZ2VyIH07IiwiLy8gI3JlZ2lvbiBzbmlwcGV0XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IGdsb2JhbFRoaXMuYnJvd3Nlcj8ucnVudGltZT8uaWRcbiAgPyBnbG9iYWxUaGlzLmJyb3dzZXJcbiAgOiBnbG9iYWxUaGlzLmNocm9tZTtcbi8vICNlbmRyZWdpb24gc25pcHBldFxuIiwiaW1wb3J0IHsgYnJvd3NlciBhcyBicm93c2VyJDEgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuXG4vLyNyZWdpb24gc3JjL2Jyb3dzZXIudHNcbi8qKlxuKiBDb250YWlucyB0aGUgYGJyb3dzZXJgIGV4cG9ydCB3aGljaCB5b3Ugc2hvdWxkIHVzZSB0byBhY2Nlc3MgdGhlIGV4dGVuc2lvbiBBUElzIGluIHlvdXIgcHJvamVjdDpcbiogYGBgdHNcbiogaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gJ3d4dC9icm93c2VyJztcbipcbiogYnJvd3Nlci5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKCgpID0+IHtcbiogICAvLyAuLi5cbiogfSlcbiogYGBgXG4qIEBtb2R1bGUgd3h0L2Jyb3dzZXJcbiovXG5jb25zdCBicm93c2VyID0gYnJvd3NlciQxO1xuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGJyb3dzZXIgfTsiLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5cbi8vI3JlZ2lvbiBzcmMvdXRpbHMvaW50ZXJuYWwvY3VzdG9tLWV2ZW50cy50c1xudmFyIFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQgPSBjbGFzcyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IGV4dGVuZHMgRXZlbnQge1xuXHRzdGF0aWMgRVZFTlRfTkFNRSA9IGdldFVuaXF1ZUV2ZW50TmFtZShcInd4dDpsb2NhdGlvbmNoYW5nZVwiKTtcblx0Y29uc3RydWN0b3IobmV3VXJsLCBvbGRVcmwpIHtcblx0XHRzdXBlcihXeHRMb2NhdGlvbkNoYW5nZUV2ZW50LkVWRU5UX05BTUUsIHt9KTtcblx0XHR0aGlzLm5ld1VybCA9IG5ld1VybDtcblx0XHR0aGlzLm9sZFVybCA9IG9sZFVybDtcblx0fVxufTtcbi8qKlxuKiBSZXR1cm5zIGFuIGV2ZW50IG5hbWUgdW5pcXVlIHRvIHRoZSBleHRlbnNpb24gYW5kIGNvbnRlbnQgc2NyaXB0IHRoYXQncyBydW5uaW5nLlxuKi9cbmZ1bmN0aW9uIGdldFVuaXF1ZUV2ZW50TmFtZShldmVudE5hbWUpIHtcblx0cmV0dXJuIGAke2Jyb3dzZXI/LnJ1bnRpbWU/LmlkfToke2ltcG9ydC5tZXRhLmVudi5FTlRSWVBPSU5UfToke2V2ZW50TmFtZX1gO1xufVxuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQsIGdldFVuaXF1ZUV2ZW50TmFtZSB9OyIsImltcG9ydCB7IFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQgfSBmcm9tIFwiLi9jdXN0b20tZXZlbnRzLm1qc1wiO1xuXG4vLyNyZWdpb24gc3JjL3V0aWxzL2ludGVybmFsL2xvY2F0aW9uLXdhdGNoZXIudHNcbmNvbnN0IHN1cHBvcnRzTmF2aWdhdGlvbkFwaSA9IHR5cGVvZiBnbG9iYWxUaGlzLm5hdmlnYXRpb24/LmFkZEV2ZW50TGlzdGVuZXIgPT09IFwiZnVuY3Rpb25cIjtcbi8qKlxuKiBDcmVhdGUgYSB1dGlsIHRoYXQgd2F0Y2hlcyBmb3IgVVJMIGNoYW5nZXMsIGRpc3BhdGNoaW5nIHRoZSBjdXN0b20gZXZlbnQgd2hlbiBkZXRlY3RlZC4gU3RvcHNcbiogd2F0Y2hpbmcgd2hlbiBjb250ZW50IHNjcmlwdCBpcyBpbnZhbGlkYXRlZC4gVXNlcyBOYXZpZ2F0aW9uIEFQSSB3aGVuIGF2YWlsYWJsZSwgb3RoZXJ3aXNlXG4qIGZhbGxzIGJhY2sgdG8gcG9sbGluZy5cbiovXG5mdW5jdGlvbiBjcmVhdGVMb2NhdGlvbldhdGNoZXIoY3R4KSB7XG5cdGxldCBsYXN0VXJsO1xuXHRsZXQgd2F0Y2hpbmcgPSBmYWxzZTtcblx0cmV0dXJuIHsgcnVuKCkge1xuXHRcdGlmICh3YXRjaGluZykgcmV0dXJuO1xuXHRcdHdhdGNoaW5nID0gdHJ1ZTtcblx0XHRsYXN0VXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcblx0XHRpZiAoc3VwcG9ydHNOYXZpZ2F0aW9uQXBpKSBnbG9iYWxUaGlzLm5hdmlnYXRpb24uYWRkRXZlbnRMaXN0ZW5lcihcIm5hdmlnYXRlXCIsIChldmVudCkgPT4ge1xuXHRcdFx0Y29uc3QgbmV3VXJsID0gbmV3IFVSTChldmVudC5kZXN0aW5hdGlvbi51cmwpO1xuXHRcdFx0aWYgKG5ld1VybC5ocmVmID09PSBsYXN0VXJsLmhyZWYpIHJldHVybjtcblx0XHRcdHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50KG5ld1VybCwgbGFzdFVybCkpO1xuXHRcdFx0bGFzdFVybCA9IG5ld1VybDtcblx0XHR9LCB7IHNpZ25hbDogY3R4LnNpZ25hbCB9KTtcblx0XHRlbHNlIGN0eC5zZXRJbnRlcnZhbCgoKSA9PiB7XG5cdFx0XHRjb25zdCBuZXdVcmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuXHRcdFx0aWYgKG5ld1VybC5ocmVmICE9PSBsYXN0VXJsLmhyZWYpIHtcblx0XHRcdFx0d2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQobmV3VXJsLCBsYXN0VXJsKSk7XG5cdFx0XHRcdGxhc3RVcmwgPSBuZXdVcmw7XG5cdFx0XHR9XG5cdFx0fSwgMWUzKTtcblx0fSB9O1xufVxuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGNyZWF0ZUxvY2F0aW9uV2F0Y2hlciB9OyIsImltcG9ydCB7IGxvZ2dlciB9IGZyb20gXCIuL2ludGVybmFsL2xvZ2dlci5tanNcIjtcbmltcG9ydCB7IGdldFVuaXF1ZUV2ZW50TmFtZSB9IGZyb20gXCIuL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVMb2NhdGlvbldhdGNoZXIgfSBmcm9tIFwiLi9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLm1qc1wiO1xuaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuXG4vLyNyZWdpb24gc3JjL3V0aWxzL2NvbnRlbnQtc2NyaXB0LWNvbnRleHQudHNcbi8qKlxuKiBJbXBsZW1lbnRzIFtgQWJvcnRDb250cm9sbGVyYF0oaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL0Fib3J0Q29udHJvbGxlcikuXG4qIFVzZWQgdG8gZGV0ZWN0IGFuZCBzdG9wIGNvbnRlbnQgc2NyaXB0IGNvZGUgd2hlbiB0aGUgc2NyaXB0IGlzIGludmFsaWRhdGVkLlxuKlxuKiBJdCBhbHNvIHByb3ZpZGVzIHNldmVyYWwgdXRpbGl0aWVzIGxpa2UgYGN0eC5zZXRUaW1lb3V0YCBhbmQgYGN0eC5zZXRJbnRlcnZhbGAgdGhhdCBzaG91bGQgYmUgdXNlZCBpblxuKiBjb250ZW50IHNjcmlwdHMgaW5zdGVhZCBvZiBgd2luZG93LnNldFRpbWVvdXRgIG9yIGB3aW5kb3cuc2V0SW50ZXJ2YWxgLlxuKlxuKiBUbyBjcmVhdGUgY29udGV4dCBmb3IgdGVzdGluZywgeW91IGNhbiB1c2UgdGhlIGNsYXNzJ3MgY29uc3RydWN0b3I6XG4qXG4qIGBgYHRzXG4qIGltcG9ydCB7IENvbnRlbnRTY3JpcHRDb250ZXh0IH0gZnJvbSAnd3h0L3V0aWxzL2NvbnRlbnQtc2NyaXB0cy1jb250ZXh0JztcbipcbiogdGVzdChcInN0b3JhZ2UgbGlzdGVuZXIgc2hvdWxkIGJlIHJlbW92ZWQgd2hlbiBjb250ZXh0IGlzIGludmFsaWRhdGVkXCIsICgpID0+IHtcbiogICBjb25zdCBjdHggPSBuZXcgQ29udGVudFNjcmlwdENvbnRleHQoJ3Rlc3QnKTtcbiogICBjb25zdCBpdGVtID0gc3RvcmFnZS5kZWZpbmVJdGVtKFwibG9jYWw6Y291bnRcIiwgeyBkZWZhdWx0VmFsdWU6IDAgfSk7XG4qICAgY29uc3Qgd2F0Y2hlciA9IHZpLmZuKCk7XG4qXG4qICAgY29uc3QgdW53YXRjaCA9IGl0ZW0ud2F0Y2god2F0Y2hlcik7XG4qICAgY3R4Lm9uSW52YWxpZGF0ZWQodW53YXRjaCk7IC8vIExpc3RlbiBmb3IgaW52YWxpZGF0ZSBoZXJlXG4qXG4qICAgYXdhaXQgaXRlbS5zZXRWYWx1ZSgxKTtcbiogICBleHBlY3Qod2F0Y2hlcikudG9CZUNhbGxlZFRpbWVzKDEpO1xuKiAgIGV4cGVjdCh3YXRjaGVyKS50b0JlQ2FsbGVkV2l0aCgxLCAwKTtcbipcbiogICBjdHgubm90aWZ5SW52YWxpZGF0ZWQoKTsgLy8gVXNlIHRoaXMgZnVuY3Rpb24gdG8gaW52YWxpZGF0ZSB0aGUgY29udGV4dFxuKiAgIGF3YWl0IGl0ZW0uc2V0VmFsdWUoMik7XG4qICAgZXhwZWN0KHdhdGNoZXIpLnRvQmVDYWxsZWRUaW1lcygxKTtcbiogfSk7XG4qIGBgYFxuKi9cbnZhciBDb250ZW50U2NyaXB0Q29udGV4dCA9IGNsYXNzIENvbnRlbnRTY3JpcHRDb250ZXh0IHtcblx0c3RhdGljIFNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSA9IGdldFVuaXF1ZUV2ZW50TmFtZShcInd4dDpjb250ZW50LXNjcmlwdC1zdGFydGVkXCIpO1xuXHRpZDtcblx0YWJvcnRDb250cm9sbGVyO1xuXHRsb2NhdGlvbldhdGNoZXIgPSBjcmVhdGVMb2NhdGlvbldhdGNoZXIodGhpcyk7XG5cdGNvbnN0cnVjdG9yKGNvbnRlbnRTY3JpcHROYW1lLCBvcHRpb25zKSB7XG5cdFx0dGhpcy5jb250ZW50U2NyaXB0TmFtZSA9IGNvbnRlbnRTY3JpcHROYW1lO1xuXHRcdHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG5cdFx0dGhpcy5pZCA9IE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpO1xuXHRcdHRoaXMuYWJvcnRDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuXHRcdHRoaXMuc3RvcE9sZFNjcmlwdHMoKTtcblx0XHR0aGlzLmxpc3RlbkZvck5ld2VyU2NyaXB0cygpO1xuXHR9XG5cdGdldCBzaWduYWwoKSB7XG5cdFx0cmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLnNpZ25hbDtcblx0fVxuXHRhYm9ydChyZWFzb24pIHtcblx0XHRyZXR1cm4gdGhpcy5hYm9ydENvbnRyb2xsZXIuYWJvcnQocmVhc29uKTtcblx0fVxuXHRnZXQgaXNJbnZhbGlkKCkge1xuXHRcdGlmIChicm93c2VyLnJ1bnRpbWU/LmlkID09IG51bGwpIHRoaXMubm90aWZ5SW52YWxpZGF0ZWQoKTtcblx0XHRyZXR1cm4gdGhpcy5zaWduYWwuYWJvcnRlZDtcblx0fVxuXHRnZXQgaXNWYWxpZCgpIHtcblx0XHRyZXR1cm4gIXRoaXMuaXNJbnZhbGlkO1xuXHR9XG5cdC8qKlxuXHQqIEFkZCBhIGxpc3RlbmVyIHRoYXQgaXMgY2FsbGVkIHdoZW4gdGhlIGNvbnRlbnQgc2NyaXB0J3MgY29udGV4dCBpcyBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIEByZXR1cm5zIEEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cblx0KlxuXHQqIEBleGFtcGxlXG5cdCogYnJvd3Nlci5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihjYik7XG5cdCogY29uc3QgcmVtb3ZlSW52YWxpZGF0ZWRMaXN0ZW5lciA9IGN0eC5vbkludmFsaWRhdGVkKCgpID0+IHtcblx0KiAgIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIoY2IpO1xuXHQqIH0pXG5cdCogLy8gLi4uXG5cdCogcmVtb3ZlSW52YWxpZGF0ZWRMaXN0ZW5lcigpO1xuXHQqL1xuXHRvbkludmFsaWRhdGVkKGNiKSB7XG5cdFx0dGhpcy5zaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcblx0XHRyZXR1cm4gKCkgPT4gdGhpcy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcblx0fVxuXHQvKipcblx0KiBSZXR1cm4gYSBwcm9taXNlIHRoYXQgbmV2ZXIgcmVzb2x2ZXMuIFVzZWZ1bCBpZiB5b3UgaGF2ZSBhbiBhc3luYyBmdW5jdGlvbiB0aGF0IHNob3VsZG4ndCBydW5cblx0KiBhZnRlciB0aGUgY29udGV4dCBpcyBleHBpcmVkLlxuXHQqXG5cdCogQGV4YW1wbGVcblx0KiBjb25zdCBnZXRWYWx1ZUZyb21TdG9yYWdlID0gYXN5bmMgKCkgPT4ge1xuXHQqICAgaWYgKGN0eC5pc0ludmFsaWQpIHJldHVybiBjdHguYmxvY2soKTtcblx0KlxuXHQqICAgLy8gLi4uXG5cdCogfVxuXHQqL1xuXHRibG9jaygpIHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKCkgPT4ge30pO1xuXHR9XG5cdC8qKlxuXHQqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0SW50ZXJ2YWxgIHRoYXQgYXV0b21hdGljYWxseSBjbGVhcnMgdGhlIGludGVydmFsIHdoZW4gaW52YWxpZGF0ZWQuXG5cdCpcblx0KiBJbnRlcnZhbHMgY2FuIGJlIGNsZWFyZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjbGVhckludGVydmFsYCBmdW5jdGlvbi5cblx0Ki9cblx0c2V0SW50ZXJ2YWwoaGFuZGxlciwgdGltZW91dCkge1xuXHRcdGNvbnN0IGlkID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMuaXNWYWxpZCkgaGFuZGxlcigpO1xuXHRcdH0sIHRpbWVvdXQpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjbGVhckludGVydmFsKGlkKSk7XG5cdFx0cmV0dXJuIGlkO1xuXHR9XG5cdC8qKlxuXHQqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0VGltZW91dGAgdGhhdCBhdXRvbWF0aWNhbGx5IGNsZWFycyB0aGUgaW50ZXJ2YWwgd2hlbiBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIFRpbWVvdXRzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgc2V0VGltZW91dGAgZnVuY3Rpb24uXG5cdCovXG5cdHNldFRpbWVvdXQoaGFuZGxlciwgdGltZW91dCkge1xuXHRcdGNvbnN0IGlkID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRpZiAodGhpcy5pc1ZhbGlkKSBoYW5kbGVyKCk7XG5cdFx0fSwgdGltZW91dCk7XG5cdFx0dGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNsZWFyVGltZW91dChpZCkpO1xuXHRcdHJldHVybiBpZDtcblx0fVxuXHQvKipcblx0KiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnJlcXVlc3RBbmltYXRpb25GcmFtZWAgdGhhdCBhdXRvbWF0aWNhbGx5IGNhbmNlbHMgdGhlIHJlcXVlc3Qgd2hlblxuXHQqIGludmFsaWRhdGVkLlxuXHQqXG5cdCogQ2FsbGJhY2tzIGNhbiBiZSBjYW5jZWxlZCBieSBjYWxsaW5nIHRoZSBub3JtYWwgYGNhbmNlbEFuaW1hdGlvbkZyYW1lYCBmdW5jdGlvbi5cblx0Ki9cblx0cmVxdWVzdEFuaW1hdGlvbkZyYW1lKGNhbGxiYWNrKSB7XG5cdFx0Y29uc3QgaWQgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKC4uLmFyZ3MpID0+IHtcblx0XHRcdGlmICh0aGlzLmlzVmFsaWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuXHRcdH0pO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxBbmltYXRpb25GcmFtZShpZCkpO1xuXHRcdHJldHVybiBpZDtcblx0fVxuXHQvKipcblx0KiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnJlcXVlc3RJZGxlQ2FsbGJhY2tgIHRoYXQgYXV0b21hdGljYWxseSBjYW5jZWxzIHRoZSByZXF1ZXN0IHdoZW5cblx0KiBpbnZhbGlkYXRlZC5cblx0KlxuXHQqIENhbGxiYWNrcyBjYW4gYmUgY2FuY2VsZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjYW5jZWxJZGxlQ2FsbGJhY2tgIGZ1bmN0aW9uLlxuXHQqL1xuXHRyZXF1ZXN0SWRsZUNhbGxiYWNrKGNhbGxiYWNrLCBvcHRpb25zKSB7XG5cdFx0Y29uc3QgaWQgPSByZXF1ZXN0SWRsZUNhbGxiYWNrKCguLi5hcmdzKSA9PiB7XG5cdFx0XHRpZiAoIXRoaXMuc2lnbmFsLmFib3J0ZWQpIGNhbGxiYWNrKC4uLmFyZ3MpO1xuXHRcdH0sIG9wdGlvbnMpO1xuXHRcdHRoaXMub25JbnZhbGlkYXRlZCgoKSA9PiBjYW5jZWxJZGxlQ2FsbGJhY2soaWQpKTtcblx0XHRyZXR1cm4gaWQ7XG5cdH1cblx0YWRkRXZlbnRMaXN0ZW5lcih0YXJnZXQsIHR5cGUsIGhhbmRsZXIsIG9wdGlvbnMpIHtcblx0XHRpZiAodHlwZSA9PT0gXCJ3eHQ6bG9jYXRpb25jaGFuZ2VcIikge1xuXHRcdFx0aWYgKHRoaXMuaXNWYWxpZCkgdGhpcy5sb2NhdGlvbldhdGNoZXIucnVuKCk7XG5cdFx0fVxuXHRcdHRhcmdldC5hZGRFdmVudExpc3RlbmVyPy4odHlwZS5zdGFydHNXaXRoKFwid3h0OlwiKSA/IGdldFVuaXF1ZUV2ZW50TmFtZSh0eXBlKSA6IHR5cGUsIGhhbmRsZXIsIHtcblx0XHRcdC4uLm9wdGlvbnMsXG5cdFx0XHRzaWduYWw6IHRoaXMuc2lnbmFsXG5cdFx0fSk7XG5cdH1cblx0LyoqXG5cdCogQGludGVybmFsXG5cdCogQWJvcnQgdGhlIGFib3J0IGNvbnRyb2xsZXIgYW5kIGV4ZWN1dGUgYWxsIGBvbkludmFsaWRhdGVkYCBsaXN0ZW5lcnMuXG5cdCovXG5cdG5vdGlmeUludmFsaWRhdGVkKCkge1xuXHRcdHRoaXMuYWJvcnQoXCJDb250ZW50IHNjcmlwdCBjb250ZXh0IGludmFsaWRhdGVkXCIpO1xuXHRcdGxvZ2dlci5kZWJ1ZyhgQ29udGVudCBzY3JpcHQgXCIke3RoaXMuY29udGVudFNjcmlwdE5hbWV9XCIgY29udGV4dCBpbnZhbGlkYXRlZGApO1xuXHR9XG5cdHN0b3BPbGRTY3JpcHRzKCkge1xuXHRcdGRvY3VtZW50LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KENvbnRlbnRTY3JpcHRDb250ZXh0LlNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSwgeyBkZXRhaWw6IHtcblx0XHRcdGNvbnRlbnRTY3JpcHROYW1lOiB0aGlzLmNvbnRlbnRTY3JpcHROYW1lLFxuXHRcdFx0bWVzc2FnZUlkOiB0aGlzLmlkXG5cdFx0fSB9KSk7XG5cdFx0d2luZG93LnBvc3RNZXNzYWdlKHtcblx0XHRcdHR5cGU6IENvbnRlbnRTY3JpcHRDb250ZXh0LlNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSxcblx0XHRcdGNvbnRlbnRTY3JpcHROYW1lOiB0aGlzLmNvbnRlbnRTY3JpcHROYW1lLFxuXHRcdFx0bWVzc2FnZUlkOiB0aGlzLmlkXG5cdFx0fSwgXCIqXCIpO1xuXHR9XG5cdHZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkge1xuXHRcdGNvbnN0IGlzU2FtZUNvbnRlbnRTY3JpcHQgPSBldmVudC5kZXRhaWw/LmNvbnRlbnRTY3JpcHROYW1lID09PSB0aGlzLmNvbnRlbnRTY3JpcHROYW1lO1xuXHRcdGNvbnN0IGlzRnJvbVNlbGYgPSBldmVudC5kZXRhaWw/Lm1lc3NhZ2VJZCA9PT0gdGhpcy5pZDtcblx0XHRyZXR1cm4gaXNTYW1lQ29udGVudFNjcmlwdCAmJiAhaXNGcm9tU2VsZjtcblx0fVxuXHRsaXN0ZW5Gb3JOZXdlclNjcmlwdHMoKSB7XG5cdFx0Y29uc3QgY2IgPSAoZXZlbnQpID0+IHtcblx0XHRcdGlmICghKGV2ZW50IGluc3RhbmNlb2YgQ3VzdG9tRXZlbnQpIHx8ICF0aGlzLnZlcmlmeVNjcmlwdFN0YXJ0ZWRFdmVudChldmVudCkpIHJldHVybjtcblx0XHRcdHRoaXMubm90aWZ5SW52YWxpZGF0ZWQoKTtcblx0XHR9O1xuXHRcdGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFLCBjYik7XG5cdFx0dGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoQ29udGVudFNjcmlwdENvbnRleHQuU0NSSVBUX1NUQVJURURfTUVTU0FHRV9UWVBFLCBjYikpO1xuXHR9XG59O1xuXG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IENvbnRlbnRTY3JpcHRDb250ZXh0IH07Il0sIm5hbWVzIjpbImRlZmluaXRpb24iLCJyZXN1bHQiLCJnZXRQcm9maWxlcyIsInByaW50IiwibG9nZ2VyIiwiYnJvd3NlciIsIld4dExvY2F0aW9uQ2hhbmdlRXZlbnQiLCJDb250ZW50U2NyaXB0Q29udGV4dCJdLCJtYXBwaW5ncyI6Ijs7QUFDQSxXQUFTLG9CQUFvQkEsYUFBWTtBQUN4QyxXQUFPQTtBQUFBLEVBQ1I7QUNtQkEsV0FBUyxhQUFhLElBQXlCO0FBRTdDLFVBQU0sS0FBSyxHQUFHLGFBQWEsSUFBSTtBQUMvQixRQUFJLElBQUk7QUFDTixZQUFNLFFBQVEsR0FBRyxjQUFjO0FBQUEsUUFDN0IsY0FBYyxJQUFJLE9BQU8sRUFBRSxDQUFDO0FBQUEsTUFBQTtBQUU5QixVQUFJLE1BQU8sUUFBTyxNQUFNLGFBQWEsVUFBVTtBQUFBLElBQ2pEO0FBR0EsVUFBTSxXQUFXLEdBQUcsUUFBUSxPQUFPO0FBQ25DLFFBQUksVUFBVTtBQUNaLFlBQU0sUUFBUSxTQUFTLFVBQVUsSUFBSTtBQUNyQyxZQUFNLGlCQUFpQix1QkFBdUIsRUFBRSxRQUFRLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFDekUsYUFBTyxNQUFNLGFBQWEsS0FBQSxLQUFVO0FBQUEsSUFDdEM7QUFHQSxVQUFNLGFBQWEsR0FBRyxhQUFhLGlCQUFpQjtBQUNwRCxRQUFJLFlBQVk7QUFDZCxZQUFNLFVBQVUsR0FBRyxjQUFjLGVBQWUsVUFBVTtBQUMxRCxVQUFJLFFBQVMsUUFBTyxRQUFRLGFBQWEsVUFBVTtBQUFBLElBQ3JEO0FBRUEsV0FBTztBQUFBLEVBQ1Q7QUFFQSxXQUFTLGtCQUFrQixJQUF5QjtBQUNsRCxRQUFJLE9BQXVCO0FBQzNCLFdBQU8sUUFBUSxTQUFTLEdBQUcsY0FBYyxNQUFNO0FBQzdDLFVBQUksT0FBdUIsS0FBSztBQUNoQyxhQUFPLE1BQU07QUFDWCxjQUFNLE1BQU0sS0FBSyxRQUFRLFlBQUE7QUFDekIsWUFBSSxXQUFXLEtBQUssR0FBRyxLQUFLLFFBQVEsWUFBWSxRQUFR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SyxPQUFPLFFBQVMsVUFBUyxHQUFHLElBQUk7QUFBQSxNQUMzQyxHQUFHLE9BQU87QUFDVixXQUFLLGNBQWMsTUFBTSxtQkFBbUIsRUFBRSxDQUFDO0FBQy9DLGFBQU87QUFBQSxJQUNSO0FBQUEsSUFDQSxpQkFBaUIsUUFBUSxNQUFNLFNBQVMsU0FBUztBQUNoRCxVQUFJLFNBQVMsc0JBQXNCO0FBQ2xDLFlBQUksS0FBSyxRQUFTLE1BQUssZ0JBQWdCLElBQUc7QUFBQSxNQUMzQztBQUNBLGFBQU8sbUJBQW1CLEtBQUssV0FBVyxNQUFNLElBQUksbUJBQW1CLElBQUksSUFBSSxNQUFNLFNBQVM7QUFBQSxRQUM3RixHQUFHO0FBQUEsUUFDSCxRQUFRLEtBQUs7QUFBQSxNQUNoQixDQUFHO0FBQUEsSUFDRjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFLQSxvQkFBb0I7QUFDbkIsV0FBSyxNQUFNLG9DQUFvQztBQUMvQ0gsZUFBTyxNQUFNLG1CQUFtQixLQUFLLGlCQUFpQix1QkFBdUI7QUFBQSxJQUM5RTtBQUFBLElBQ0EsaUJBQWlCO0FBQ2hCLGVBQVMsY0FBYyxJQUFJLFlBQVlHLHNCQUFxQiw2QkFBNkIsRUFBRSxRQUFRO0FBQUEsUUFDbEcsbUJBQW1CLEtBQUs7QUFBQSxRQUN4QixXQUFXLEtBQUs7QUFBQSxNQUNuQixFQUFHLENBQUUsQ0FBQztBQUNKLGFBQU8sWUFBWTtBQUFBLFFBQ2xCLE1BQU1BLHNCQUFxQjtBQUFBLFFBQzNCLG1CQUFtQixLQUFLO0FBQUEsUUFDeEIsV0FBVyxLQUFLO0FBQUEsTUFDbkIsR0FBSyxHQUFHO0FBQUEsSUFDUDtBQUFBLElBQ0EseUJBQXlCLE9BQU87QUFDL0IsWUFBTSxzQkFBc0IsTUFBTSxRQUFRLHNCQUFzQixLQUFLO0FBQ3JFLFlBQU0sYUFBYSxNQUFNLFFBQVEsY0FBYyxLQUFLO0FBQ3BELGFBQU8sdUJBQXVCLENBQUM7QUFBQSxJQUNoQztBQUFBLElBQ0Esd0JBQXdCO0FBQ3ZCLFlBQU0sS0FBSyxDQUFDLFVBQVU7QUFDckIsWUFBSSxFQUFFLGlCQUFpQixnQkFBZ0IsQ0FBQyxLQUFLLHlCQUF5QixLQUFLLEVBQUc7QUFDOUUsYUFBSyxrQkFBaUI7QUFBQSxNQUN2QjtBQUNBLGVBQVMsaUJBQWlCQSxzQkFBcUIsNkJBQTZCLEVBQUU7QUFDOUUsV0FBSyxjQUFjLE1BQU0sU0FBUyxvQkFBb0JBLHNCQUFxQiw2QkFBNkIsRUFBRSxDQUFDO0FBQUEsSUFDNUc7QUFBQSxFQUNEOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OyIsInhfZ29vZ2xlX2lnbm9yZUxpc3QiOlswLDE1LDE2LDE3LDE4LDE5LDIwXX0=
content;