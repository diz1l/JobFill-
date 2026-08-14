# Installing JobFill

JobFill is **not published in the Chrome Web Store or on Firefox Add-ons.** There
is no "Add to Chrome" button anywhere, and any page that offers you one is not us.
You install it yourself from this repository, which is why every path below turns
developer mode on first — that is the only way a browser will load an extension
that a store has not signed.

Two ways in:

| | Who it is for | Needs |
|---|---|---|
| **[A — Install the ready-made build](#a--install-the-ready-made-build)** | Everyone. This is the normal path. | A browser and the ability to unzip a file |
| **[B — Build it from source](#b--build-it-from-source)** | People who intend to change the code | Node.js 22, a terminal |

---

## A — Install the ready-made build

The repository already contains the finished extension, built and committed:

- `chrome-mv3/` — for **Chrome, Edge, Brave, Opera, Vivaldi** and anything else
  built on Chromium
- `firefox-mv2/` — for **Firefox**

You do not need Node, npm, or a terminal for this. You do not need to build
anything. You only need to download these folders and point your browser at one.

### Step 1 — Download the repository

1. Open **<https://github.com/diz1l/JobFill->** in your browser.
2. Click the green **Code** button, then **Download ZIP**.
3. You get a file called `JobFill--main.zip`. (Yes, two dashes — the repository
   name itself ends with one.)
4. Unzip it. Double-click on Windows and macOS; on Windows, choose
   *Extract All…* so you get a real folder rather than a preview window.
5. You now have a folder named `JobFill--main`. Inside it you will see
   `chrome-mv3`, `firefox-mv2`, `README.md`, and a lot of other things you can
   ignore.

> **Put this folder somewhere permanent** — Documents, for example. Not the
> Downloads folder, and not the Desktop if you tidy it often. Your browser does
> **not** copy the extension; it loads it from this folder every single time it
> starts. Move the folder, rename it, or delete it, and the extension disappears.

### Step 2a — Chrome, Edge, Brave, Opera, Vivaldi

The steps are the same everywhere; only the address of the extensions page and
the position of the developer-mode switch differ.

| Browser | Address to open | Where the switch is |
|---|---|---|
| Chrome | `chrome://extensions` | top right, "Developer mode" |
| Edge | `edge://extensions` | bottom left, "Developer mode" |
| Brave | `brave://extensions` | top right, "Developer mode" |
| Opera | `opera://extensions` | top right, "Developer mode" |
| Vivaldi | `vivaldi://extensions` | top right, "Developer mode" |

1. Type the address into the address bar and press Enter. (Links to `chrome://`
   pages cannot be clicked from a web page — you have to type it.)
2. Switch **Developer mode** on. New buttons appear: *Load unpacked*, *Pack
   extension*, *Update*.
3. Click **Load unpacked**.
4. In the file picker, navigate into `JobFill--main` and select the
   **`chrome-mv3`** folder. Select the folder itself and confirm — do **not**
   open it and pick a file inside, and do **not** select `JobFill--main`.
5. A **JobFill** card appears in the list. That is it — it is installed.

**How to tell it worked:** the card says *JobFill 1.0.0*, "Autofill job
application forms in one click.", and has no red *Errors* button.

**Make the icon visible.** Chrome hides new extensions behind the puzzle-piece
button in the toolbar. Click the puzzle piece, find JobFill, and click the pin
next to it. The lightning-bolt icon then stays on the toolbar, which is how you
open the popup.

**Reload any tab you already had open.** JobFill's page script is only injected
when a page loads, so tabs opened before the install will not react until you
refresh them.

> Chrome will remind you on some startups that "extensions in developer mode"
> are running, and offer to disable them. Choosing *Cancel* / *Keep* leaves
> JobFill alone. This warning is unavoidable for any extension that is not
> installed from a store.

### Step 2b — Firefox

Firefox is different, and the difference matters, so read the warning first.

> ### ⚠️ In Firefox, JobFill is removed every time you close the browser.
>
> Firefox only lets you side-load an unsigned extension as a **temporary
> add-on**. Temporary add-ons live until the browser quits — after that, JobFill
> is gone from the toolbar and you have to repeat these five steps.
>
> **Your data is not lost.** Profiles, templates and settings stay in Firefox's
> storage under the add-on id `jobfill@diz1l.dev`, which is fixed, so reloading
> the add-on brings everything back.
>
> If you want it to survive restarts today, use a Chromium browser
> ([Step 2a](#step-2a--chrome-edge-brave-opera-vivaldi)). The other options are
> Firefox Developer Edition / Nightly with `xpinstall.signatures.required` set
> to `false` in `about:config`, or waiting for a signed release — neither is
> something a normal Firefox install can do.

1. Type **`about:debugging`** into the address bar and press Enter.
2. In the left sidebar, click **This Firefox**.
3. Click **Load Temporary Add-on…**.
4. Navigate into `JobFill--main` → **`firefox-mv2`** and select the file
   **`manifest.json`**. Firefox asks for a *file* here, not a folder — this is
   the one place where the two browsers genuinely differ.
5. JobFill appears under *Temporary Extensions*.

Pin the icon the same way as in Chrome (right-click the toolbar →
*Customize Toolbar…* if it is not already there), and reload any tab you had
open.

### Step 3 — Check the keyboard shortcut (optional)

JobFill registers **Alt+Shift+F** to fill the current page without opening the
popup. If another extension has already claimed that combination, Chrome silently
gives it to whoever registered first.

- Chrome / Edge: open `chrome://extensions/shortcuts` (or `edge://extensions/shortcuts`),
  find JobFill, and set or change the combination there.
- Firefox: `about:addons` → gear icon → *Manage Extension Shortcuts*.

---

## B — Build it from source

Use this if you are going to change the code. The output is byte-for-byte the
same as the committed folders in path A.

```bash
git clone https://github.com/diz1l/JobFill-.git
cd JobFill-
npm install
npm run build           # → ./chrome-mv3/
npm run build:firefox   # → ./firefox-mv2/
```

Requirements: **Node.js 22** (the version CI uses) and npm. `npm install` runs
`wxt prepare` afterwards, which generates the type definitions the build needs —
if you skip it, `npm run build` fails with missing types.

The build output goes **into the repository root**, not into `.output/`. That is
set by `outDir: '.'` in [`wxt.config.ts`](../wxt.config.ts). So once the build
finishes you load `chrome-mv3/` (or `firefox-mv2/manifest.json`) exactly as in
[Step 2a](#step-2a--chrome-edge-brave-opera-vivaldi) / [2b](#step-2b--firefox).

For live reloading while you work, `npm run dev` builds to `chrome-mv3-dev/` and
opens a browser with the extension already loaded. More in
[docs/development.md](development.md).

---

## Updating to a newer version

Path A: download the ZIP again, replace the folder, then go back to
`chrome://extensions` and press the **reload** (↻) icon on the JobFill card. In
Firefox, load the temporary add-on again.

Path B: `git pull && npm run build && npm run build:firefox`, then reload the
card.

Your profiles, templates and API keys are stored by the browser, not by the
folder, so an update never loses them.

## Removing it

- Chrome / Edge: `chrome://extensions` → **Remove** on the JobFill card. This
  deletes everything JobFill ever stored, including your API keys.
- Firefox: quit the browser, or click *Remove* under *Temporary Extensions*.

Deleting the `JobFill--main` folder without removing the extension leaves a
broken card behind in `chrome://extensions`; remove the card too.

---

## Next

- **[First run — profiles and templates](first-run.md)** — you need a profile
  before anything can be filled.
- [Connecting an AI provider](ai-provider.md) — optional, and the step people
  most often get wrong.
