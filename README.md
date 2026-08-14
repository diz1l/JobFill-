# JobFill — Browser Extension

A job application autofill extension built with WXT, React 19, and TypeScript.  
Works on Chrome, Edge, and Firefox.

> **Project status: pre-release.** The full technical and design audit lives in
> **[PROJECT_AUDIT.md](PROJECT_AUDIT.md)** (written in Russian). It opens with a
> *fix-status table* mapping every finding to its current state — read that table
> before assuming a defect described further down is still present.

## Quick start

```bash
npm install
npm run dev          # Chrome (hot reload)
npm run dev:firefox  # Firefox
```

## Build

```bash
npm run build          # Production Chrome build → .output/chrome-mv3/
npm run build:firefox  # Firefox build       → .output/firefox-mv2/
npm run zip            # Packaged .zip for Web Store submission
npm run zip:firefox    # Packaged .zip for Firefox Add-ons
```

## Test

```bash
npm run compile    # tsc --noEmit
npm run lint       # eslint .
npm test           # Run all tests once
npm run test:watch # Watch mode
npm run coverage   # With coverage report + thresholds
```

CI (`.github/workflows/ci.yml`) runs, in order: `lint` → `compile` → `coverage` →
`build` → `build:firefox`. A tagged push (`v*`) additionally zips both targets and
uploads them as artifacts.

`npm run coverage` enforces two kinds of gate, both declared in `vitest.config.ts`:

- **Percentage floors** for the directories that are fully covered —
  `shared/field-matcher/**`, `shared/extractors/**`, `shared/filler/**`. These are
  set at the measured numbers, so any regression fails CI.
- A repo-wide **budget of uncovered lines / statements / functions / branches**
  (Vitest reads negative thresholds as "max allowed uncovered") for the rest,
  which is currently `shared/storage` and `shared/api`. A percentage gate there
  would either be meaningless or would freeze the status quo.

The budget is a ratchet: **lower it every time tests land, never raise it.** The
comment above the numbers records when they were last measured and what moved.

## Project structure

```
entrypoints/
  content.ts          Content script — frame gating, message bridge, inline button
  background.ts       Service worker — external APIs, message routing,
                      Alt+Shift+F command handler, retry driver
  popup/              React popup app
  options/            React options page
  ui/                 Shared primitives for popup + options
    Field.tsx         Label-bound inputs / textareas / selects
    Feedback.tsx      EmptyState · ErrorBanner · skeletons (loading/empty/error)
    Dialog.tsx        Native <dialog> confirm — replaces confirm()/alert()
    Icons.tsx         Inline SVG icon set (no icon package, no text glyphs)
    NotionCheck.tsx   "Check connection" — renders the database property mapping
    notionConnection.ts  Its transport: worker first, options page as fallback
    frames.ts         Broadcast-and-collect tab messaging (no React, no DOM —
                      the background worker imports it too)
shared/
  field-matcher/      Bilingual EN+CS heuristic engine (pure functions)
    dictionary.ts     14 field rules: pattern + weak + negative + autocomplete
    fingerprint.ts    Field fingerprint, enumeration, visibility, search-context
    scorer.ts         Weight ladder, thresholds, runner-up margin, open questions
  filler/             Native-setter fill + select strategy + highlights
    fillable.ts       What may be touched (allowlist) · auth-page detection
    coverTarget.ts    Where generated cover-letter text is allowed to land
    inlineButton.ts   Inline "Fill" button + toast, inside a closed shadow root
    highlight.ts      __jobfill-* page outlines, self-removing stylesheet
  extractors/         JSON-LD → OG → heading job-info extraction
  storage/            Typed chrome.storage.{sync,local} wrappers
    sync.ts           Key-per-entity sync layer + legacy blob migration
    validate.ts       Schema validation + schemaVersion migrations (no runtime dep)
    local.ts          Secrets + application journal
    retryQueue.ts     Durable remote-log retry queue (drained by chrome.alarms)
  api/                Groq, Notion, Google Sheets clients
    http.ts           One fetch wrapper: timeout, status→kind mapping, retryable
    remoteLog.ts      RemoteLogError — UI-ready message + retryable flag
  types.ts            Domain types
  messages.ts         Typed messaging contract
assets/styles/
  globals.css         Design tokens (@theme), base layer, component classes
public/
  _locales/en/        Extension name + description (manifest __MSG_* keys)
  icons/              16 / 32 / 48 / 128 PNG
tests/
  fixtures/           Captured-style HTML: greenhouse-real, lever, workday,
                      job-search, plus the original synthetic set
  field-matcher · extractors · fillable · filler · cover-target
  highlight · inline-button · frames · storage · api   (*.test.ts)
```

