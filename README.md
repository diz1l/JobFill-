# JobFill

A browser extension that fills in job application forms for you. You enter your
details once; after that, every *Jméno / E-mail / Telefon / Motivační dopis* on
every application form is one click away. It works on Chrome, Edge and Firefox,
speaks English, Czech and Slovak, and keeps everything it knows about you inside
your own browser — there is no JobFill account and no JobFill server.

<img src="docs/images/popup-filled.png" width="380" alt="The JobFill popup after filling a form: 6 filled, 2 review, 1 no data, 3 skipped, 1 attach, 1 AI">

---

## A note before you install this

**Most of the code in this repository was written by an AI.** I want that said
plainly and up front, because you are about to give a browser extension your
name, your phone number and possibly an API key, and you deserve to know what you
are installing.

What that means in practice: the AI wrote the code. The direction, the product
decisions, and the testing against real application forms are mine. The bugs that
mattered most were found the slow way — by me applying for actual jobs with it
and watching it get something wrong. I built it because filling in the same
fifteen fields on the twentieth application of the week is a miserable way to
spend an evening, and I wanted that hour back.

I have tried to make the parts that could hurt you conservative rather than
clever. JobFill never submits a form, never ticks a consent checkbox, never
touches a password field, and refuses to run on sign-in and checkout pages at
all. When it is not sure what a field is, it leaves it empty and tells you,
rather than guessing. There are **1198 automated tests**, and CI type-checks,
lints, enforces coverage floors, builds both browser targets and verifies that
the committed build matches the source before anything lands.

None of that makes it finished. It is genuinely rough in places, and the honest
list is short enough to print here:

- Field recognition is tuned for **English, Czech and Slovak**. A German or Polish
  form will do much worse.
- Some fields are **deliberately left unfilled** — a field whose only clue is an
  ambiguous label is skipped rather than filled with a value that might belong in
  a different box. Writing the wrong thing into a form an employer reads is worse
  than leaving it blank.
- Any URL containing the word `login` or `checkout` anywhere in it is excluded,
  which occasionally catches an ordinary job posting reached through a tracking
  link.
- It is **not published in any store**, so installation needs developer mode.
- In Firefox it has to be re-loaded after every browser restart.

