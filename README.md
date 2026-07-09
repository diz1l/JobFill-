# JobFill — Browser Extension

A job application autofill extension built with WXT, React 19, and TypeScript.  
Works on Chrome, Edge, and Firefox.

## Quick start

```bash
npm install
npm run dev          # Chrome (hot reload)
npm run dev:firefox  # Firefox
```

## Build

```bash
npm run build          # Production Chrome build → .output/chrome-mv3/
npm run build:firefox  # Firefox build → .output/firefox-mv3/
npm run zip            # Packaged .zip for Web Store submission
npm run zip:firefox    # Packaged .zip for Firefox Add-ons
```

## Test

```bash
npm test           # Run all tests once
npm run test:watch # Watch mode
npm run coverage   # With coverage report
```

## Project structure

```
entrypoints/
  content.ts          Content script — DOM enumeration, fill, highlight
  background.ts       Service worker — external APIs, message routing
  popup/              React popup app
  options/            React options page
shared/
  field-matcher/      Bilingual EN+CS heuristic engine (pure functions)
  filler/             Native-setter fill + select strategy + highlights
  extractors/         JSON-LD → OG → heading job-info extraction
  storage/            Typed chrome.storage.{sync,local} wrappers
  api/                Groq, Notion, Google Sheets clients
  types.ts            Domain types
  messages.ts         Typed messaging contract
tests/
  fixtures/           Captured HTML from Jobs.cz, LinkedIn, Greenhouse, StartupJobs
  field-matcher.test.ts
  extractors.test.ts
```

## Architecture

- **Content script** — vanilla TypeScript, no framework, minimal footprint.  
  Injects `__jobfill-*` highlight classes; all globals cleaned up on dismiss.
- **Popup / Options** — React 19 + Tailwind CSS v4.
- **Background** — sole network egress point (Groq, Notion, Sheets).
- **No first-party backend** — all data in `chrome.storage`.

## Release roadmap

| Version | Feature | Status |
|---|---|---|
| v1 (MVP) | Single profile · heuristic fill · highlights | ✅ done |
| v2 | Multi-profile · JSON export/import | ✅ done |
| v3 | Cover letter templates with `{company}` / `{position}` | ✅ done |
| v4 | AI motivation via Groq · inline fill button · open-question answering | ✅ done |
| v5 | Application log → Notion / Google Sheets | ✅ done |
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

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Profile data and settings |
| `activeTab` | Read and interact with the current tab on user click |
| `scripting` | Inject content script dynamically |
| `https://api.groq.com/*` | AI motivation generation (user-initiated) |
| `https://api.notion.com/*` | Application logging (optional) |
| `https://script.google.com/*` | Application logging via Apps Script (optional) |