## Architecture

- **Content script** — vanilla TypeScript, no framework, 38 068 B raw /
  **13 635 B gzipped** against the 50 KB NFR-3 budget. It returns from `main()`
  before touching the page when the frame cannot hold a form (non-HTML content
  type, sub-frame under 200 × 150 px). On a page that looks like a sign-in screen
  it registers no *page* listeners — the inline button is never armed — but the
  `chrome.runtime` message bridge is still installed, so an explicit fill request
  is answered rather than silently dropped.
- **Popup / Options** — React 19 + Tailwind CSS v4, sharing `entrypoints/ui/`.
- **Background** — sole network egress point (Groq, Notion, Sheets). Content
  scripts never call `fetch`.
- **No first-party backend** — all data in `chrome.storage`.

These are the things most easily got wrong if you have only read the older docs:

- **Sync storage is key-per-entity, not one blob.** `shared/storage/sync.ts` writes
  `jobfill.profile.<id>`, `jobfill.template.<id>`, `jobfill.profileIds`,
  `jobfill.settings`, … The pre-1.1 single `jobfill_sync` item is migrated away on
  first access. Consequences: the popup and the options page can write concurrently
  without clobbering each other, and the 8 KB per-item quota now applies per profile
  instead of to the whole dataset. Imports go through `shared/storage/validate.ts`,
  which validates, repairs and migrates by `schemaVersion` before anything reaches
  storage.
- **The inline "Fill" button lives in a closed Shadow DOM.** `inlineButton.ts`
  attaches a host element with `mode: 'closed'` and puts its styles inside the
  shadow root, so the page cannot read or restyle it and our CSS cannot leak out.
  Page *highlights* are the deliberate exception — they outline the page's own
  elements, so their stylesheet has to exist in the page; it is removed again when
  the last highlight is dismissed.
- **The application journal has a durable retry queue.** A failed remote write is
  parked in `chrome.storage.local` by `shared/storage/retryQueue.ts` and re-driven
  by a `chrome.alarms` alarm — an MV3 worker is evicted while idle, so a
  `setTimeout` would simply never fire. `alarms` is in the manifest for exactly
  this reason.
- **Tab messages are broadcast out and collected back over the runtime bus.**
  `chrome.tabs.sendMessage` without a `frameId` reaches every frame but hands the
  sender only the *first* `sendResponse` — which on LinkedIn Easy Apply or a
  Greenhouse embed is the top frame saying "nothing here". The fix has two halves:
  a frame with nothing to contribute never answers at all, and a frame that *does*
  answer replies with `chrome.runtime.sendMessage` rather than `sendResponse`
  (`entrypoints/content.ts`), so no reply can shadow another.
  `entrypoints/ui/frames.ts` broadcasts one request carrying a unique `requestId`,
  keeps the replies that echo it, and reads each answering frame from
  `sender.frameId` — which is exactly the information an earlier version bought
  with the `webNavigation` permission. That permission is **not** in the manifest
  any more: this direction needs none. Question ids are namespaced by frame id so
  an answer cannot land in the wrong frame's textarea.

  The price of not enumerating frames is that nothing knows how many replies to
  expect, so the 400 ms collection window (`COLLECT_WINDOW_MS`) *is* the
  termination condition. A frame that answers later still fills its own fields —
  that happens in the frame, independently — but its counts do not reach the
  popup summary. The window is cut short when Chrome reports no listener in the
  tab at all, so "not a web page" stays instant.
