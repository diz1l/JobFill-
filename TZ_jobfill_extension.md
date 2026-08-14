# Technical Specification: JobFill — Job Application Autofill Browser Extension

| | |
|---|---|
| **Document version** | 1.0 |
| **Date** | July 9, 2026 |
| **Status** | Draft |
| **Platform** | Chrome Extension (Manifest V3), Firefox-compatible build |
| **Author** | Dias Nur |

---

## 1. Executive Summary

JobFill is a browser extension that automates the completion of job application forms. Users maintain one or more applicant profiles (personal details, links, salary expectations, cover letter templates). On any job application page, the extension detects form fields, matches them against the active profile using a heuristic scoring engine, and fills them in a single click. Advanced features include AI-generated motivation paragraphs tailored to the specific job posting (Groq API) and an application log synced to Notion or Google Sheets.

The extension never submits forms automatically and never transmits user data to any first-party server. All data resides in browser storage; external requests occur only on explicit user action toward user-configured third-party APIs.

### 1.1 Goals
- Reduce time spent on repetitive form completion during an active job search from minutes to seconds per application.
- Provide reliable field detection across major job boards and ATS platforms with bilingual (Czech/English) heuristics.
- Serve as a production-quality portfolio project: published on the Chrome Web Store, fully tested, CI-backed.

### 1.2 Non-Goals
- Automatic form submission (explicitly out of scope for ethical and anti-abuse reasons).
- Programmatic file uploads (prohibited by browser security model).
- Automatic completion of consent/GDPR checkboxes.
- CAPTCHA solving or any anti-bot circumvention.

### 1.3 Target Platforms (Test Matrix)
Primary: Jobs.cz, Prace.cz, StartupJobs.cz, LinkedIn Easy Apply.
Secondary: Greenhouse, Lever, Workable, generic company career forms.

---

## 2. Release Plan Overview

| Release | Scope | Codename | Status |
|---|---|---|---|
| **v1 (MVP)** | Single profile, heuristic field detection, one-click fill, visual feedback | Core | ✅ shipped |
| **v2** | Multiple profiles with per-fill selection, JSON export/import | Profiles | ✅ shipped |
| **v3** | Cover letter templates with `{company}` / `{position}` placeholder resolution | Templates | ✅ shipped |
| **v4** | AI motivation generation; open-question answering; inline fill button; optional LLM field classification | Assist | ✅ shipped |
| **v5** | Application logging to Notion / Google Sheets; recent applications view | Tracker | ✅ shipped |
| **v6** | Resume / CV parsing from PDF, DOCX, or LaTeX; auto-populate profile on import | Parser | planned |
| **v7** | Subscription tiers — Free (limited) vs Pro (unlimited + AI + parsing) | Monetise | planned |
| **v8** | Payment integration — Stripe / Paddle; licence key via Cloudflare Worker | Payments | planned |

**Caveats behind the ticks above** — verified against the code, not against intent:

