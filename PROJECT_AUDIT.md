# JobFill — Full Technical Audit

**Date:** 14 August 2026
**Project version:** 1.0.0 (commit `3f5ddaf`)
**Method:** reading the entire source (~1900 lines), running the whole toolchain (`compile` / `lint` / `test` / `build`), rendering the built extension pages in headless Chrome against a stubbed `chrome.*` API, measuring layout metrics and contrast ratios per WCAG 2.1.

---

## Fix Status

> **How to read this document.** Sections §0–§9 below are a snapshot of the state
> **before** the remediation work. They are deliberately left unrewritten: the value
> of an audit is that the defects are recorded together with what they looked like.
> This table turns the document into a tracker: it says which of the findings are
> already out of date and which still stand.
>
> Rule for filling it in: a status is assigned from the code or from the built
> manifest, never from intent. "Deliberately deferred" is not "we ran out of time";
> it is a decision with a recorded price. Such items are mirrored in the spec,
> §11.1 "Accepted Trade-offs", so that nobody reopens them as bugs.

### P0 — release blockers

| Item | Status | Evidence |
|---|---|---|
| **P0-1** CI is red, 3 of 5 steps fail | **fixed** | All five steps are green, verified by running them: `npm run lint` — 0 errors (was 11,425); `npm run compile` — 0 errors; `npm run coverage` — **609 tests across 10 files**, exit 0, thresholds pass; `npm run build` and `npm run build:firefox` — both succeed. Coverage of `shared/**`: **91.31% lines, 89.68% statements, 84% branches, 84.96% functions** (was 553 tests / 91% / 89.2% / 82.91% / 84.61%). The thresholds in `vitest.config.ts` are two-tier: per-directory percentages plus a repo-wide budget of uncovered code (negative values). The coverage numbers are a ratchet: they are to be lowered as tests appear. |
| **P0-2** v5 unreachable from the UI | **fixed** | `entrypoints/popup/App.tsx` → `handleLogApplication` sends `LOG_APPLICATION`; `entrypoints/background.ts` → `handleLogApplication` writes the local copy and schedules the retry. This is the only path that creates an `ApplicationEntry`. |
| **P0-3** `<all_urls>` + `all_frames` in defiance of NFR-2 | **partial / deliberately deferred** | In the built `manifest.json`: `matches` = `http://*/*` + `https://*/*`, eight `exclude_matches`, seven `exclude_globs`. The move to `activeTab` + `chrome.scripting.executeScript` has **not** happened — it breaks the inline button. The reason and the price are recorded in the spec under NFR-2 and §11.1 (T-1). `all_frames: true` is still there. On the other hand, the permission set has ended up **narrower**, not wider as it was at the previous review: `permissions` = `storage`, `activeTab`, `alarms` — that is all, in both builds (verified with `python3 -m json.tool` against both built manifests). `webNavigation` is gone (see P0-5), `scripting` is gone (it was never called anywhere: `grep -rn "chrome.scripting" entrypoints shared` — two hits, both inside the plan comment at the bottom of `content.ts`). None of the three remaining permissions triggers an install-time warning in Chrome. |
| **P0-4** the "⚡ Fill" button next to password fields | **fixed** | `shared/filler/fillable.ts` — an allowlist of input types, `password` is not in it; `looksLikeAuthPage()` prevents the button from being armed on a login page at all. Tests: "never enumerates the password or verify-password fields" (Workday), "does not enumerate the login password" (job-search). |
| **P0-5** the reply comes from the wrong frame | **fixed, without the permission** | The scheme was rebuilt: the direction of the reply is reversed. On the page side (`entrypoints/content.ts`, `installMessageBridge`): a frame that has nothing to say does not reply at all, and a frame that does have something to say replies via `chrome.runtime.sendMessage`, **not** via `sendResponse` — so no reply overwrites another. On the caller side (`entrypoints/ui/frames.ts`): a single broadcast `tabs.sendMessage` carrying a unique `requestId`, reception on `chrome.runtime.onMessage`, filtering by `requestId` and by tab, then aggregation. The number of the responding frame is taken from `sender.frameId` — exactly what `getAllFrames` used to be called for. Open-question ids are still namespaced by frame id. **The `webNavigation` permission has been removed from the manifest** (verified against both built manifests): the new scheme needs no permission at all, and it is stronger than the old one — every frame reports in, not just the fastest. The price is in the row below. |
| **P0-5, the price** | **accepted deliberately** | Without enumerating frames there is no way to know how many replies to expect, so the `COLLECT_WINDOW_MS = 400` ms collection window **is** the termination condition, not a safety net. A frame that replies later still fills and highlights its own fields (that happens inside the frame), but it will not make it into the popup summary. The window is not waited out when Chrome reports that the tab has no listeners at all. Recorded in the spec §11.1 as T-6. |
| **P0-6** Firefox: `storage.sync` does not work | **fixed** | `browser_specific_settings.gecko` with `id: jobfill@diz1l.dev` and `strict_min_version: 109.0` is present in `.output/firefox-mv2/manifest.json`. The note about `scripting` leaking into MV2 is closed along with the permission itself: `permissions` in the MV2 build is now `storage`, `activeTab`, `alarms` plus four hosts (in MV2 the hosts live in the same array). No MV3-only API is left in the MV2 manifest. |
| **P0-7** Sheets logging broken by the redirect | **fixed** | `https://script.googleusercontent.com/*` is present in both builds — in `host_permissions` for MV3, in the shared `permissions` array for MV2; `shared/api/sheets.ts` explicitly allows both hosts and keeps `redirect: 'follow'`. |

### P1 — core and data quality