- **The AI field classifier reports on the page, not in the popup.** With
  Options → API & Logging → "Identify unrecognized fields with AI" switched on
  (off by default, and disabled until a Groq key is saved), `fillPage` collects
  every control the heuristics left at `low`/`none` and a *second* pass sends
  their fingerprints — attributes only, never profile data or page text — to the
  worker, which calls Groq. The pass is started without `await`, so nothing about
  the ordinary fill waits on it.

  That is also why its feedback is amber highlights plus one toast **on the
  page** rather than numbers in the popup: the answer comes back seconds after
  the 400 ms collection window closed, when nothing is listening for that request
  any more. **The popup counters are the heuristic snapshot and stay that way** —
  fields filled by the classifier are not added to them. This is not a bug, and
  changing it means keeping the popup subscribed to a request it has already
  finished reporting on.

  Anything the model matched is highlighted `medium` ("check this"), never
  `high`. That ceiling is a type, not a convention: `LlmFieldConfidence` has
  exactly one inhabitant, so there is no confidence argument on that path that
  could be passed `'high'`. Batches are capped at `MAX_CLASSIFY_FIELDS` (40),
  enforced both where the batch is built and again at the egress point in
  `shared/api/groq.ts`.

## Design system

All colour, type, spacing and radius values live as Tailwind v4 `@theme` tokens in
[`assets/styles/globals.css`](assets/styles/globals.css). That file is the single
source of truth; the rules below are enforceable by review and by `grep`.

1. **No hex literals in JSX.** Use the token utilities (`text-fg-muted`,
   `bg-surface-raised`, `border-line-strong`, …). The one intentional exception is
   `shared/filler/highlight.ts` — see *Two palettes* below.
2. **No arbitrary `[Npx]` sizes in components.** Use the type / radius / layout
   scales (`--text-*`, `--radius-*`, `--container-*`, `--sidebar-*`, `--field-min`).
3. **Never use `transition-colors` (or plain `transition`) on an interactive
   element.** Tailwind's colour transition set includes `outline-color`, which fades
   the focus ring in over 150 ms and makes keyboard focus look broken. `globals.css`
   defines a `transition-theme` utility that is the same transition **minus**
   `outline-color` — use that instead. The global `:focus-visible` rule also pins
   `transition-duration: 0s` as a second line of defence.
4. **Every interactive element gets a visible `:focus-visible` ring** (≥3:1). The
   ring comes from a zero-specificity `:where(...)` rule, so components may restyle
   it but cannot accidentally remove it.
5. **One scroll container per page.** `html.page` / `html.popup` classes on the
   entrypoint HTML pin the shell height; only `<main>` (options) or the content
   region (popup) scrolls.
6. **Every screen owes the user three states** — loading (skeleton), empty
   (explanation + call to action), error. `entrypoints/ui/Feedback.tsx` provides them.

Both a dark and a light palette are defined under the same token names; the light
one is selected by `prefers-color-scheme`.

### Two palettes, on purpose

The confidence colours exist twice, and the pairs are deliberately **not** the
same hues. Changing one to "match" the other is a regression, not a cleanup.

| | Where it is drawn | Constraint |
|---|---|---|
| `--color-conf-*` in `globals.css` | Our own popup / options surfaces | Contrast against *our* backgrounds; two variants, dark and light, switched by `prefers-color-scheme` |
| `__jobfill-*` in `shared/filler/highlight.ts` | The **page's** own form controls | Contrast against a background we do not control and cannot query |

