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

| Version | Feature |
|---|---|
| v1 (MVP) | Single profile · heuristic fill · highlights |
| v2 | Multi-profile · JSON export/import |
| v3 | Cover letter templates with `{company}` / `{position}` |
| v4 | AI motivation via Groq |
| v5 | Application log → Notion / Google Sheets |

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