- **v4 / FR-5.3** (LLM classification of low-confidence fields) is now reachable
  end to end: the opt-in lives at Options → API & Logging ("Identify unrecognized
  fields with AI", `AppSettings.llmFieldClassification`, default `false`), the
  content script runs a second pass after the heuristic fill, and the worker
  answers `CLASSIFY_FIELDS`. Read FR-5.3 itself for the two things about it that
  surprise people: the feedback appears on the page rather than in the popup, and
  the popup counters remain the heuristic snapshot.
- **v4 / hotkey.** `commands.fill-form` (`Alt+Shift+F`) is declared in the manifest
  *and* handled by `chrome.commands.onCommand` in the background worker, which
  fills the active tab without opening the popup and reports the outcome through
  the action badge.
- **v5** is genuinely reachable: the popup's "Log application" action creates the
  entry, the local copy is written unconditionally, and a failed remote write is
  parked in a durable queue and retried once via `chrome.alarms`.
- **NFR-2** is only partially satisfied. See the requirement itself for the exact
  boundary between what was done and what was not.

---

## 3. Functional Requirements

### 3.1 Profile Management (v1, extended in v2)

**FR-1.1** The options page SHALL allow the user to create and edit an applicant profile with the following fields: first name, last name, email, phone (E.164, default region +420), city/address, LinkedIn URL, GitHub URL, portfolio URL, salary expectation (free text), availability / notice period, work permit / citizenship status, and a short "about" summary.

**FR-1.2** Profile data SHALL be persisted in `chrome.storage.sync` to enable cross-device synchronization. Total sync payload SHALL remain within the 100 KB quota; the UI SHALL surface a warning at 80% utilization.

**FR-1.3 (v2)** The user SHALL be able to maintain multiple named profiles (e.g., "Frontend," "QA," "IT Support") with full CRUD operations. The popup SHALL present a profile selector prior to filling; the last-used profile SHALL be preselected.

**FR-1.4 (v2)** Profiles SHALL be exportable to and importable from a versioned JSON file. Import SHALL validate the schema and reject malformed payloads with a descriptive error.

### 3.2 Field Detection Engine (v1)

**FR-2.1** Upon a fill request, the content script SHALL enumerate all fillable controls on the page: `input` (excluding `type="file"`, `type="hidden"`, `type="submit"`), `textarea`, and `select`, including elements within same-origin iframes (`all_frames: true`).

**FR-2.2** For each control, the engine SHALL construct a *field fingerprint* by concatenating and normalizing: `name`, `id`, `placeholder`, `aria-label`, `autocomplete`, the text content of the associated `<label>` (via `for` attribute or DOM ancestry), and the nearest preceding heading or row label.

**FR-2.3** The fingerprint SHALL be evaluated against a configurable bilingual (English + Czech) rule dictionary. Representative rules:

| Field type | Pattern (illustrative) |
|---|---|
| First name | `/first.?name\|jméno\|křestní/i` |
| Last name | `/last.?name\|surname\|příjmení/i` |
| Email | `/e-?mail/i` |
| Phone | `/phone\|tel(?!l)\|mobil/i` |
| LinkedIn | `/linkedin/i` |
| GitHub | `/github/i` |
| Salary | `/salary\|compensation\|mzda\|plat/i` |
| City | `/city\|location\|město\|adresa/i` |
| Cover letter | `/cover.?letter\|motivat\|průvodní/i` |

The dictionary SHALL reside in a standalone configuration module to permit extension without touching engine code.

**FR-2.4** Each match SHALL produce a confidence score. Scoring weights (highest to lowest): `autocomplete` attribute exact match → `name`/`id` match → `label` text match → `placeholder` match → contextual heading match. Thresholds:
- **High** (fill silently, green highlight)
- **Medium** (fill, yellow "please review" highlight)
- **Low / no match** (do not fill, grey dashed highlight)

Threshold values SHALL be constants subject to tuning during field testing (Milestone M5).

**FR-2.5** File inputs SHALL be detected and highlighted with an "attach your CV manually" affordance. They SHALL never be filled programmatically.

**FR-2.6** Checkboxes and radio groups SHALL NOT be modified in v1. Consent-related controls SHALL never be modified in any version.

### 3.3 Form Filling (v1)

**FR-3.1** Values SHALL be written using the native property setter followed by synthetic `input` and `change` events (bubbling), to guarantee state synchronization in React/Vue/Angular-controlled forms:

```ts
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
```

**FR-3.2** Acceptance criterion for FR-3.1: the written value persists after focus/blur cycles and is present in the framework's state at submit time on all primary test-matrix sites.

**FR-3.3** For native `<select>` elements, the engine SHALL select the option whose text or value best matches the profile datum (normalized, case-insensitive, diacritics-folded), then dispatch `change`. If no option clears the similarity threshold, the field SHALL be left untouched and marked "not recognized."

**FR-3.4** After filling, the popup SHALL display a summary: fields detected / filled with high confidence / filled pending review / not recognized.

**FR-3.5** Page highlights SHALL auto-dismiss after 3 seconds or on user click.

### 3.4 Cover Letter Templates (v3)

**FR-4.1** The user SHALL be able to define multiple cover letter templates containing placeholders: `{company}`, `{position}`, `{source}`.

**FR-4.2** The content script SHALL attempt to extract company and position from the page in the following priority order:
1. JSON-LD `JobPosting` structured data (`hiringOrganization.name`, `title`) — most reliable, present on major boards;
2. Open Graph metadata (`og:title`, `og:site_name`);
3. Primary `<h1>` and document title heuristics.

**FR-4.3** When a textarea is classified as cover-letter/motivation, the active template SHALL be inserted with placeholders resolved. Unresolved placeholders SHALL remain visible in `{braces}` and the field SHALL receive the "please review" highlight.

### 3.5 AI Assistance (v4)

**FR-5.1** The options page SHALL accept a Groq API key, stored exclusively in `chrome.storage.local` (never synced). Model default: Llama 3.3 70B; model identifier SHALL be configurable.

**FR-5.2** On user request ("Generate motivation"), the extension SHALL:
1. Extract the job description (JSON-LD `description` preferred; fallback: dominant text block heuristic);
2. Dispatch a request from the background service worker (bypassing page CSP/CORS) containing the description, active profile summary, and a system prompt constraining output to 3–5 sentences in the language of the posting;
3. Render the result in the popup as editable text with an explicit "Insert into field" action.

**FR-5.3** *(Optional, feature-flagged)* Fields scored below the medium threshold MAY be batch-submitted to the LLM for classification (attributes only — never user data or page content beyond the field fingerprints). The response SHALL be strict JSON validated against a schema; on validation failure the fields remain unclassified.

> **Implementation status: met.** The parts that are not obvious from the
> requirement text:
>
> - **The flag.** `AppSettings.llmFieldClassification`, default `false`, surfaced
>   as a toggle on Options → API & Logging. The toggle is disabled until a Groq
>   key is saved, and saving with an empty key forces the flag back off — a
>   switch that silently does nothing is worse than one that says why. The opt-in
>   is checked twice: in the content script before the batch is built, and again
>   in the worker before the request goes out, because the worker is the context
>   that owns the key. Off means no egress, not "no UI for it".
> - **When it runs.** A *second* pass, after `fillPage` has filled and highlighted
>   everything it recognised. The candidates are collected during that same pass
>   (`FillOptions.onUnresolved`) rather than by re-enumerating the page, so the
>   two passes cannot disagree about what was already filled. It is started
>   without `await`: the fill result, the highlights and the popup summary never
>   wait on a network round-trip about fields nothing was written into.
> - **Where the feedback goes — the page, not the popup.** This looks like a bug
>   and is not. A frame answers a fill broadcast within milliseconds and
>   `entrypoints/ui/frames.ts` closes its collection window 400 ms later; the
>   model's answer arrives seconds after that, when no popup is listening for that
>   request any more. So the second pass reports where the user is actually
>   looking: amber highlights on the fields as they are filled, and one toast with
>   the count. **The popup's counters are the heuristic snapshot and do not
>   include classifier hits.**
> - **Confidence ceiling.** Anything filled this way is highlighted `medium`
>   ("please review"), never `high` — a non-deterministic source may not write
>   silently into a form the user submits to an employer. The ceiling is enforced
>   by the type system rather than by discipline: `LlmFieldConfidence` is
>   `Extract<FieldConfidence, 'medium'>`, i.e. it has exactly one inhabitant, and
>   there is no confidence parameter anywhere on that path to override.
> - **Batch size.** `MAX_CLASSIFY_FIELDS = 40`, enforced where the batch is built
>   *and* again in `shared/api/groq.ts` at the egress point. The binding
>   constraint is the response budget (`max_tokens: 500`): a truncated reply is
>   invalid JSON and loses the whole batch rather than one field.
> - **Failure is silent, deliberately.** No key, feature off, transport error,
>   timeout, unparseable answer, an index outside the batch, a field type that
>   does not exist, a control the user has since typed into or that has left the
>   DOM — every one of these ends with the field exactly as the heuristics left
>   it. This is the documented exception to FR-5.4: that requirement governs the
>   actions a user explicitly asked for, and this is an unattended pass over
>   fields nothing was written into.

**FR-5.4** API error states (missing key, 401, 429, timeout ≥ 15 s, network failure) SHALL each surface a distinct, actionable message in the popup. No silent failures.

### 3.6 Application Log (v5)

**FR-6.1** After a fill operation, the user MAY log the application. A log entry comprises: timestamp, company, position, page URL, profile used, and status (`submitted`).

**FR-6.2** Two logging backends SHALL be supported, selectable in options:
- **Notion:** direct Notion API integration (integration token + database ID supplied by the user);
- **Google Sheets:** POST to a user-deployed Google Apps Script Web App endpoint.

**FR-6.3** A local copy of the log SHALL always be written to `chrome.storage.local` regardless of backend availability; remote sync failures SHALL be queued for one retry and then surfaced non-blockingly.

**FR-6.4** The popup SHALL display the 10 most recent log entries.

---

## 4. Non-Functional Requirements

**NFR-1 — Privacy.** No first-party backend. All user data remains in browser storage. Network egress is limited to `api.groq.com`, `api.notion.com`, and the user's `script.google.com` endpoint — plus `script.googleusercontent.com`, which is where every Apps Script Web App redirects and is therefore part of the same single user-configured destination. Egress occurs only on explicit user action. A public privacy policy page is required for Web Store listing; the text lives in `privacy-policy.md` and still needs a hosted URL.

**NFR-2 — Permissions minimalism.** Manifest permissions: `storage`, `activeTab`, `scripting`. Host permissions restricted to the API origins above. No broad `<all_urls>` host permission; content script injection occurs on user action via `activeTab`.

*(Requirement text as authored, kept verbatim. It is not a description of the current manifest: `scripting` was never called and has been removed, `alarms` was added. The shipped set is `storage`, `activeTab`, `alarms` — see the status block immediately below.)*

> **NFR-2 — implementation status: partially met. Read this before quoting the
> paragraph above.**
>
> This requirement was violated by the shipped manifest for most of the project's
> life (`<all_urls>` + `all_frames: true`). It has been narrowed, but *not* taken
> all the way to on-demand injection, and that is a decision rather than an
> oversight.
>
> **What the manifest declares today** (transcribed from the built
> `.output/chrome-mv3/manifest.json`):
>
> - `permissions`: `storage`, `activeTab`, `alarms` — and nothing else, in
>   **both** the Chrome MV3 and the Firefox MV2 build.
>   - `alarms` was added after this document was written. It is required by
>     FR-6.3: the MV3 service worker is evicted while idle, so a `setTimeout`
>     retry would never fire. Chrome shows no user-facing warning for it.
>   - `webNavigation` was added after the fact and has since been **removed
>     again**. It was used for `getAllFrames`, to address a form living in an
>     iframe, and it carries a user-facing install warning ("Read your browsing
>     history") — a disproportionate price for an autofiller and a direct
>     contradiction of this requirement. Frame aggregation was inverted instead
>     (§5.2, "Frame addressing"), which needs no permission at all. The price
>     paid in its place is a timing one and is recorded as T-6 in §11.1.
>   - `scripting` was declared and never called; it has been **removed** too. An
>     unused permission is a review finding in both stores, and in the Firefox
>     MV2 build it is not even a real API. It comes back in the same change that
>     first calls `chrome.scripting.executeScript`, not before.
>
>   The net effect is that the permission set finally *shrank*: three permissions,
>   none of which shows an install-time warning in Chrome. Each still needs its
>   one-line justification for the Web Store submission, but there is no longer a
>   permission whose justification is "we might use it later".
> - `host_permissions`: `api.groq.com`, `api.notion.com`, `script.google.com`,
>   and `script.googleusercontent.com`. The fourth origin is not optional —
>   Apps Script Web Apps always redirect there, and without it FR-6.2's Sheets
>   backend fails after the redirect.
> - Content script `matches`: `http://*/*` + `https://*/*` — no longer
>   `<all_urls>`, which also covered `file://`, `ftp://` and every custom scheme.
>   On top of that: `exclude_matches` for well-known mail / identity / payment
>   origins, and `exclude_globs` for sign-in and checkout URLs anywhere on the web.
> - At runtime the script narrows further on its own: it returns immediately in
>   frames that cannot hold a form (non-HTML content type, sub-frames below
>   200 × 150 px), and it registers no page listeners at all on pages that look
>   like sign-in screens.
>
> **What was NOT done:** the migration to `activeTab` +
> `chrome.scripting.executeScript`, i.e. injecting nothing until the user acts.
>
> **Why we stopped here.** The inline "Fill" affordance has to appear when the
> user focuses a form field — *before* they have any way to interact with the
> extension. `activeTab` grants access only after an extension invocation
> (toolbar click, context menu, or command). Under on-demand injection the button
> could only ever appear after the user had already opened the popup or pressed
> the shortcut once per tab, which removes the feature's entire reason to exist.
> The choice was therefore: keep the declarative registration and shrink its
> surface as far as possible, or delete the inline button. We kept the button.
>
> **What remains as a plan.** If the inline button is ever dropped, or moved
> behind an explicit per-site opt-in, the full migration is three coordinated
> changes and is written out at the bottom of `entrypoints/content.ts`:
> `registration: 'runtime'` on the content script, an injection step in the
> background worker keyed on `action.onClicked` / `commands.onCommand`, and
> explicit frame addressing in the popup. An intermediate step worth considering
> first is moving the host access to `optional_host_permissions`, so the user
> grants sites as they encounter them.
>
> **Known false negative of the current approach:** `exclude_globs` are matched
> against the entire URL, not just its path, so a legitimate job posting reached
> through a link like `?utm_source=login` is silently excluded. See
> §11.1 for the full list of accepted trade-offs.

**NFR-3 — Performance.** Field scan and fill on a page with ≤ 200 controls SHALL complete within 300 ms (p95) on reference hardware. Content script bundle ≤ 50 KB gzipped.

> **Status: the bundle half is met with room to spare.** Measured on the
> production Chrome build: `.output/chrome-mv3/content-scripts/content.js` is
> 38 068 B raw / **13 635 B gzipped**, i.e. 27% of the 50 KB budget. Reproduce
> with `npm run build && gzip -c .output/chrome-mv3/content-scripts/content.js |
> wc -c`. The 300 ms scan-and-fill figure is *not* measured on reference
> hardware; what exists is a unit-level budget test over 200 controls in
> `tests/field-matcher.test.ts`, which is a weaker claim.

**NFR-4 — Page isolation.** The content script SHALL NOT leak globals, modify page prototypes, or inject styles beyond namespaced highlight classes (`__jobfill-*`). All injected UI removed on dismissal.

**NFR-5 — Resilience.** The MV3 service worker is ephemeral; no in-memory state may be assumed across events. All state transits through `chrome.storage` or message payloads.

**NFR-6 — Internationalization.** Detection heuristics: English + Czech. Extension UI: English (Web Store baseline); architecture SHALL permit adding locales via standard `_locales` mechanism.

> **Status:** the mechanism exists — `default_locale: "en"` in the manifest and
> `public/_locales/en/messages.json` resolving the `__MSG_extName__` /
> `__MSG_extDescription__` placeholders — so a second locale can be added without
> restructuring. The popup and options UI strings themselves are still hardcoded
> English; no component calls `chrome.i18n.getMessage`. Adding a locale today
> translates the store listing, not the interface.

**NFR-7 — Accessibility.** Popup and options pages SHALL be keyboard-navigable with visible focus states and appropriate ARIA labeling.

---

## 5. Architecture

### 5.1 Component Overview

| Component | Responsibility | Technology |
|---|---|---|
| **Content script** | DOM enumeration, fingerprinting, matching, filling, highlighting, page-data extraction | Vanilla TypeScript (no framework — minimal footprint, zero page conflicts) |
| **Popup** | Fill trigger, profile selector, fill summary, AI generation UI, recent log | React 19 + TypeScript |
| **Options page** | Profile CRUD, templates, API credentials, backend configuration | React 19 + TypeScript |
| **Background service worker** | All external HTTP (Groq, Notion, Apps Script), message routing | TypeScript |

### 5.2 Messaging Contract

All inter-component messages are typed discriminated unions defined in `shared/messages.ts`:

- Popup → Content: `FILL_FORM { profileId }`, `EXTRACT_JOB_INFO`, `FILL_COVER_TEXT { text }`, `FILL_ANSWERS { answers }` — each wrapped in `FrameRequest`, i.e. the message plus a `requestId`
- Content → Popup: `FRAME_REPLY { requestId, payload }`, whose payload is `FILL_RESULT { summary, openQuestions[] }` or `JOB_INFO { company?, position?, description? }`
- Popup/Content/Options → Background: `GENERATE_COVER { jobInfo, profileId }`, `ANSWER_QUESTIONS { questions[], profileId, jobInfo }`, `CLASSIFY_FIELDS { fingerprints[] }`, `INSPECT_NOTION { token, databaseId }`, `LOG_APPLICATION { jobInfo?, profileId, url }`
- Background → Popup/Options: `GENERATION_RESULT`, `ANSWERS_RESULT`, `CLASSIFY_RESULT`, `NOTION_SCHEMA_RESULT { report }`, `NOTION_SCHEMA_ERROR { kind, message }`, `LOG_RESULT { success, entry, remoteSync, message? }`, `API_ERROR { kind, message }`

`LOG_APPLICATION` deliberately carries *raw inputs* rather than a ready
`ApplicationEntry`: `id`, `timestamp`, `status` and `remoteSync` are derived by the
background worker, so no caller can put a malformed record into the journal.

**Frame addressing.** The content script runs with `all_frames: true`, and
`chrome.tabs.sendMessage` without a `frameId` delivers only the *first*
`sendResponse` back to the caller. On LinkedIn Easy Apply and Greenhouse /
Workable embeds the form lives in an iframe while the top frame answers "nothing
here" first, so the popup reported "0 filled" for a form it had just filled.

The fix inverts the direction of the answer, and needs both halves:

1. **Content script** — a frame with nothing to contribute never answers at all,
   and a frame that *does* answer replies with `chrome.runtime.sendMessage`
   instead of `sendResponse`. The listener therefore always returns `false`;
   nothing on this path uses the response channel, so no reply can shadow
   another.
2. **`entrypoints/ui/frames.ts`** — sends **one broadcast** `tabs.sendMessage`
   (no `frameId`) carrying a unique `requestId`, listens on
   `chrome.runtime.onMessage`, keeps the replies that echo that id and come from
   this tab, and aggregates them when the collection window closes. Which frame
   spoke arrives for free in `sender.frameId`, so follow-ups (`FILL_COVER_TEXT`,
   `FILL_ANSWERS`) can still be addressed at the frame that owns the form.
   Open-question ids are unique only within a frame, so they are namespaced with
   the frame id on the way out and un-namespaced on the way back — an answer can
   never reach the wrong frame's textarea.

An earlier version of this fix enumerated the frames with
`chrome.webNavigation.getAllFrames`. It worked, but it cost the `webNavigation`
permission and its "Read your browsing history" install warning, against NFR-2.
The scheme above needs **no permission at all**, and it strictly dominates the
old one on information: *every* frame reports, not just the fastest.

**What it costs.** Without an enumeration there is no frame count, so nothing
knows how many replies to expect and the 400 ms collection window
(`COLLECT_WINDOW_MS`) is the termination condition rather than a safety net. A
frame that answers after it closes still fills its own fields — that happens
locally in the frame and is already highlighted on the page — but its counts do
not reach the popup summary. The window is skipped entirely when Chrome reports
that the tab has no listener at all, so the "not a web page" case stays instant.
Recorded as T-6 in §11.1.

### 5.3 Repository Layout (WXT)

```
jobfill/
├─ entrypoints/
│  ├─ content.ts            # orchestration only; logic lives in shared/
│  ├─ popup/                 # React app
│  ├─ options/               # React app
│  ├─ ui/                    # shared React primitives (Field, Feedback, Dialog, Icons,
│  │                         # NotionCheck) + two non-React modules the background
│  │                         # worker imports as well: frames.ts, notionConnection.ts
│  └─ background.ts          # API clients + message router + retry driver
├─ shared/
│  ├─ field-matcher/         # dictionary.ts, fingerprint.ts, scorer.ts
│  ├─ filler/                # setNativeValue.ts, selectStrategy.ts, highlight.ts,
│  │                         # fillable.ts, coverTarget.ts, inlineButton.ts
│  ├─ extractors/            # jsonLd.ts, openGraph.ts, headingHeuristics.ts
│  ├─ storage/               # sync.ts, local.ts, validate.ts, retryQueue.ts
│  ├─ api/                   # groq.ts, notion.ts, sheets.ts, http.ts, remoteLog.ts
│  ├─ messages.ts
│  └─ types.ts
├─ assets/styles/globals.css # design tokens (@theme) — see README "Design system"
├─ public/_locales/en/       # manifest __MSG_* strings
├─ tests/
│  └─ fixtures/              # captured HTML form fragments per site
├─ wxt.config.ts
└─ package.json
```

Design rule: entrypoints contain orchestration only; all matching, filling, and extraction logic is implemented as pure functions in `shared/` to maximize unit-test coverage.

### 5.4 Data Model

> **Logical vs. physical layout.** The `SyncData` shape below is the *logical*
> model — it is what `getSyncSnapshot()` returns and what the export/import file
> contains. It is **not** how the data sits in `chrome.storage.sync`. Since v1.1
> the sync area is keyed per entity:
>
> ```
> jobfill.schemaVersion    number
> jobfill.profileIds       string[]      order only
> jobfill.profile.<id>     Profile
> jobfill.activeProfileId  string
> jobfill.templateIds      string[]
> jobfill.template.<id>    CoverTemplate
> jobfill.settings         AppSettings
> ```
>
> The old single `jobfill_sync` blob is migrated to this layout on first access
> and then deleted. Two reasons for the change: writes from the popup and from the
> options page no longer clobber each other (they touch disjoint keys), and the
> 8 KB `QUOTA_BYTES_PER_ITEM` limit now applies per profile instead of to the
> entire dataset. Anything entering sync storage is validated and migrated by
> `shared/storage/validate.ts` first (FR-1.4).

```ts
// chrome.storage.sync — logical shape
interface SyncData {
  schemaVersion: 1;
  profiles: Profile[];
  activeProfileId: string;
  coverTemplates: CoverTemplate[];
  settings: {
    highlightDurationMs: number;
    logBackend: "notion" | "sheets" | "off";
    // FR-5.3 opt-in. Fail-closed: `validate.ts` coerces anything that is not
    // exactly `true` back to `false`, so a corrupted or hand-edited sync item
    // can never switch the feature on.
    llmFieldClassification: boolean;
  };
}

// chrome.storage.local — secrets and bulky data, never synced
interface LocalData {
  groqApiKey?: string;
  groqModel?: string;
  notionToken?: string;
  notionDatabaseId?: string;
  sheetsEndpoint?: string;
  applicationLog: ApplicationEntry[];
}

interface Profile {
  id: string;
  label: string;                 // "Frontend", "QA", ...
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  linkedin: string;
  github: string;
  website: string;
  salaryExpectation: string;
  availability: string;
  workPermit: string;
  about: string;
}

interface CoverTemplate {
  id: string;
  label: string;
  body: string;                  // contains {company} {position} {source}
}

interface ApplicationEntry {
  id: string;
  timestamp: string;             // ISO 8601
  company: string;
  position: string;
  url: string;
  profileId: string;
  status: "submitted";
  // "off" was added with the retry queue: no remote backend is configured, so
  // the local copy is the final state rather than a failure.
  remoteSync: "ok" | "pending" | "failed" | "off";
}
```

`chrome.storage.local` additionally holds `remote_log_queue` — the durable retry
queue described in FR-6.3, drained by a `chrome.alarms` alarm.

---

## 6. Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Extension framework | **WXT** | MV3-first, TypeScript-native, HMR, Chrome + Firefox builds from one codebase |
| Language | **TypeScript** (strict) | Type-safe messaging and storage contracts |
| UI (popup/options) | **React 19** | Team familiarity; appropriate for stateful UI surfaces |
| Styling | **Tailwind CSS** | Rapid, consistent UI; scoped to extension pages only |
| AI provider | **Groq API** (Llama 3.3 70B) | Low latency, generous free tier, prior integration experience |
| Testing | **Vitest** + fixture-based DOM tests (happy-dom) | Matcher/extractor coverage against real captured markup |
| Lint/format | ESLint + Prettier | — |
| CI | **GitHub Actions** | lint → typecheck → test → build on every push; artifact zip on tags |

---

## 7. Security & Compliance

- **S-1** API credentials are confined to `chrome.storage.local`; they never enter sync storage, logs, or error reports.
- **S-2** The background worker is the sole network egress point; content scripts perform no external requests.

> **S-2 and the "Check connection" button.** The Notion schema check on the
> options page (P1-13) also goes through the worker — message `INSPECT_NOTION`,
> answered with `NOTION_SCHEMA_RESULT` / `NOTION_SCHEMA_ERROR` — even though an
> extension page could legitimately call `api.notion.com` itself: it runs on the
> extension origin, the host is in `host_permissions`, and no foreign page's CSP
> or CORS applies. S-2 is one reason. The harder reason is that the schema cache
> in `shared/api/notion.ts` is **module state**: a check performed on the options
> page would warm the options page's copy of that map, which the write path in
> the worker never sees. Routing through the worker makes the check exercise the
> same module instance — cache included — as the code that actually logs
> applications, so a passing check is evidence about the write path rather than
> about a second copy of it. The worker clears the cache entry first, otherwise a
> re-check after the user fixed their database would replay the 10-minute cached
> failure. `entrypoints/ui/notionConnection.ts` keeps a fallback to a direct call
> from the page for the case where no handler answers.

- **S-3** LLM field-classification requests (FR-5.3) contain field fingerprints only — no profile data, no page body.

> **S-3 and `semanticName`.** The wire payload is `serializeFingerprint` output
> and nothing else: nine `|`-separated attribute-derived strings — `autocomplete`,
> `name`, `id`, `semanticName`, `ariaLabel`, `labelText`, `placeholder`,
> `contextHeading`, `description`. `semanticName` was added to that list (eight
> components became nine) and does not weaken the guarantee: it is
> `extractSemanticName` applied to the control's own `name` / `id` /
> `data-automation-id`-style attributes — framework noise stripped, separators
> split — so it discloses nothing those attributes do not already contain. It
> earns its place on obfuscated ATS markup, where `id="a7f3c91e"` plus
> `data-automation-id="preferredName"` makes it the only readable identity the
> field has. Notably absent, and deliberately: the control's current *value*.
> Fields the user has already typed into are not part of a classification
> request.
- **S-4** The extension never interacts with consent checkboxes, submit buttons, or CAPTCHA elements.
- **S-5** Chrome Web Store listing requirements: single-purpose description, privacy policy URL (static page on GitHub Pages), justification for each permission.
- **S-6** GDPR posture: the developer processes no personal data (no telemetry, no backend); the user is the sole data controller of their profile data.

---

## 8. Testing Strategy

| Layer | Approach |
|---|---|
| **Unit** | field-matcher (dictionary, fingerprinting, scoring) and extractors tested against HTML fixtures captured from ≥ 4 real sites (Jobs.cz, StartupJobs, LinkedIn, Greenhouse). Target: ≥ 90% line coverage in `shared/field-matcher` and `shared/extractors`. |
| **Integration** | Filler behavior against minimal React/Vue harness pages verifying state synchronization (FR-3.2). |
| **Manual field testing** | Scripted pass over the full test matrix per release; results recorded in a test log (site × field type × outcome). |
| **Regression** | Any field-detection bug found in the wild is converted into a fixture + failing test before the fix. |

---

## 9. Milestones & Estimates

| # | Milestone | Deliverable | Estimate |
|---|---|---|---|
| M1 | Scaffold | WXT + TS + React wired; content script logs page controls; CI green | 0.5 d |
| M2 | Detection engine | Dictionary, fingerprinting, scorer; unit tests on fixtures | 1.5 d |
| M3 | Filler | Native-setter writes, select strategy, highlighting, popup summary | 1 d |
| M4 | Profile & options | Options page, single profile, typed storage layer | 1 d |
| M5 | Field validation | Full test-matrix pass; heuristic tuning; fixture backfill | 1 d |
| M6 | Multi-profile (v2) | CRUD, selector, JSON export/import | 0.5 d |
| M7 | Templates (v3) | Extractors (JSON-LD → OG → heuristics), placeholder resolution | 1 d |
| M8 | AI assist (v4) | Groq client, generation flow, error taxonomy, optional classifier flag | 1 d |
| M9 | Tracker (v5) | Notion + Sheets clients, local log, retry queue, popup list | 1 d |
| M10 | Release | Icons, screenshots, listing copy, privacy policy, Web Store submission | 0.5 d |

**Total: ~9 person-days.** MVP (M1–M5): ~5 days.

---

## 10. Acceptance Criteria

> The boxes below are deliberately still unticked. Two of them are machine-checked
> on every push — the `shared/field-matcher` and `shared/extractors` coverage
> floors, and the CI pipeline itself. The rest require the manual field-testing
> pass of Milestone M5 against live job boards, which has not been run since the
> detection engine was reworked. ("No automatic submission path exists in the
> codebase" is true today but is enforced only by review; there is no test
> asserting it.) Do not tick a box on the strength of a green CI run alone.

### MVP
- [ ] Name, email, phone, and link fields fill correctly on Jobs.cz, StartupJobs.cz, and LinkedIn Easy Apply.
- [ ] Filled values persist through focus/blur and are present at submit time on React-based forms (FR-3.2).
- [ ] Confidence-tiered highlighting works; file inputs receive the manual-attach hint; consent controls untouched.
- [ ] `shared/field-matcher` and `shared/extractors` meet the 90% coverage target with fixtures from ≥ 4 sites.
- [ ] No automatic submission path exists in the codebase.
- [ ] CI pipeline (lint, typecheck, test, build) passes.

### Full Release
- [ ] Two or more profiles switchable at fill time; export/import round-trips losslessly.
- [ ] Cover letter placeholders resolve on all JSON-LD-bearing test-matrix sites.
- [ ] AI motivation generation produces editable output and handles all defined error states distinctly.
- [ ] Application entries persist locally and sync to the configured backend (Notion or Sheets) with retry-on-failure.
- [ ] Extension published on the Chrome Web Store with privacy policy.
- [ ] README includes demo GIF, architecture summary, and build instructions.

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Job boards change markup, breaking heuristics | Detection quality degrades | Dictionary externalized as config; regression fixtures; attribute-based (not class-based) matching |
| MV3 service worker termination mid-request | Lost API responses | Stateless worker design (NFR-5); idempotent retry for log writes |
| Custom (div-based) comboboxes on ATS platforms | Fields unfillable | Out of scope for v1; documented limitation; candidate for v6 |
| Groq API changes or rate limits | AI features unavailable | Feature-flagged; extension fully functional without AI; model configurable |
| Web Store review rejection (permissions) | Delayed publication | Minimal permission set (NFR-2); per-permission justification prepared in advance |

### 11.1 Accepted Trade-offs

Behaviours the team decided **not** to fix. They are written down so that nobody
rediscovers them as bugs, and so that the cost of changing one is visible before
someone starts. Each is reproducible from the code as it stands.

| # | Behaviour | Why it stays | What changing it would cost |
|---|---|---|---|
| **T-1** | **Content script stays declaratively registered** instead of injected on demand via `activeTab`, contrary to the letter of NFR-2. | The inline "Fill" button must react to `focusin` before the user touches the extension; `activeTab` only grants access after an extension invocation. | Deleting the inline button, or gating it behind a per-site opt-in. Full plan at the bottom of `entrypoints/content.ts`. |
| **T-2** | **Editing the same profile in two places is last-write-wins.** Two different profiles, or a profile and the settings, are safe — those live in separate keys. Editing *the same* profile from the popup and the options page at once loses one of the edits, silently. | `chrome.storage` exposes no compare-and-swap or transaction primitive, so a true conflict resolution is not purchasable at any price. Within one JavaScript context writes are additionally serialised through a promise queue. | A version counter per profile plus a read-verify-write loop and a user-facing merge prompt — a lot of machinery for a two-surface, single-user application. |
| **T-3** | **`exclude_globs` match the whole URL, not just the path.** A perfectly ordinary job posting reached through `…/job/1234?utm_source=login` gets no content script at all: no inline button, no fill, no explanation. | The globs are the mechanism that keeps the extension off sign-in and checkout pages everywhere on the web, which is the single most important safety property of the injection surface. Substring matching over the whole URL is all the manifest format offers. | Dropping the URL-based exclusions and relying only on the runtime `looksLikeAuthPage()` check — which means the script *does* run on every sign-in page before deciding to do nothing. |
| **T-4** | **A field whose only signal is its visible label is left unfilled.** Example: a Workday question labelled "Earliest start date" whose only other attribute is `data-automation-id="primaryQuestionnaire--question2"`. Label alone scores 20; the medium threshold is 35. | The label weight is deliberately low because label text is the noisiest source on real ATS markup — raising it to 35 would let heading and sibling text push unrelated fields over the threshold, and writing wrong data into a form the user submits to an employer is worse than leaving a field empty. | Per-ATS selector profiles (planned) rather than a change to the weight ladder. |
| **T-5** | **"Minimum salary" in a job-board filter panel is still recognised as the salary field** and filled with the user's salary expectation. Verified against `tests/fixtures/job-search.html`: it scores 75 → `high`. | The filter carries `name="salary_min"`, `id="min-salary"` and the label "Minimum salary" — by every signal the engine has, it *is* a salary field. The generic defences do not catch it: it is not inside `role="search"`, and its name contains no search/filter token. | A negative-context rule keyed on results-page structure, or the per-ATS/site profiles planned in PROJECT_AUDIT §7.3. The neighbouring "Location" filter in the same panel *is* already defused — it scores `low` via the weak-pattern mechanism — and "Company" matches no rule at all. |
| **T-6** | **A frame that answers a fill broadcast after 400 ms is missing from the popup summary.** Its fields *are* filled and highlighted — that happens inside the frame — but its counts never reach the popup, which reports one field fewer than the page shows. | Dropping `webNavigation` (NFR-2) means there is no frame enumeration, so nothing knows how many replies to expect and the collection window is the only termination condition. 400 ms is roughly an order of magnitude above a warm reply and still inside the ~500 ms that reads as "instant" for a click. | Re-adding `webNavigation` and its "Read your browsing history" install warning, to fix a counter that is only ever wrong on a page with an unusually slow second form frame. |
| **T-7** | **FR-5.3 classifier results never appear in the popup counters**, only as amber highlights and a toast on the page. | The model answers seconds after the 400 ms window closed and the popup has already rendered its summary — often after it has been closed altogether. Reporting on the page puts the feedback where the user is looking. | Keeping the popup subscribed to a request it has finished reporting on, plus a summary that mutates under the user after they have read it. |

One smaller item, recorded because its removal is easy to mistake for an
oversight: **`scripting` used to be declared in the manifest and never called**,
held for the T-1 follow-up. It has been removed — an unused permission is a
review finding in both stores, and it leaked into the Firefox MV2 build where the
API does not exist. The T-1 plan at the bottom of `entrypoints/content.ts` says to
re-add it as part of the change that first calls it.

---

## 12. Planned Features — v6–v8

### 12.1 Resume / CV Parsing (v6)

**Goal:** allow a user to drag-and-drop their CV and have the profile fields populated automatically, eliminating manual data entry on first setup.

**Supported formats:**

| Format | Extraction method |
|---|---|
| **PDF** | PDF.js in-browser text extraction; no file ever leaves the device |
| **DOCX** | mammoth.js converts to plain text/HTML in-browser |
| **LaTeX** | Regex-based parser for common CV classes (`moderncv`, `altacv`, `europecv`); extracts `\author`, `\href`, `\phone`, `\email`, common section headers |

**FR-7.1** The Options → Profiles page SHALL include a drag-and-drop zone accepting `.pdf`, `.docx`, `.doc`, and `.tex` files up to 5 MB.

**FR-7.2** Extracted text SHALL be passed through the existing field-matcher heuristics to map detected strings to profile fields. No raw document bytes are stored; only the mapped field values are persisted.

**FR-7.3** A diff view SHALL show the user which fields would change before they confirm the import.

**FR-7.4** LaTeX parsing SHALL be client-side only. PDF/DOCX parsing MAY fall back to a user-configured Cloudflare Worker endpoint if in-browser extraction quality is insufficient, with explicit user opt-in.

**Security:** files are never uploaded to a first-party server. LaTeX and DOCX are parsed in-browser. PDF.js runs as a Web Worker inside the extension.

---

### 12.2 Subscription Tiers (v7)

**Goal:** sustainable revenue model while keeping core autofill free.

| Feature | Free | Pro |
|---|---|---|
| Profiles | 1 | Unlimited |
| Heuristic fills / day | 10 | Unlimited |
| AI motivation generation | — | ✓ |
| AI open-question answering | — | ✓ |
| Resume / CV parsing | — | ✓ |
| Application log backends | Local only | Notion + Sheets |
| Support | Community | Priority |

**FR-8.1** Free tier limits SHALL be enforced client-side via counters in `chrome.storage.local`, with server-side validation on licence key refresh.

**FR-8.2** The extension SHALL remain fully functional for heuristic fill within the free quota; AI and parsing features are gated behind the Pro licence key.

**FR-8.3** An in-extension upgrade prompt SHALL appear when a free-tier limit is reached. It SHALL open the pricing page in a new tab and SHALL NOT block the user mid-fill.

**FR-8.4** Licence state SHALL degrade gracefully on network failure: if the licence key cannot be refreshed, the last verified state is honoured for up to 7 days.

---

### 12.3 Payment Integration (v8)

**Chosen provider:** Stripe Checkout (primary) with Paddle as EU-VAT fallback.

**Architecture:**

```
User clicks Upgrade
  → Options page opens Stripe Checkout (new tab)
  → Stripe webhook fires on payment success
  → Cloudflare Worker receives webhook, validates signature
  → Worker writes { userId, plan, expiresAt } to Cloudflare KV
  → Extension polls Worker with device fingerprint
  → Worker issues short-lived JWT (24h TTL)
  → JWT stored in chrome.storage.local as licenceKey
  → On every AI/parsing action, extension verifies JWT signature locally
  → JWT refreshed silently on browser start
```

**FR-9.1** Payment SHALL be handled entirely by Stripe/Paddle hosted pages. No card data ever touches the extension or the Cloudflare Worker.

**FR-9.2** The Cloudflare Worker SHALL be open-source (published in this repo under `worker/`). Users can self-host if they prefer.

**FR-9.3** Subscription management (cancel, upgrade, invoice history) SHALL be handled via the Stripe Customer Portal, linked from Options → Account.

**FR-9.4** A licence key SHALL be portable across browsers on the same account (user provides email to link devices).

**NFR (payments):** The Worker processes no personal data beyond an anonymised device hash and the Stripe customer ID. No analytics, no tracking.

---

### 12.4 Updated Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| PDF.js extraction quality poor for complex CVs | Parsing unusable | Fallback to Worker-based extraction (user opt-in); manual field review step |
| Stripe API changes or outages | Payments blocked | Graceful degradation: last licence state valid 7 days; retry queue |
| Browser extension platform removes MV3 API used | Extension breaks | WXT abstraction layer; monitor Chrome/Firefox release notes |
| Subscription churn if free tier too generous | Revenue insufficient | A/B test free quota; monitor conversion rate |