The page outlines cannot use the extension tokens, because there is no media
query for "what colour is this job board". They have to clear 3:1 non-text
contrast against *both* extremes at once, so the values are picked for the worse
of the two: `high #16a34a` (3.30 : 1 on white, 5.73 : 1 on `#111`),
`medium #a16207` (4.92 / 3.84), `none #6b7280` (4.83 / 3.91), `ai #7c3aed`
(5.70 / 3.31), `file #2563eb` (5.17 / 3.65).

The previous set was taken straight from the UI tokens — `#22c55e / #eab308 /
#9ca3af` — and scored 2.28 / 1.92 / 2.54 on white. On an ordinary light-themed
job board the highlight was effectively invisible, which silently broke FR-3.5:
the "please review" signal for a medium-confidence fill never reached the user.
The values and the arithmetic are kept in the comment above `HIGHLIGHT_CSS`.

## Release roadmap

| Version | Feature | Status |
|---|---|---|
| v1 (MVP) | Single profile · heuristic fill · highlights | ✅ done |
| v2 | Multi-profile · JSON export/import (schema-validated) | ✅ done |
| v3 | Cover letter templates with `{company}` / `{position}` | ✅ done |
| v4 | AI motivation via Groq · inline fill button · open-question answering · optional LLM field classification | ✅ done — FR-5.3 included: opt-in toggle on Options → API & Logging, off by default, second pass after the heuristic fill (see below) |
| v5 | Application log → Notion / Google Sheets | ✅ done — popup "Log application" creates the entry, local copy always written, remote failures retried once via `chrome.alarms`, Notion property mapping discovered from the database |
| **v6** | **Resume / CV parsing** — extract profile fields from uploaded PDF, DOCX, or LaTeX source; auto-populate profile on first run | planned |
| **v7** | **Subscription tiers** — Free (limited fills/day, no AI) · Pro (unlimited fills, AI features, resume parsing, priority support) | planned |
| **v8** | **Payments** — Stripe Checkout / Paddle integration; licence key stored in `chrome.storage.local`; backend validation worker on Cloudflare Workers | planned |

### v6 — Resume parsing (detail)

- **PDF / DOCX**: use PDF.js (in-browser) or send to a Cloudflare Worker that calls a document-extraction API; extract name, email, phone, links, summary
- **LaTeX**: parse `.tex` source client-side; extract `\author`, `\href` commands and common CV class macros (`moderncv`, `altacv`, `europecv`)
- UX: drag-and-drop on the Options → Profiles page; parsed fields pre-fill the form for review before saving
- Privacy: file is processed entirely in-browser (PDF.js) or sent only to a user-configured endpoint; no first-party storage of document bytes

### v7 — Subscription tiers (detail)

| Feature | Free | Pro |
|---|---|---|
| Profiles | 1 | Unlimited |
| Heuristic fills / day | 10 | Unlimited |
| AI motivation generation | — | ✓ |
| AI open-question answering | — | ✓ |
| Resume / CV parsing | — | ✓ |
| Application log | local only | Notion + Sheets sync |
| Support | community | priority |

### v8 — Payments (detail)

- **Provider**: Stripe Checkout (preferred) or Paddle (simpler VAT handling for EU)
- **Flow**: user clicks Upgrade in Options → opens Stripe-hosted checkout in new tab → on success, webhook fires to a Cloudflare Worker → Worker stores `{ userId, plan, expiresAt }` in Cloudflare KV → extension polls Worker with a licence key to verify access
- **Licence key**: short-lived JWT signed by Worker secret; stored in `chrome.storage.local`; refreshed on browser start
- **Privacy**: no PII sent to first-party servers beyond the licence key; payment handled entirely by Stripe/Paddle

## Icons

Place 16 × 16, 32 × 32, 48 × 48, and 128 × 128 PNG icons in `public/icons/`:

```
public/icons/icon-16.png
public/icons/icon-32.png
public/icons/icon-48.png
public/icons/icon-128.png
```

`npm run icons` regenerates them from `scripts/generate-icons.js`.

## Manifest

