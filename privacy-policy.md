# JobFill — Privacy Policy

Last updated: August 2026

JobFill does not collect, transmit, or sell any user data.

## What data JobFill stores
JobFill stores the applicant profiles, cover letter templates, application log, and settings that you create. All of this data is stored locally in your browser using the browser's extension storage API. Profiles, templates and settings use synced storage, so your browser may replicate them to your other signed-in browsers; API keys and the application log use local storage and never leave the device. None of it is ever sent to us — we operate no server — and it leaves your browser only in the cases you explicitly configure (see below).

## Network requests
JobFill has no backend server and sends no telemetry. Network requests occur only on your explicit action, and only to these destinations:
- **The AI provider you choose** — only if you enable AI generation and provide your own API key. JobFill ships with `api.groq.com` allowed; OpenRouter (`openrouter.ai`), OpenAI (`api.openai.com`) and Together (`api.together.xyz`) are optional and your browser will ask for your permission the moment you select one. You may also point JobFill at any other OpenAI-compatible endpoint you control. Whichever you pick, the request goes to that provider and to no one else, and JobFill sends nothing to any provider you have not configured;
- **Notion API** (`api.notion.com`) — only if you enable application logging to your own Notion workspace;
- **Google Apps Script** (`script.google.com`, and `script.googleusercontent.com`) — only if you enable application logging to your own Google Sheet. Both hosts belong to the same request: a deployed Apps Script Web App always redirects from `script.google.com` to `script.googleusercontent.com`, so the extension must be allowed to follow that redirect. No separate data is sent to the second host.

Your API keys are stored locally on your device and are never synced or shared.

If a logging request fails, the entry is kept in a local retry queue in your browser and retried once. The queue never leaves your device.

## What JobFill reads from the pages you visit
JobFill runs on `http://` and `https://` pages in order to find and fill form fields. It reads the form fields of the current page and the job posting's public metadata (company, position, description) so it can fill and, if you ask it to, generate a cover letter. This happens entirely inside your browser. Page content is never sent anywhere, with four exceptions you control, all of them using your own API key:
- pressing "Generate motivation" sends an excerpt of the job description together with your profile summary to your chosen AI provider;
- asking JobFill to answer an open question sends the text of that question, the job description and your profile summary to your chosen AI provider;
- if you switch on "Identify unrecognized fields with AI" in Settings — off by default — then each time JobFill fills a form it sends a description of the fields it could **not** recognise to your chosen AI provider, so it can ask what they are. What is sent about each such field is limited to how that field identifies itself: its `name` and `id` attributes, its visible label, its placeholder text, the heading of the section it sits in, and any help text attached to it. At most 40 fields per form.

  This third case is worth being precise about, because it is the only one that happens as part of an ordinary fill rather than on a button you press. Even so: **your profile data is never part of it, and neither is anything you have typed into the page.** The current contents of the form fields are not sent — not of the unrecognised fields, and not of any other field. Neither is the body text of the page — with the single exception described in the next point. JobFill sends the question "what kind of field is this?" and nothing more; the answer is used to fill the field from your own profile, locally. Turning the setting off, or leaving it off, means nothing is sent while filling at all.

- the same setting, and only that setting, also lets JobFill ask which entry of a **drop-down list** belongs in it, for lists your profile could not answer. A choice can only be made among the entries the site offers, so this one request carries something the others do not: **the option labels of that drop-down** — the fixed choices the site's author wrote into the page, identical for every visitor. Nothing else from the page body goes with them: not the surrounding text, not the job description, not any other field, and not a drop-down you have already answered. The model replies with the *number* of an option, never with text of its own, so the only thing JobFill can select is an entry that was already on the page.

  This is bounded on both sides. It happens only for lists of 20 options or fewer, at most 8 lists and 4000 characters of option text per form — a country list is far longer and is never sent — and it never happens at all for a yes/no list, or for a question about your age or date of birth, your right to work, citizenship or visa status, a criminal record, military service, disability, race, gender, religion or any other protected characteristic, consent or marketing, a confirmation that something is true or complete, or your level of education. Those are statements about you: JobFill fills them from what you saved in your profile, or leaves them empty, and never asks a model to answer them. Anything chosen this way is highlighted amber for you to check before you submit.

Nothing else from the page is transmitted.

JobFill never reads or fills password fields, never touches consent or GDPR checkboxes, and never submits a form for you. It does not run on well-known mail, identity and payment sites, or on URLs that look like sign-in or checkout pages.

## Data controller
Since JobFill has no server and collects nothing, you are the sole owner and controller of your data. Uninstalling the extension removes all locally stored data.

## Contact
Questions: open an issue at https://github.com/diz1l/JobFill-