More of these, with the reasoning behind each, are in
[How it works → Known limits](docs/how-it-works.md#known-limits).

**So: if you have a suggestion, a fix, or just a form it got wrong — please say
so.** Open an [issue](https://github.com/diz1l/JobFill-/issues) for anything, or
send a [pull request](https://github.com/diz1l/JobFill-/pulls) if you would
rather fix it directly. I read all of it.

The single most valuable thing you can send is **a form JobFill handled badly**:
the site, the label of the field that went wrong, and whether it was left empty
or filled with the wrong thing. That is how every real bug in this project has
been found so far — the dictionary simply did not know the Czech word
`lokalita`, and a field with a visible label and no useful attributes did not
reach the fill threshold. Both were invisible from the inside and obvious from
one screenshot. There is a short template for it in
[Troubleshooting](docs/troubleshooting.md#a-form-jobfill-gets-wrong).

---

## Install it

**JobFill is not in the Chrome Web Store or on Firefox Add-ons.** You install it
from this repository, which is why every path below turns on developer mode
first — that is the only way a browser will load an extension no store has
signed.

The finished, ready-to-load extension is **committed to this repository**, so you
need neither Node nor a terminal. CI rebuilds it from source on every push and
fails if the committed files have drifted, so what you download is what the code
in front of you produces.

1. Download the repository: **[Code → Download ZIP](https://github.com/diz1l/JobFill-/archive/refs/heads/main.zip)**, then unzip it somewhere permanent (Documents, not Downloads — your browser loads the extension from this folder every time it starts).
2. **Chrome / Edge / Brave / Opera / Vivaldi:** open `chrome://extensions` (or
   `edge://extensions`, etc.), switch on **Developer mode**, click **Load
   unpacked**, and select the **`chrome-mv3`** folder.
3. **Firefox:** open `about:debugging` → **This Firefox** → **Load Temporary
   Add-on…** and select **`firefox-mv2/manifest.json`**.
   ⚠️ Firefox removes temporary add-ons when it closes, so this has to be
   repeated after every restart. Your data survives; the add-on does not.
4. Pin the lightning-bolt icon to your toolbar, and reload any tab you already
   had open.

Prefer to build it yourself, or want the screenshots for each step?
**→ [Full installation guide](docs/install.md)**

## Set it up

Click the JobFill icon, then the gear. Two things live there:

- **Profiles** — your name, email, phone, links, salary expectation, availability
  and a short summary of yourself. First name, last name, email and phone are the
  four that matter most. Write the phone internationally (`+420 777 123 456`) and
  JobFill will re-spell it for forms that want nine digits, or no `+`, or a
  separate dial code.
- **Templates** — your cover letter, with `{company}`, `{position}` and
  `{source}` filled in from the posting as it is pasted.

**→ [First run: profiles and cover letters](docs/first-run.md)**

## Use it

Three ways, all identical in effect:

- the **Fill form** button in the popup;
- the small blue **⚡ Fill** button that appears beside any field you click into;
- **Alt+Shift+F**.

Everything JobFill touched is outlined for a few seconds, and the colour is the
whole report:

<img src="docs/images/form-highlights.png" width="700" alt="A Czech application form after a fill, with green, amber, grey, pink, blue and purple outlines">

| | |
|---|---|
| 🟩 green | filled, confident |
| 🟧 amber | filled — please check it |
| ⬜ grey | not recognised; type it yourself |
| 🩷 pink | recognised, but your profile is empty here — fixable in settings |
| 🟦 blue | a file input; browsers do not let extensions attach your CV |
| 🟪 purple | an open question; the AI can draft an answer |

Notice the two consent checkboxes at the bottom of that form: untouched, and not
even outlined. JobFill does not tick boxes and does not press Submit.

**→ [Using JobFill](docs/using-jobfill.md)**

## Optional extras

- **[Connect an AI provider](docs/ai-provider.md)** — Groq, OpenRouter, OpenAI,
  Together AI, or any OpenAI-compatible endpoint, with your own key. Adds
  generated motivation letters, answers to open questions, and better field
  recognition. **Read this page before pasting a key**: sending one provider's key
  to another is the single most common way to get an "Invalid API Key" out of a
  key that is perfectly fine, and JobFill now catches it before the request is
  made.
- **[Log applications to Notion or Google Sheets](docs/application-log.md)** —
  one button in the popup writes position, company, URL and date into your own
  tracker. A local copy is always kept regardless.

## Privacy, briefly

There is no JobFill server, no account, and no telemetry. Your profile lives in
your browser's own storage; your API keys live in *local* storage and are never
synced anywhere, not even to your other browsers.

Three things can leave your browser, all optional and all of them to services you
configured yourself with your own key: an AI request when you press *Generate
motivation* or *Answer questions*, an AI request per fill **only** if you switch
on the off-by-default field-recognition toggle, and one record per application if
you set up Notion or Sheets logging. Your profile *values*, the contents of form
fields, and the text of the pages you visit are never sent anywhere under any
setting — the AI is shown the *names* of your profile entries (`firstName`) and
answers with a recipe (`{firstName} {lastName}`) that your browser fills in
locally. It never sees the values.

The extension holds three permissions: `storage`, `activeTab`, `alarms`. It
cannot read your browsing history.

**→ [How it works](docs/how-it-works.md)** · **→ [Privacy policy](privacy-policy.md)**

## Documentation

| | |
|---|---|
| [Installation](docs/install.md) | Both browsers, both paths, step by step |
| [First run](docs/first-run.md) | Profiles, multiple profiles, templates, export/import |
| [Using JobFill](docs/using-jobfill.md) | Daily use, the colours, the counters, the limits |
| [Connecting an AI provider](docs/ai-provider.md) | Providers, keys, models, "Check key" |
| [Application log](docs/application-log.md) | Notion and Google Sheets |
| [How it works](docs/how-it-works.md) | The heuristics, the AI's role, privacy |
| [Troubleshooting](docs/troubleshooting.md) | When it goes wrong |
| [Development](docs/development.md) | Building, testing, architecture, manifest |

## For developers

```bash
npm install
npm run dev            # Chrome, hot reload
npm run build          # → ./chrome-mv3/
npm run build:firefox  # → ./firefox-mv2/
npm test               # the full unit suite
```

WXT · React 19 · TypeScript · Tailwind CSS v4 · Vitest. One source tree, Chrome
MV3 and Firefox MV2 targets. `chrome-mv3/` and `firefox-mv2/` are committed and
must be rebuilt in the same commit as any source change — CI checks.

**→ [docs/development.md](docs/development.md)** for architecture, the design
system, the manifest and the release roadmap.
Project status is pre-release; the full technical audit lives in
[PROJECT_AUDIT.md](PROJECT_AUDIT.md) (Russian) and the specification in
[TZ_jobfill_extension.md](TZ_jobfill_extension.md).