| Item | Status | Evidence |
|---|---|---|
| **P1-1** `fullName` false positives | **fixed** | `dictionary.ts`: the rule gained a `negative` list drawn from `NON_PERSON_NAME` (`file name`, `project name`, `city name`, …) plus the owner contexts `company / organisation / referral / referee / emergency`. Lever test: 'leaves "Current company" alone'. |
| **P1-2** `city` matches `location` | **fixed** | `weak` patterns with cut-down weights were introduced, along with `isSearchContext()` in `fingerprint.ts`. Verified: the "Location" filter on a search page now yields `confidence: 'low'`. |
| **P1-3** scoring with no guard against a near-tie | **fixed** | `scorer.ts`: `MIN_MARGIN = 15`; anything closer than that is demoted to `low`. |
| **P1-4** `getContextHeading` is a noise source | **fixed** | Rewritten: `<fieldset>/<legend>`, the `MAX_ANCESTOR_DEPTH` / `MAX_SIBLING_SCAN` / `MAX_FALLBACK_DEPTH` limits, and discarding text that merely duplicates the label. There is an NFR-3 budget test over 200 controls. |
| **P1-5** `aria-labelledby` as an ID list | **fixed** | Workday test: "reads the label out of the aria-labelledby ID list, dropping the required marker text". |
| **P1-6** open-question detection too narrow | **fixed** | `scorer.ts` now looks at `labelText`, `ariaLabel`, `contextHeading`, `placeholder`; a question mark is enough on any control. Workday and Lever tests ("routes the opaque custom question to the AI path via its sibling div"). |
| **P1-7** import writes unvalidated JSON | **fixed** | `shared/storage/validate.ts` (324 lines, no runtime dependency): strict mode for import, lenient for reads, migrations keyed on `schemaVersion`, errors that name the path. |
| **P1-8** read-modify-write without locking | **fixed, with a residual trade-off** | `shared/storage/sync.ts` — one key per entity (`jobfill.profile.<id>` and so on) plus a write queue inside a context. Concurrent edits to **the same** profile remain last-write-wins: `chrome.storage` has no CAS primitive. Recorded in the spec §11.1 (T-2). |
| **P1-9** no retry for remote logging | **fixed** | `shared/storage/retryQueue.ts` (`MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 60 000`) plus a `chrome.alarms` driver in `background.ts`; the `pending` status is now actually used, and an `off` status was added. |
| **P1-10** dead code | **partial** | Wired up: `API_ERROR_MESSAGES` (used in `background.ts`), `getStorageUsage` (`options/App.tsx` — FR-1.2 closed), `removeAllHighlights` (teardown in `content.ts`). **`CLASSIFY_FIELDS` is no longer dead** — a sender exists (`entrypoints/content.ts:410`), see the separate FR-5.3 row below. **`serializeFingerprint` is no longer dead** — it is called from `buildClassificationBatch` (and through it from the second pass), and `semanticName` was added to it: 9 components instead of 8. **`inspectNotionDatabase` / `describeMapping` / `validateSheetsEndpoint` are no longer dead** — see P1-13. What remains: `upsertProfile` / `deleteProfile` / `upsertCoverTemplate` / `deleteCoverTemplate` are not called from the UI (it writes the whole list through `saveProfiles`). That is all that is left of this item. |
| **FR-5.3** wired up (formerly open item #1) | **fixed** | The `AppSettings.llmFieldClassification` setting (default `false`, fail-closed in `validate.ts`) plus a toggle on the "API & Logging" tab that stays disabled until a Groq key is saved. The second pass lives in `entrypoints/content.ts` (`runClassificationPass`), runs after the heuristic fill, and is fired without `await`. The batch limit `MAX_CLASSIFY_FIELDS = 40` is enforced both when the batch is assembled and again on the way out in `shared/api/groq.ts`. The opt-in is checked twice — in the content script and in the worker (`background.ts:311`) — because the key belongs to the worker. The `medium` confidence ceiling is guaranteed by the type: `LlmFieldConfidence = Extract<FieldConfidence, 'medium'>` — the type has exactly one inhabitant, and there is no confidence parameter on this path. **Important for anyone reading the UI: the second pass reports back on the page (amber highlight + toast), not in the popup** — the model's answer arrives seconds after the 400 ms collection window has closed. The popup counters stay a heuristic snapshot and do not account for classifier hits. That is not a bug; it is recorded in the spec §11.1 as T-7. |
| **P1-11** fixtures are synthetic | **fixed** | Added `tests/fixtures/greenhouse-real.html`, `lever.html`, `workday.html`, `job-search.html` with obfuscated attributes, `aria-labelledby` lists, collapsed sections and password fields. |
| **P1-12** `FILL_COVER_TEXT` aims blind | **fixed** | `shared/filler/coverTarget.ts`: it remembers the field that was focused before the popup opened, plus the recognised field; when there is no candidate the text is inserted nowhere and an error is returned. |
| **P1-13** Notion schema hardcoded | **fixed and carried through to the UI** | `shared/api/notion.ts` grew from 35 to 379 lines: reading the database schema, a cache, property mapping, and a dedicated message about what is missing. At the previous review none of this was reachable from the interface — that is no longer the case. The "API & Logging" tab has a "Check connection" button (`entrypoints/ui/NotionCheck.tsx`) that shows a row-by-row mapping of the database properties against what JobFill intends to write, and separately flags the single mandatory `title` slot. The Sheets endpoint is validated by `validateSheetsEndpoint` **before** saving, and an invalid one blocks the save (`options/App.tsx`, `handleSave`) — previously the first sign of a wrong URL was a failed application log. Check route: message `INSPECT_NOTION` → `NOTION_SCHEMA_RESULT` / `NOTION_SCHEMA_ERROR` in `shared/messages.ts`, handler `handleInspectNotion` in `entrypoints/background.ts:335`. |
| **P1-13, why it goes through the worker** | — | Not only because of S-2 (the extension page could reach Notion by itself: its own origin, the host is in `host_permissions`, nobody else's CSP/CORS applies). The main reason is that **the schema cache in `shared/api/notion.ts` is module state**: a check made from the page would warm the options page's own copy, which the worker's write path never sees, and would therefore prove nothing about the code that actually does the writing. Going through the worker, the check operates on the same module instance and the same cache. The handler is obliged to call `clearNotionSchemaCache(databaseId)` first — otherwise a re-check after fixing the database returns the failure cached for 10 minutes and the button looks broken. `entrypoints/ui/notionConnection.ts` keeps a fallback to the direct call from the page if the handler does not answer. |

### §5 — design

| Item | Status | Evidence |
|---|---|---|
| **§5.1** the options app-shell is broken | **fixed** | `globals.css`: `html.page, body, #root { height: 100%; overflow: hidden }`; `<main class="min-w-0 flex-1 overflow-y-auto">` — the only scroll container. |
| **§5.2** full-width fields (1076 px) | **fixed** | Tokens `--container-content: 900px`, `--field-min: 280px`; the `.content-column` and `.field-grid` classes (`repeat(auto-fill, minmax(280px, 1fr))`). |
| **§5.3** tabs have different widths | **fixed** | `max-w-lg` was removed from `ApiTab`; every tab now renders inside the same `.content-column` (there is a comment in `options/App.tsx` pointing at §5.3). |
| **§5.4** contrast fails WCAG AA | **fixed** | The palette moved into `@theme`. Recomputed under WCAG 2.1 for the pairs that actually occur in components: the worst text pair is 4.59:1 (dark theme) and 4.54:1 (light), the worst non-text pair is 3.28:1. The formally "bad" combinations `fg-subtle`/`surface-active` (4.14:1) and `line-strong`/`surface-active` (2.96:1) never occur in the code: `surface-active` is used only in `.nav-item-active`, where the text is `--color-fg` (9.42:1). |
| **§5.4-bis** the **on-page** field highlight failed 3:1 (not recorded in the original audit — found later) | **fixed** | The palette in `shared/filler/highlight.ts` had been copied from the UI tokens: `#22c55e` / `#eab308` / `#9ca3af` give 2.28 / 1.92 / 2.54 against a white background — meaning that on an ordinary light job page the highlight was practically invisible, and the "check this one" signal for a `medium` fill never reached the user (a silent FR-3.5 failure). The new set is picked to survive the worse of the two cases at once — against white and against near-black: `high #16a34a` (3.30 / 5.73), `medium #a16207` (4.92 / 3.84), `none #6b7280` (4.83 / 3.91), `ai #7c3aed` (5.70 / 3.31), `file #2563eb` (5.17 / 3.65). All ≥ 3:1 on both sides. The values and the calculation are in the comment above `HIGHLIGHT_CSS`. **The extension UI tokens and the on-page highlight palette are deliberately different and must stay that way:** the former know their background and have two themes driven by `prefers-color-scheme`; the latter sit on a background that belongs to someone else's page and is never queried from anywhere. |
| **§5.5** focus is invisible | **fixed** | A global `:where(a, button, input, textarea, select, summary, [tabindex]):focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px }` — zero specificity, impossible to remove, only to override. `--color-focus` gives ≥5:1 against any surface. A separate `transition-theme` utility was introduced — a copy of `transition-colors` **without `outline-color`** — otherwise the focus ring would fade in over 150 ms. |
| **§5.6** the popup flashes "No profiles yet" | **fixed** | A third state: `status === 'loading'` → `<PopupSkeleton />` until the first storage read. |
| **§5.7** popup scrolling is dead code | **fixed** | `html.popup` sets `width: var(--container-popup)` and `max-height: var(--popup-height)`, so `overflow-y-auto` on the content area finally engages. |
| **§5.8** magic numbers instead of a system | **fixed** | `grep -E "#[0-9a-fA-F]{3,8}"` and `grep -E "\[[0-9]+px\]"` over `entrypoints/**/*.tsx` — 0 matches. Every value is an `@theme` token. The exception is documented: `shared/filler/highlight.ts` draws on other people's pages and keeps its own palette. |
| **§5.9** the options page opens two ways | **fixed** | `chrome.windows.create` was replaced with `chrome.runtime.openOptionsPage()`; `<meta name="manifest.open_in_tab" content="true">` in `entrypoints/options/index.html` — the built manifest does contain `options_ui.open_in_tab: true`. |
| **§5.10** small stuff | **fixed** | `entrypoints/ui/Icons.tsx` — inline SVG instead of `⚙`/`⚡`; `entrypoints/ui/Dialog.tsx` built on the native `<dialog>` instead of `confirm()`/`alert()`; the Instagram link is gone; `.select` was restyled; `color-scheme: light dark` plus a full light palette; `EmptyState` for empty lists; the resize handle gained `role="separator"`, `tabIndex`, `aria-valuenow`, `onKeyDown` and width persistence in `localStorage`. |

### What is still open

Closed since the previous review and dropped from this list: FR-5.3 is wired up;
`scripting` is gone from both builds (and with it the MV2 leak); `webNavigation` is
gone, and the permission set has narrowed for the first time. The evidence is in the
tables above.

1. **Left over from P1-10:** `upsertProfile` / `deleteProfile` / `upsertCoverTemplate` / `deleteCoverTemplate` are not called from the UI — it writes the whole list through `saveProfiles`. This is not a user-facing defect, but it is an API that is covered by tests and not covered by use: either move the UI to targeted writes (and shrink the last-write-wins window from T-2 while at it), or delete it.
2. **NFR-2 is substantively unmet and will stay that way** — the content script remains declarative rather than injected via `activeTab`. Permissions have been narrowed to the limit, but `matches: http://*/*, https://*/*` + `all_frames: true` are still there. This is T-1, a decision with a recorded price, not a debt. For the Web Store the justification has to be about the breadth of the content script, not about permissions — those are clean now.
3. **The popup summary does not account for the FR-5.3 second pass** (T-7) and **loses frames that reply later than 400 ms** (T-6). Both are accepted trade-offs, and both surface to the user as "the number is lower than what is highlighted on the page". If a complaint ever arrives, start here rather than hunting for a bug in the counters.
4. **Uneven coverage.** `shared/filler`, `shared/extractors` and `shared/field-matcher` are at 100% lines and are held by percentage thresholds. Weak spots on the last run: `shared/storage` — 79.69% lines (inside it `local.ts` — 58.82%, `sync.ts` — 76.87%), `shared/api` — 86.86% (inside it `groq.ts` — 68.18%); these are held only by the uncovered-code budget. There are still no E2E tests (Playwright with the extension actually loaded).
5. **The privacy policy is not hosted** — the Web Store needs a URL, not a file in the repository. The text itself has been updated for FR-5.3: it now lists three cases of data leaving the page, not two.
6. **The manual test-matrix run (M5) has not been done** since the engine was reworked — the §10 checklists in the spec are left unticked deliberately. Nor has anyone exercised the FR-5.3 second pass live against a real ATS form: it is covered by unit tests with a stubbed transport, but not one real Groq response has been seen on that path yet.
7. **A stale comment in the code.** `entrypoints/ui/notionConnection.ts` (module header, ~lines 26–41) still claims that the `INSPECT_NOTION` handler in `entrypoints/background.ts` "does not exist yet" and that the call currently goes out from the page. The handler exists (`background.ts:335`), the default route is the worker, and the call from the page has become a fallback. The code behaves correctly; only the comment lies — but it lies in exactly the spot the next reader will walk into. It takes a single edit in a code file, so it is merely recorded here.

> The spec compliance matrix in §6 below **has not been updated** — it describes the
> state before the work. The current statuses live in this table and in the "Release
> Plan Overview" table in `TZ_jobfill_extension.md`.

---

## 0. The verdict on one page

> *What follows is the state at the time of the audit (before the fixes). See "Fix Status" above.*

| Area | Score | Comment |
|---|---|---|
| Architecture and layer separation | **8.5 / 10** | Clean: `entrypoints/` is orchestration only, all the logic is pure functions in `shared/`. That is the right call. |
| Typing and contracts | **8 / 10** | Discriminated unions for messages, typed wrappers over storage. Good. |
| Core quality (field detector) | **6 / 10** | It works, but there are false positives and no guard against near-ties. |
| Compliance with its own spec | **5 / 10** | It claims "v1–v5 shipped"; in fact v5 (application logging) is physically unreachable from the UI. |
| CI / release readiness | **2 / 10** | **CI is red: 3 of 5 steps fail.** This must not be published. |
| Security / privacy / Web Store | **3 / 10** | `<all_urls>` + `all_frames` in defiance of its own NFR-2; the fill button pops up next to password fields on every site. |
| **Design and UI** | **3 / 10** | **The layout breaks on both pages, contrast fails WCAG AA, there is no design system.** Details in §5. |

**Bottom line:** the foundation (architecture, types, pure functions, WXT) is good and should be kept. Everything on top of it — the build, the design, security, spec conformance — needs rework. This is not "rewrite from scratch", it is "fix and finish".

---

## 1. Full project structure

```
JobFill/
│
├── entrypoints/                     ← extension entry points (orchestration only)
│   ├── background.ts        150 LOC  Service worker (MV3). The single network egress point.
│   │                                 Routes 4 messages: GENERATE_COVER, ANSWER_QUESTIONS,
│   │                                 CLASSIFY_FIELDS, LOG_APPLICATION.
│   ├── content.ts           185 LOC  Content script. Enumerate → score → fill → highlight.
│   │                                 Inline "⚡ Fill" button on focusin. matches: <all_urls>.
│   ├── popup/
│   │   ├── App.tsx          295 LOC  React 19. Fill / AI / application list. Width 380px.
│   │   ├── main.tsx          10 LOC  createRoot + StrictMode
│   │   └── index.html        12 LOC
│   └── options/
│       ├── App.tsx          475 LOC  3 tabs: Profiles / Templates / API & Logging.
│       │                             Resizable sidebar (mousemove).
│       ├── main.tsx          10 LOC
│       └── index.html        12 LOC
│
├── shared/                          ← all the business logic, pure functions, testable
│   ├── types.ts             132 LOC  Profile, CoverTemplate, ApplicationEntry, SyncData,
│   │                                 LocalData, FillSummary, JobInfo + defaults
│   ├── messages.ts           61 LOC  Typed message contract (discriminated unions)
│   │
│   ├── field-matcher/               ← field recognition engine
│   │   ├── dictionary.ts    101 LOC  14 EN+CS rules: regex + autocomplete. Moved to config ✅
│   │   ├── fingerprint.ts   132 LOC  Field fingerprint capture (name/id/label/aria/placeholder/heading),
│   │   │                             extractSemanticName() — attribute de-obfuscation
│   │   ├── scorer.ts         88 LOC  Weight ladder 70/30/25/20/20/15/10, thresholds 70/35
│   │   └── index.ts          13 LOC  Barrel export
│   │
│   ├── filler/                      ← writing values into the DOM
│   │   ├── setNativeValue.ts  18 LOC Native setter + synthetic input/change (React-safe) ✅
│   │   ├── selectStrategy.ts  55 LOC Picks <option> by normalised similarity, threshold 0.5
│   │   ├── highlight.ts       84 LOC CSS classes __jobfill-*, auto-removal after N ms
│   │   ├── inlineButton.ts   147 LOC Floating button + toast, injects <style> into the page
│   │   └── index.ts          107 LOC fillPage() — the main fill orchestrator
│   │
│   ├── extractors/                  ← pulling out job posting data
│   │   ├── jsonLd.ts          55 LOC JSON-LD JobPosting (+ @graph traversal) — priority 1
│   │   ├── openGraph.ts       40 LOC og:title / og:site_name — priority 2
│   │   ├── headingHeuristics.ts 30 LOC h1 + document.title — priority 3
│   │   └── index.ts           24 LOC Fallback chain
│   │
│   ├── storage/
│   │   ├── sync.ts          110 LOC  chrome.storage.sync — profiles, templates, settings
│   │   └── local.ts          83 LOC  chrome.storage.local — secrets + application log
│   │
│   └── api/
│       ├── groq.ts          234 LOC  generateMotivation / classifyFields / answerOpenQuestions
│       ├── notion.ts         35 LOC  POST /v1/pages with a hardcoded property schema
│       └── sheets.ts         18 LOC  POST to the Apps Script Web App
│
├── tests/
│   ├── field-matcher.test.ts 253 LOC  ~24 tests
│   ├── extractors.test.ts    150 LOC  ~12 tests
│   └── fixtures/                      4 files × ~55 lines — SYNTHETIC, not real markup
│       ├── linkedin.html  greenhouse.html  jobs-cz.html  startupjobs.html
│
├── assets/styles/globals.css  48 LOC  Tailwind v4 + 6 component classes (.input/.btn-primary/...)
├── public/icons/                      4 PNG (16/32/48/128)
├── scripts/generate-icons.js 160 LOC  Icon generator (CommonJS — fails ESLint)
│
├── wxt.config.ts             38 LOC  Manifest + Tailwind plugin
├── tsconfig.json / eslint.config.js / vitest.config.ts / .prettierrc
├── .github/workflows/ci.yml  64 LOC  lint → typecheck → test → build ×2, release on tag
│
├── README.md                120 LOC
├── TZ_jobfill_extension.md  458 LOC  The full v1.0 spec (a good one!)
├── privacy-policy.md         21 LOC
│
└── ⚠️ JUNK IN THE REPOSITORY (gitignored, but sitting on disk):
    ├── testForB/          2.9 MB — 10 copies of one and the same build
    ├── .output/           584 KB
    ├── #/  and  dev/              — artefact folders from a typo in a command
```

**Metrics:** 4099 lines in total · 1899 lines of production code · 403 lines of tests · 15 commits · 1 branch.
**Build size:** 263 KB in total, of which the content script is 18 KB ✅ (the spec's limit is 50 KB gzip).

---

## 2. Strengths (what to protect and leave alone)

### 2.1 The architecture is genuinely good

The rule "entrypoints contain orchestration only, all the logic is pure functions in `shared/`" is **followed to the letter**. That is rare. Consequences:

- `field-matcher` and `extractors` are tested without a browser, in happy-dom, in 25 ms.
- The content script weighs 18 KB — zero framework, zero dependencies.
- The UI layer can be swapped out (React → Preact/Svelte) without touching a single line of logic.

### 2.2 Typed message contract

[shared/messages.ts](shared/messages.ts) — discriminated unions across 4 directions (`PopupToContent`, `ContentToPopup`, `ToBackground`, `FromBackground`). The compiler catches any drift between sender and receiver. Very few projects do this.

### 2.3 `setNativeValue` — the right solution to the right problem

[shared/filler/setNativeValue.ts:7-18](shared/filler/setNativeValue.ts#L7-L18) — writing through the prototype's native setter plus bubbling `input`/`change`. This is the **only** way to make React-controlled forms accept a value. The author understands how React works.

### 2.4 The right model for storing secrets

`sync` (cross-device, ≤100 KB) — profiles and templates. `local` (never synced) — API keys and the log. Matches S-1 from the spec. Correct.

### 2.5 The recognition dictionary lives in config

[shared/field-matcher/dictionary.ts](shared/field-matcher/dictionary.ts) — a site or a language can be added without touching the engine. EN+CS bilingualism with diacritic folding ([scorer.ts:9-14](shared/field-matcher/scorer.ts#L9-L14)) — competently done.

### 2.6 The job posting extraction fallback chain

JSON-LD (+ `@graph` traversal) → OpenGraph → `h1`/`title` heuristics. The order is right and the implementation is tidy.

### 2.7 A single network egress point

Every `fetch` happens in the background and nowhere else ([S-2](TZ_jobfill_extension.md)). The content script never goes to the network. That sidesteps the page's CSP and is the correct security model.

### 2.8 A thoroughly worked-out spec

458 lines with FR/NFR numbering, a test matrix, a risk register and person-day estimates. Plenty of commercial projects have nothing of the sort. The code references spec items in comments here and there — that is discipline.

### 2.9 Deliberate ethical limits

No auto-submit. No touching consent/GDPR checkboxes ([fingerprint.ts:126-129](shared/field-matcher/fingerprint.ts#L126-L129)). No CAPTCHA bypass. File inputs are only highlighted, never filled. This is what protects the extension from a store ban.

---

## 3. Problems — P0 (release blockers)

### P0-1. CI is red. Three steps out of five fail

Verified by running them:

| CI step | Result |
|---|---|
| `npm run compile` | ❌ **FAIL** — TS2322 in [wxt.config.ts:8](wxt.config.ts#L8) |
| `npm run lint` | ❌ **FAIL** — **11,425 errors** |
| `npm run coverage` | ❌ **FAIL** — 26.15% lines against a 90% threshold |
| `npm run build` | ✅ PASS (638 ms) |
| `npm run build:firefox` | ✅ PASS |

**Details:**

1. **Typecheck.** A Vite version conflict: `@tailwindcss/vite` pulls vite 7 from the root, while WXT uses its own nested vite. The `Plugin` types are incompatible. Cured with `resolutions`/`overrides` in package.json, or with `plugins: [tailwindcss() as any]`.

2. **Lint.** [eslint.config.js:27](eslint.config.js#L27) ignores only `.wxt/`, `dist/`, `node_modules/`. So ESLint is linting the **built bundles** in `testForB/` (48 files) and `.output/` (10 files). Real errors in the sources number just **23**:
   - [shared/filler/index.ts:89,97](shared/filler/index.ts#L89) — a ternary used as a statement (`match.confidence === 'high' ? summary.high++ : summary.medium++`);
   - [scripts/generate-icons.js](scripts/generate-icons.js) — 21 errors; a CommonJS file is being linted as browser ESM (no `globals.node`).

3. **Coverage.** The 90/80 threshold is set across the whole of `shared/**`, but only `field-matcher` (87.87%) and `extractors` (90.9%) are covered. `filler`, `storage`, `api` are at **0%**.

> There is a `copilot/fix-failing-ci-job` branch sitting on origin — so the problem is known and unsolved.

### P0-2. The v5 feature ("application log") does not exist in the UI

The backend can handle `LOG_APPLICATION` ([background.ts:34-39](entrypoints/background.ts#L34-L39)), the Notion and Sheets clients are written, local storage is ready. **But nobody ever sends that message.** `grep -rn LOG_APPLICATION entrypoints shared` turns up only the type declaration and the handler.

Consequences: `ApplicationEntry` is never created → the "Recent applications" list in the popup is always empty → FR-6.1 and FR-6.4 are unmet → the README and the spec mark v5 as "✅ shipped" **incorrectly**.

### P0-3. Its own NFR-2 is violated: `<all_urls>` + `all_frames`

The spec, NFR-2: *"No broad `<all_urls>` host permission; content script injection occurs on user action via activeTab"*.

The reality — [entrypoints/content.ts:21-23](entrypoints/content.ts#L21-L23) and the built manifest:
```json
"content_scripts":[{"matches":["<all_urls>"],"all_frames":true,"run_at":"document_idle"}]
```

The extension runs code **on every page and in every iframe on the internet**, including online banking, mail and ad frames. That is:
- a direct contradiction of NFR-2 and of the permissions table in the README;
- grounds for extended review or rejection in the Chrome Web Store;
- permanent `focusin`/`scroll`/`resize` listeners on every tab.

On top of that, `scripting` is declared in permissions and **used nowhere**, while `activeTab` is redundant with a static content script.

### P0-4. The "⚡ Fill" button appears next to password fields

[entrypoints/content.ts:94](entrypoints/content.ts#L94):
```ts
const excluded = ['file','hidden','submit','button','reset','image','checkbox','radio'];
```
`password` is **not** on that list. The same omission is in the enumeration selector — [fingerprint.ts:117](shared/field-matcher/fingerprint.ts#L117).

The result: on any login form on the internet, the extension's blue button pops up next to the password field. That destroys user trust instantly and is a red flag in store review. On top of that, `input[type=password]` lands in `enumerateFillable()` and takes part in scoring.

### P0-5. `chrome.tabs.sendMessage` + `all_frames` = the reply comes from the wrong frame

[popup/App.tsx:58](entrypoints/popup/App.tsx#L58) sends `FILL_FORM` without a `frameId`. The message goes out **to every frame**, but Chrome delivers **only the first `sendResponse` that arrives** to the popup.

On LinkedIn Easy Apply, Greenhouse embeds and Workable the form lives in an iframe. The top frame will answer `{high:0, medium:0}` faster → the user sees "0 filled" even though the fields were filled. The same goes for `EXTRACT_JOB_INFO` and `FILL_ANSWERS`.

**What is needed:** `chrome.webNavigation.getAllFrames`, or collecting replies from every frame and aggregating them, or picking the frame with the most fields.

### P0-6. Firefox build: `storage.sync` does not work

The built `firefox-mv2/manifest.json` contains no `browser_specific_settings.gecko.id`. In Firefox, **`storage.sync` does not persist without an explicit extension ID**. Which means that on Firefox, profiles silently fail to survive between sessions. Meanwhile the README claims full Firefox support.

Bonus: the `scripting` permission leaked into the MV2 manifest, and MV2 has no such thing → a review note on AMO.

### P0-7. Google Sheets logging is broken at the permissions level

[shared/api/sheets.ts:12](shared/api/sheets.ts#L12) uses `redirect: 'follow'`. An Apps Script Web App **always** redirects from `script.google.com` to `script.googleusercontent.com`. The second domain is not in `host_permissions` → the request will be blocked. `https://script.googleusercontent.com/*` has to be added.

---

## 4. Problems — P1 (core and data quality)

### P1-1. False positives from the `fullName` rule

[dictionary.ts:44](shared/field-matcher/dictionary.ts#L44): `pattern: /\bfull[.\s_-]?name\b|\bname\b|.../i`

A bare `\bname\b` matches **any** field with the word "name" in its label: `Company name`, `Referral name`, `Manager name`, `File name`, `Project name`. Such a field scores 25 (semanticName) + 20 (label) = **45 → medium → the candidate's full name gets typed into it**.

### P1-2. The `city` rule matches `location`

[dictionary.ts:79](shared/field-matcher/dictionary.ts#L79): `/\bcity\b|location|.../i`. The "Location" filter field on a job search page will get stuffed with the user's home city.

### P1-3. Scoring with no guard against a near-tie

[scorer.ts:70](shared/field-matcher/scorer.ts#L70): `if (score > 0 && (!best || score > best.score))`. The plain maximum wins, with no check on the gap to the runner-up. Two rules on 45 and 44 points — the winner is decided by the order in the array. A minimum margin is needed (≥15, say); below it, demote to `low` and do not fill.

### P1-4. `getContextHeading` is a noise source

[fingerprint.ts:72-91](shared/field-matcher/fingerprint.ts#L72-L91) walks up through every ancestor and returns the text of **any** preceding `div`/`span`/`p` shorter than 80 characters. On real ATS pages that is often the label of the neighbouring field or a breadcrumb → a spurious +10 points for some random rule. Plus O(ancestors × siblings) complexity per field — a risk for NFR-3 (300 ms for 200 controls).

### P1-5. `aria-labelledby` is handled incorrectly

[fingerprint.ts:63-67](shared/field-matcher/fingerprint.ts#L63-L67): `getElementById(labelledBy)` over the entire string. Per the specification this is a **space-separated list of IDs**. For `aria-labelledby="lbl1 lbl2"` it returns `null` — a pattern typical of Workday and Greenhouse is lost.

### P1-6. Open-question detection is too narrow

[scorer.ts:78-85](shared/field-matcher/scorer.ts#L78-L85) requires a `<textarea>` **and** `labelText.length > 20` **and** an interrogative prefix. Most ATS platforms put the question text not in a `<label>` but in a neighbouring `<div>` or in `aria-label`. The feature will stay silent on the majority of real forms.

### P1-7. `importSyncData` writes unvalidated JSON straight into storage

[storage/sync.ts:93-110](shared/storage/sync.ts#L93-L110) validates exactly one field — `schemaVersion === 1` — and then calls `chrome.storage.sync.set({[KEY]: parsed})`. A file with `profiles: "a string"` will break both the popup and the options page, with no way to recover through the UI. Schema validation (zod / valibot / arktype) and `schemaVersion` migrations are needed.

### P1-8. Read-modify-write without locking

[storage/sync.ts:11-14](shared/storage/sync.ts#L11-L14): `setSyncData` reads everything, merges, writes everything back. If the popup and the options page write at the same time, one of the changes is lost. Per-entity keys or a write queue are needed.

### P1-9. No retry for remote logging

FR-6.3 requires "one retry attempt". [background.ts:94-113](entrypoints/background.ts#L94-L113) sets `failed` immediately on error. The `pending` status from the `ApplicationEntry` type is not used at all.

### P1-10. Dead code

| Symbol | Where | Status |
|---|---|---|
| `API_ERROR_MESSAGES` | [messages.ts:55](shared/messages.ts#L55) | used nowhere |
| `getStorageUsagePercent` | [storage/sync.ts:78](shared/storage/sync.ts#L78) | never called → **FR-1.2 (warning at 80% of quota) unmet** |
| `upsertProfile`, `deleteProfile` | [storage/sync.ts:39,50](shared/storage/sync.ts#L39) | the UI writes the whole array, bypassing them |
| `serializeFingerprint` | [fingerprint.ts:110](shared/field-matcher/fingerprint.ts#L110) | never called |
| `removeAllHighlights`, `removeStyles` | [highlight.ts:73,82](shared/filler/highlight.ts#L73) | re-exported only, never called |
| `CLASSIFY_FIELDS` | [background.ts:27](entrypoints/background.ts#L27) | handler exists, no sender → **FR-5.3 not wired up** |

### P1-11. Test fixtures are synthetic, not captured

Spec §8 requires "captured HTML form fragments per site". In reality these are 4 hand-written files of 52–58 lines each, with perfect `<label for>` and clean `name` attributes. A real Greenhouse/Workday page means `<div>` combo boxes, obfuscated attributes and shadow DOM. **The tests verify an ideal world, not the one the extension will actually run in.**

### P1-12. `FILL_COVER_TEXT` aims blind

[content.ts:49-66](entrypoints/content.ts#L49-L66): the target is `document.activeElement` → a highlighted textarea → **the first `<textarea>` on the page**. But opening the popup takes focus off the page, and the first textarea may well be a search box or a chat. The cover letter text will fly off somewhere it does not belong.

### P1-13. The Notion schema is hardcoded

[api/notion.ts:20-27](shared/api/notion.ts#L20-L27) demands exactly the properties `Name / Company / URL / Date / Status / Profile`, each of exactly the right type. Any other database → a 400 error worded by Notion. There is no schema discovery, no mapping and no guidance in the UI.

---

## 5. DESIGN — a detailed breakdown (verified by rendering)

The built extension was rendered in headless Chrome against a stubbed `chrome.*` API with realistic demo data. What follows is measured fact, not opinion.

### 5.1 🔴 Options page: the app-shell layout is broken

**Measured at a 1265 × 633 viewport:**
```
root container height = 1030.75 px
viewport height       =  633 px
```

[options/App.tsx:47](entrypoints/options/App.tsx#L47) uses `min-h-screen` instead of `h-screen`. Further down, [line 62](entrypoints/options/App.tsx#L62) is `flex flex-1 overflow-hidden`, and [line 91](entrypoints/options/App.tsx#L91) is a `main` with `overflow-y-auto`.

**Why it breaks:** `min-h-screen` sets only the *minimum* height. Flex items have `min-height: auto`, so the row container grows to fit its content, all the way to 1031 px. As a result:

- `overflow-y-auto` on `<main>` **never fires** — it is dead CSS;
- **the whole page** scrolls, not just the content area;
- the header (`shrink-0`, but not `sticky`) **slides off the top** as you scroll;
- the navigation sidebar **slides away with it** — on a long profile form the tab switcher is nowhere on screen;
- the sidebar's resize handle spans only the height of the content, not of the window.

**Fix:** `h-screen` + `overflow-hidden` on the root; header `shrink-0`; sidebar `h-full overflow-y-auto`; `<main>` as the only scroll container.

### 5.2 🔴 Form fields stretched across the full width — 1076 px

The comment `{/* no max-width — use full available space */}` appears twice in the code ([line 145](entrypoints/options/App.tsx#L145) and [line 281](entrypoints/options/App.tsx#L281)). The result in a 1280 window:

| Element | Measured width |
|---|---|
| "Profile label" field | **1076 px** |
| "First name" field | **525 px** |
| "Template name" field | **1076 px** |
| Template body textarea | **1076 × 280 px** |

A metre-wide input for a profile name is not "using the space", it is the absence of any sense of measure. A comfortable line length is 45–75 characters (~640 px at 16px). The template textarea in a monospace font at 1076 px gives ~180 characters per line — impossible to read.

**Fix:** a content container at `max-w-[900px]`, fields on a `minmax(280px, 1fr)` grid, textarea at `max-w-[70ch]`.

### 5.3 🔴 The tabs have different content widths

- `ProfilesTab` — unconstrained (1076 px)
- `TemplatesTab` — unconstrained (1076 px)
- `ApiTab` — [`max-w-lg`](entrypoints/options/App.tsx#L388) = **512 px**

Switching tabs makes the layout jump: full-screen one moment, a narrow column on the left with 560 px of emptiness on the right the next (visible in the render of the "API & Logging" tab). This is the most conspicuous visual defect.

### 5.4 🔴 Contrast fails WCAG AA

Computed per WCAG 2.1 for the current palette:

| Colour | Background | Contrast | AA (4.5:1) | Where it is used |
|---|---|---|---|---|
| `#cccccc` | `#1e1e1e` | 10.38 | ✅ | body text |
| `#e8e8e8` | `#252526` | 12.50 | ✅ | headings |
| `#767676` | `#1e1e1e` | **3.67** | ❌ | `.label`, `.section-desc` — **every field label** |
| `#767676` | `#252526` | **3.37** | ❌ | captions in the header |
| `#858585` | `#252526` | **4.15** | ❌ | inactive sidebar items |
| `#585858` | `#1e1e1e` | **2.34** | ❌❌ | footer, captions in the summary |
| `#585858` | `#3c3c3c` | **1.55** | ❌❌ | **placeholder inside inputs — all but invisible** |
| `#777777` | `#3c3c3c` | **2.46** | ❌❌ | **the focus border** |

Seven of the fourteen pairs fail. Three of them fail even the large-text threshold (3:1). And `.label` is `text-[11px] uppercase tracking-widest`: small, widely tracked type at a contrast of 3.67 reads badly even for a sighted user with no impairment.

### 5.5 🔴 Keyboard focus is all but invisible

[globals.css:26-29](assets/styles/globals.css#L26-L29):
```css
.input { ... focus:outline-none focus:border-[#777] focus:bg-[#444] ... }
```

`outline-none` removes the system focus indicator, and the replacement is a `#777` border on a `#3c3c3c` background at a contrast of **2.46:1** (WCAG 2.4.11 requires 3:1). In the render with a focused field, the difference from the resting state is barely distinguishable.

This is a direct violation of **NFR-7 of its own spec**: *"Popup and options pages SHALL be keyboard-navigable with visible focus states"*.

**Fix:** `focus-visible:outline-2 outline-offset-2 outline-[#4da3ff]` (contrast ≥3:1 against both backgrounds).

### 5.6 🟠 The popup flashes "No profiles yet" every time it opens

[popup/App.tsx:104](entrypoints/popup/App.tsx#L104):
```tsx
if (profiles.length === 0) { return <empty state with an "Open Settings" button /> }
```
The initial state is `useState([])`, and `chrome.storage` is asynchronous. Which means **the first frame of every popup open** is the "no profiles" screen. It is then swapped for the real UI. The user gets a flash of a false message on every click of the icon.

**Fix:** a third `loading` state plus a fixed-height skeleton.

### 5.7 🟠 Scrolling in the popup is dead code

[popup/App.tsx:117](entrypoints/popup/App.tsx#L117) — a root of `flex flex-col overflow-hidden` with no height set; [line 151](entrypoints/popup/App.tsx#L151) — `flex-1 overflow-y-auto`. The same mistake as in §5.1: without a fixed height on the parent, `flex-1` does not constrain the child and `overflow-y-auto` never activates.

As long as the content fits into 600 px (Chrome's popup limit) nobody notices. With an expanded application list plus generated cover letter text, the popup will hit the limit and the content will be clipped instead of scrolling.

**Fix:** `h-[600px]` (or `max-h-[600px]` + `h-auto`) on the popup root.

### 5.8 🟠 Magic numbers instead of a system

- `h-[214px]` in the popup's empty state ([line 106](entrypoints/popup/App.tsx#L106)) — where does 214 come from?
- `w-[380px]`, `max-h-36`, `h-28`, `sidebarWidth = 160`, `width: 1280, height: 720`
- 16 different hardcoded hexes scattered through the code: `#1e1e1e #252526 #2d2d2d #37373d #3c3c3c #3e3e42 #505050 #585858 #767676 #777 #858585 #aaa #cccccc #e8e8e8 #0e639c #1177bb`
- Font sizes: `text-[10px] text-[11px] text-[12px] text-[13px] text-[15px] text-xs text-sm text-base` — two scales mixed together

**Not a single CSS variable, not a single token.** Tailwind v4 lets you declare a theme via `@theme` — it is not used at all. Hence the thrashing visible in the commit history:

```
d8baa02 feat: popup 16:9 ratio (640×360px)
17bde79 fix: options page full-width layout, popup back to 380px
76878af fix: wider layout, lighter dark theme (#1e1e1e), author credit
c625222 feat: resizable sidebar in options page
ffa1beb feat: open settings as 1280x720 (16:9) popup window
```
Five commits in a row replaying the sizes back and forth. That is the classic symptom of a missing design system: every change is a one-off guess at a number rather than the application of a rule.

### 5.9 🟠 The options page opens in two different ways

- From the popup — [`chrome.windows.create({type:'popup', width:1280, height:720})`](entrypoints/popup/App.tsx#L10)
- From `chrome://extensions` → "Options" — the built-in dialog

Meanwhile [wxt.config.ts:29](wxt.config.ts#L29) sets `open_in_tab: true`, but **the built manifest has no such flag**:
```json
"options_ui":{"page":"options.html"}
```
WXT overrides `options_ui` from the entrypoint and ignores `manifest.options_ui` in the config (what is needed is `<meta name="manifest.open_in_tab" content="true">` in `options/index.html`). Rendering inside the built-in ~600×400 dialog shows: the sidebar eats 160 of the 600 px, the content gets 420 px, and the two-column grid squeezes down to 190 px per field.

Besides, `windows.create` sets the **outer** window size — once the frame and title bar are accounted for, the viewport comes out at 1265 × 633, not 1280 × 720. The advertised "16:9" is nothing of the sort.

### 5.10 🟡 Small things that spoil the impression

| What | Where | Problem |
|---|---|---|
| `⚙` as a text glyph | [popup/App.tsx:137](entrypoints/popup/App.tsx#L137) | renders differently on macOS/Windows/Linux; the click target is ~16 px against a 24 px norm |
| `⚡` in the button and the toasts | [inlineButton.ts:72](shared/filler/inlineButton.ts#L72) | an emoji standing in for an icon |
| The Instagram link | [popup:235](entrypoints/popup/App.tsx#L235), [options:52](entrypoints/options/App.tsx#L52) | a personal social account in a product UI — looks unprofessional in store review |
| Native `<select>` for profiles | [popup/App.tsx:123](entrypoints/popup/App.tsx#L123) | the system arrow clashes with the dark theme |
| `confirm()` / `alert()` | [options:122,140](entrypoints/options/App.tsx#L122) | system modals instead of UI components |
| `color-scheme: dark` hardcoded | [globals.css:7](assets/styles/globals.css#L7) | no light theme and no `prefers-color-scheme` |
| No empty states | Templates, Recent applications | with no data, simply nothing is rendered |
| Resize handle with no keyboard support | [options/App.tsx:84-88](entrypoints/options/App.tsx#L84-L88) | `onMouseDown` with no `role="separator"`, no `tabIndex`, no arrow keys; does not work on touch devices; the width is not persisted between sessions |
| Inconsistent padding | popup | `p-4`, `px-4 py-3`, `px-4 py-2.5`, `px-4 py-2` in adjacent sections |

---

## 6. Spec compliance — the matrix

| Requirement | Status | Comment |
|---|---|---|
| FR-1.1 Profile with all fields | ✅ | all 13 fields present |
| FR-1.2 Warning at 80% of the sync quota | ❌ | `getStorageUsagePercent` is written but never called |
| FR-1.3 Multiple profiles + preselect the last used | ✅ | |
| FR-1.4 Export/import with validation | ⚠️ | only `schemaVersion` is validated |
| FR-2.1 Enumerating controls, iframes | ⚠️ | works, but `password` is not excluded |
| FR-2.2 Fingerprint from 7 sources | ✅ | |
| FR-2.3 Bilingual dictionary in config | ✅ | |
| FR-2.4 Confidence levels and thresholds | ⚠️ | no check on the gap to the runner-up |
| FR-2.5 File inputs highlighted only | ✅ | |
| FR-2.6 Do not touch consent controls | ✅ | |
| FR-3.1 Native setter + events | ✅ | textbook |
| FR-3.3 Strategy for `<select>` | ✅ | |
| FR-3.4 Summary in the popup | ✅ | |
| FR-3.5 Auto-removal of highlights | ✅ | |
| FR-4.1–4.2 Templates + job posting extraction | ✅ | |
| FR-4.3 "Review" highlight for the template | ❌ | inserted like any ordinary field |
| FR-5.1 Groq key in local | ✅ | |
| FR-5.2 Cover letter generation | ✅ | |
| FR-5.3 LLM field classification | ❌ | handler exists, nothing calls it |
| FR-5.4 Distinguishable API errors | ⚠️ | the types exist, `API_ERROR_MESSAGES` is unused |
| FR-6.1 Creating a log entry | ❌ | **no path through the code** |
| FR-6.2 Notion / Sheets | ⚠️ | the clients exist, Sheets is broken by the redirect |
| FR-6.3 Local copy + 1 retry | ❌ | there is no retry |
| FR-6.4 Last 10 in the popup | ❌ | always empty (see FR-6.1) |
| NFR-2 Minimum permissions | ❌ | `<all_urls>` + an unused `scripting` |
| NFR-3 ≤300 ms, ≤50 KB content script | ⚠️ | 18 KB ✅, speed never measured |
| NFR-4 Page isolation | ⚠️ | `removeStyles`/`removeAllHighlights` are never called |
| NFR-6 Architecture ready for `_locales` | ❌ | there is no `_locales`, every string is hardcoded |
| NFR-7 Accessibility | ❌ | see §5.4, §5.5 |

**Total: 13 ✅ · 7 ⚠️ · 10 ❌**

---

## 7. What to improve — proposals

### 7.1 The stack: keep the base, reinforce selectively

| Layer | Today | Proposal | Why |
|---|---|---|---|
| Extension framework | WXT 0.21 | **keep** | the best choice for MV3 + Firefox out of a single codebase |
| Language | TypeScript strict | **keep** | |
| Popup UI | React 19 (195 KB chunk) | **Preact + `preact/compat`** via alias | the popup has to open instantly; ~3 KB instead of 195 KB, and neither the JSX nor the code changes |
| Options UI | React 19 | **keep React** | a heavy form, open speed is not critical |
| Styles | Tailwind v4, hardcoded hexes | **Tailwind v4 + `@theme` tokens** | one edit to the theme instead of 16 hexes strewn across files |
| Components | hand-rolled | **Radix UI primitives** (select, dialog, tabs, tooltip) | accessibility and keyboard support out of the box, ~10 KB |
| Data validation | none | **valibot** (~2 KB) | schemas for import, for Groq responses, for storage migrations |
| Storage | raw wrappers | **`wxt/storage`** (`defineItem`) | reactivity, versioning, migrations, defaults — already in WXT |
| Extension APIs | the global `chrome` | **`browser` from `wxt/browser`** | correct behaviour on Firefox |
| Tests | Vitest + happy-dom | **+ `@webext-core/fake-browser`, + Playwright** | cover storage/filler/api and E2E scenarios |
| Icons | emoji + glyphs | **lucide-react** (tree-shaken) | consistency across every OS |
| AI | Groq (Llama 3.3 70B) | **keep + add providers** | Groq is fast and cheap; a provider abstraction removes the lock-in |

### 7.2 The design system — concretely

Introduce this in `globals.css` via Tailwind v4 `@theme`:

```css
@theme {
  /* Surfaces */
  --color-surface-base: #17181c;   /* page background */
  --color-surface-raised: #1f2126; /* header, sidebar, cards */
  --color-surface-input: #2a2d34;
  --color-surface-hover: #2f333b;

  /* Borders */
  --color-border-subtle: #33373f;
  --color-border-strong: #4a4f59;

  /* Text — every pair ≥4.5:1 against its own surface */
  --color-text-primary: #e6e8ec;   /* 13.2:1 */
  --color-text-secondary: #a8aeb8; /*  7.1:1 — replaces #767676 */
  --color-text-muted: #8b929d;     /*  5.2:1 — replaces #585858 */

  /* Accents */
  --color-accent: #3b82f6;
  --color-accent-hover: #2563eb;
  --color-focus: #60a5fa;          /* ≥3:1 against any surface */

  /* Confidence semantics — shared by the popup and the on-page highlight */
  --color-confidence-high: #34d399;
  --color-confidence-medium: #fbbf24;
  --color-confidence-none: #6b7280;
  --color-confidence-ai: #a78bfa;
  --color-confidence-file: #60a5fa;

  /* Spacing and radius scale — 4px base */
  --spacing-unit: 0.25rem;
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;

  /* Typography — one scale, no text-[13px] */
  --text-xs: 11px; --text-sm: 12px; --text-base: 13px;
  --text-lg: 15px; --text-xl: 18px;
}
```

Rules that need to be written down and then followed:
1. **Not one hex in JSX** — tokens only.
2. **Not one `[N px]` size in components** — the scale only.
3. **`focus-visible` is mandatory** on every interactive element, contrast ≥3:1.
4. **Content column ≤ 900 px**, fields on `minmax(280px, 1fr)`.
5. **One scroll container per page** — `h-screen` on the root, `overflow-y-auto` on `<main>` and nowhere else.
6. **Three states for every screen**: loading (skeleton) / empty (illustration + CTA) / error.

### 7.3 Product improvements (beyond the spec)

**Recognition accuracy is the product's main differentiator.** Everything else is secondary.

1. **Site profiles.** A selector dictionary for specific ATS platforms (Greenhouse, Lever, Workable, Workday, SmartRecruiters, Jobs.cz, StartupJobs) — exact matching instead of heuristics wherever the markup is known. Store it as JSON and update it without shipping a new extension release.
2. **`<div>` combo boxes.** Workday and Greenhouse use custom dropdowns — right now that is a 100% miss. A strategy is needed: click → find the option in the popover → click the option.
3. **Learning from corrections.** If the user changes a value after autofill, remember the fingerprint→field pairing for that domain. Over a month of use this will lift accuracy more noticeably than any dictionary edit.
4. **Résumé → profile (v6 from the spec).** PDF.js in a Web Worker, entirely local. This removes the main barrier to entry: 13 fields typed by hand on first run.
5. **Keyboard shortcut.** `commands` in the manifest, `Alt+Shift+F` to fill the active form. A tool of this class is obliged to work without a mouse.
6. **Preview before insertion.** A "12 fields will be filled" panel with checkboxes you can clear — it defuses the fear of "what if it writes nonsense into the form I am sending to an employer".
7. **Application logging — finish the job.** After filling, show a "Log application" button → create an `ApplicationEntry` → send `LOG_APPLICATION`. That is 30 lines of code, and they turn the advertised-but-nonexistent v5 feature into a real one.
8. **i18n.** `_locales` for EN / CS / RU. The extension's audience is in Czechia, and the interface is English-only.

### 7.4 Infrastructure

- Fix typecheck (`overrides` for vite), lint (`ignores` + `globals.node` for `scripts/`), coverage (per-directory thresholds).
- Delete `testForB/` (2.9 MB), `#/`, `dev/`.
- Add `browser_specific_settings.gecko.id` for Firefox.
- Add `https://script.googleusercontent.com/*` to host_permissions.
- Playwright E2E tests with the extension really loaded: the popup opens, filling works against a local test form.
- A script that captures real fixtures from live ATS pages instead of hand-writing them.
- `_locales` + `default_locale` in the manifest.
- Host the privacy policy (GitHub Pages) — the Web Store needs a URL, not a file in the repository.

---

## 8. The work plan, split into independent streams

The split is arranged so that the streams **do not overlap on files** — they can run in parallel.

### Stream A — "Infrastructure and CI" 🔴 blocker
`package.json` · `eslint.config.js` · `vitest.config.ts` · `wxt.config.ts` · `.gitignore` · `.github/`
- Fix `npm run compile` (the vite conflict)
- Fix `npm run lint` (ignores + node globals) — 11,425 → 0
- Per-directory coverage thresholds instead of global ones
- Delete `testForB/`, `#/`, `dev/`
- `browser_specific_settings.gecko.id`, `script.googleusercontent.com`, `commands`, `default_locale`

### Stream B — "Security and permissions" 🔴 blocker
`entrypoints/content.ts` · `wxt.config.ts` · `shared/field-matcher/fingerprint.ts`
- Exclude `input[type=password]` from `isFillable` and `enumerateFillable`
- Move off `<all_urls>` to `activeTab` + programmatic injection (`chrome.scripting.executeScript`)
- Settle the `all_frames` question and frame addressing (`frameId`)
- Call `removeStyles`/`removeAllHighlights` on unload

### Stream C — "Design system and layout" 🔴 blocker
`assets/styles/globals.css` · `entrypoints/options/App.tsx` · `entrypoints/popup/App.tsx`
- Tokens via `@theme`, purge every hardcoded hex
- `h-screen` + a single scroll container (§5.1, §5.7)
- `max-w` on the content column, one width across all tabs (§5.2, §5.3)
- A palette with contrast ≥4.5:1 (§5.4)
- A visible `focus-visible` (§5.5)
- loading / empty / error states (§5.6)
- Replace the emoji and `⚙` with lucide icons
- Resize handle: `role="separator"` + keyboard + width persistence

### Stream D — "Recognition engine accuracy" 🟠
`shared/field-matcher/**` · `tests/field-matcher.test.ts`
- Tighten `fullName` and `city` (P1-1, P1-2)
- A margin check in the scorer (P1-3)
- Rewrite `getContextHeading` (P1-4)
- Support the ID list in `aria-labelledby` (P1-5)
- Broaden open-question detection (P1-6)
- Capture real fixtures from 4+ ATS platforms and cover them with tests

### Stream E — "Finish v5: the application log" 🟠
`entrypoints/popup/App.tsx` (the logging section) · `entrypoints/background.ts` · `shared/api/notion.ts`
- A "Log application" button → `ApplicationEntry` → `LOG_APPLICATION`
- Retry + the `pending` state (FR-6.3)
- Notion schema discovery + guidance in the UI
- Fix the Apps Script redirect

### Stream F — "Storage reliability" 🟠
`shared/storage/**` · `shared/types.ts`
- Schema validation on import (valibot) + `schemaVersion` migrations
- Remove the read-modify-write race
- Wire `getStorageUsagePercent` into the UI (FR-1.2)
- Consider moving to `wxt/storage`

### Stream G — "Tests" 🟡
`tests/**`
- Cover `filler`, `storage`, `api` (currently 0%)
- `@webext-core/fake-browser` for the storage tests
- Playwright E2E with the extension loaded

### Stream H — "Documentation" 🟡
`README.md` · `TZ_jobfill_extension.md` · `privacy-policy.md`
- Bring the v1–v5 statuses into line with reality
- Fix `firefox-mv3` → `firefox-mv2`
- Bring the permissions table up to date
- Host the privacy policy

**Order:** A, B, C first and in parallel (the blockers). D, E, F are the second wave. G, H follow as the rest come together.

---

## 9. Conclusion

This project was written by someone who **understands architecture**: layer separation, pure functions, typed contracts, the native setter for React forms, a single network egress point — all of it done correctly and deliberately. A 458-line spec with FR/NFR numbering is a standard many commercial teams never reach.

The failures sit in three areas, and all three are fixable:

1. **The discipline of finishing.** The Notion and Sheets clients are written, the `LOG_APPLICATION` handler is written, the local log storage is written — but the 30 lines that join them all up are not. Same story with `CLASSIFY_FIELDS` and `getStorageUsagePercent`. A feature counts as done when you can reach it from the UI.

2. **Design without a system.** Five commits in a row replay window sizes back and forth, because there is not one token and not one rule — every time, a number is guessed at. Hence the broken layout, the contrast failure and the invisible focus ring.

3. **The gap between the spec and the manifest.** NFR-2 forbids `<all_urls>` — the manifest has `<all_urls>`. NFR-7 requires visible focus — focus is invisible. The spec is good, but nothing checks it automatically, so it drifts away from the code.

And CI is red on top of all that, which makes all three inevitable: while `compile`, `lint` and `coverage` are failing, nothing stops the divergence from growing further.

**Effort estimate:** the blockers (streams A, B, C) — 3–4 days. Full polish to a "ready to submit to the Chrome Web Store" state — 8–10 days.






