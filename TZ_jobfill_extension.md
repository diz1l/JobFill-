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
| **v4** | AI motivation generation; open-question answering; inline fill button | Assist | ✅ shipped |
| **v5** | Application logging to Notion / Google Sheets; recent applications view | Tracker | ✅ shipped |
| **v6** | Resume / CV parsing from PDF, DOCX, or LaTeX; auto-populate profile on import | Parser | planned |
| **v7** | Subscription tiers — Free (limited) vs Pro (unlimited + AI + parsing) | Monetise | planned |
| **v8** | Payment integration — Stripe / Paddle; licence key via Cloudflare Worker | Payments | planned |

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

**NFR-1 — Privacy.** No first-party backend. All user data remains in browser storage. Network egress is limited to `api.groq.com`, `api.notion.com`, and the user's `script.google.com` endpoint, and occurs only on explicit user action. A public privacy policy page is required for Web Store listing.

**NFR-2 — Permissions minimalism.** Manifest permissions: `storage`, `activeTab`, `scripting`. Host permissions restricted to the three API origins above. No broad `<all_urls>` host permission; content script injection occurs on user action via `activeTab`.

**NFR-3 — Performance.** Field scan and fill on a page with ≤ 200 controls SHALL complete within 300 ms (p95) on reference hardware. Content script bundle ≤ 50 KB gzipped.

**NFR-4 — Page isolation.** The content script SHALL NOT leak globals, modify page prototypes, or inject styles beyond namespaced highlight classes (`__jobfill-*`). All injected UI removed on dismissal.

**NFR-5 — Resilience.** The MV3 service worker is ephemeral; no in-memory state may be assumed across events. All state transits through `chrome.storage` or message payloads.

**NFR-6 — Internationalization.** Detection heuristics: English + Czech. Extension UI: English (Web Store baseline); architecture SHALL permit adding locales via standard `_locales` mechanism.

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

- Popup → Content: `FILL_FORM { profileId }`, `EXTRACT_JOB_INFO`
- Content → Popup: `FILL_RESULT { summary }`, `JOB_INFO { company?, position?, description? }`
- Popup/Content → Background: `GENERATE_COVER { jobInfo, profileId }`, `CLASSIFY_FIELDS { fingerprints[] }`, `LOG_APPLICATION { entry }`
- Background → Popup: `GENERATION_RESULT`, `LOG_RESULT`, `API_ERROR { kind, message }`

### 5.3 Repository Layout (WXT)

```
jobfill/
├─ entrypoints/
│  ├─ content.ts            # orchestration only; logic lives in shared/
│  ├─ popup/                 # React app
│  ├─ options/               # React app
│  └─ background.ts          # API clients + message router
├─ shared/
│  ├─ field-matcher/         # dictionary.ts, fingerprint.ts, scorer.ts
│  ├─ filler/                # setNativeValue.ts, selectStrategy.ts, highlight.ts
│  ├─ extractors/            # jsonLd.ts, openGraph.ts, headingHeuristics.ts
│  ├─ storage/               # typed wrappers over chrome.storage.{sync,local}
│  ├─ api/                   # groq.ts, notion.ts, sheets.ts
│  ├─ messages.ts
│  └─ types.ts
├─ tests/
│  └─ fixtures/              # captured HTML form fragments per site
├─ wxt.config.ts
└─ package.json
```

Design rule: entrypoints contain orchestration only; all matching, filling, and extraction logic is implemented as pure functions in `shared/` to maximize unit-test coverage.

### 5.4 Data Model

```ts
// chrome.storage.sync
interface SyncData {
  schemaVersion: 1;
  profiles: Profile[];
  activeProfileId: string;
  coverTemplates: CoverTemplate[];
  settings: {
    highlightDurationMs: number;
    logBackend: "notion" | "sheets" | "off";
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
  remoteSync: "ok" | "pending" | "failed";
}
```

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
- **S-3** LLM field-classification requests (FR-5.3) contain field fingerprints only — no profile data, no page body.
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