The manifest is assembled by WXT from `wxt.config.ts` plus the entrypoints. The
table below is transcribed from the **built** `.output/chrome-mv3/manifest.json` —
if you change `wxt.config.ts`, rebuild and update it here.

### Permissions

| Permission | Reason |
|---|---|
| `storage` | Profile data, templates, settings, secrets, application journal, retry queue |
| `activeTab` | Read the active tab's URL when logging an application |
| `alarms` | Drives the application-log retry queue; the MV3 worker is evicted while idle, so no in-process timer survives. Chrome shows no user-facing warning for this permission. |

That is the whole list, and it is the same three in the Firefox MV2 build. (MV2
has no separate `host_permissions` key, so there the four origins below are
merged into the same `permissions` array — same grants, different shape.) Two
permissions were removed rather than justified, and neither should come back
without a caller:

- **`webNavigation`** was used for `getAllFrames` to address a form living in an
  iframe. It costs the user a "Read your browsing history" warning at install,
  which is a disproportionate price for an autofiller, so frame aggregation was
  inverted to the broadcast-and-reply scheme described under *Architecture*. That
  needs no permission at all.
- **`scripting`** was declared and never called. It is reserved for the
  programmatic-injection follow-up under *Content script* below — but an unused
  permission is a review finding in both stores, and in the Firefox MV2 build it
  is not even a real API. Re-add it in the same change that first calls it.

### Host permissions

| Origin | Reason |
|---|---|
| `https://api.groq.com/*` | AI motivation generation and open-question answering (user-initiated, user's own key) |
| `https://api.notion.com/*` | Application logging (optional) |
| `https://script.google.com/*` | Application logging via a user-deployed Apps Script Web App (optional) |
| `https://script.googleusercontent.com/*` | Apps Script Web Apps **always** redirect here; without this origin the logging request is blocked after the redirect |

### Other manifest keys

| Key | Value | Note |
|---|---|---|
| `default_locale` | `en` | `name` / `description` resolve from `public/_locales/en/messages.json` via `__MSG_*`. Only those two strings are localised so far — the popup and options UI is still hardcoded English. |
| `commands.fill-form` | `Alt+Shift+F` | Handled by `chrome.commands.onCommand` in `entrypoints/background.ts`; fills the active tab with the active profile without opening the popup. |
| `browser_specific_settings.gecko` | `jobfill@diz1l.dev`, `strict_min_version: 109.0` | Firefox does not persist `storage.sync` for an add-on without an explicit id. |
| `options_ui.open_in_tab` | `true` | Set via `<meta name="manifest.open_in_tab">` in `entrypoints/options/index.html` — WXT builds `options_ui` from the entrypoint and ignores `manifest.options_ui` in the config. |
| `version` | from `package.json` | Deliberately not duplicated in `wxt.config.ts`. |

### Content script

Registered declaratively, not injected on demand:

```jsonc
"matches":        ["http://*/*", "https://*/*"],
"all_frames":     true,
"match_about_blank": false,
"run_at":         "document_idle",
"exclude_matches": [ mail.google.com, accounts.google.com, outlook.{live,office,office365},
                     login.microsoftonline.com, *.paypal.com, *.stripe.com ],
"exclude_globs":   [ "*login*", "*logon*", "*signin*", "*sign-in*",
                     "*password*", "*checkout*", "*payment*" ]
```

This is narrower than the `<all_urls>` the extension used to ship with, but it is
**not** the `activeTab`-only injection the spec asks for (NFR-2). The inline "Fill"
button has to react to `focusin` before the user has any way to click the
extension, which a purely on-demand injection cannot do. See NFR-2 in
[TZ_jobfill_extension.md](TZ_jobfill_extension.md) for what was done, what was not,
and why; the follow-up plan is written out at the bottom of `entrypoints/content.ts`.

One consequence worth knowing before you file a bug: `exclude_globs` are matched
against the **whole URL**, so a perfectly ordinary job posting reached via
`?utm_source=login` is silently excluded — no content script, no inline button,
no explanation.
