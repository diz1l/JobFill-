# Connecting an AI provider

**This is optional.** JobFill fills forms with no AI at all — the field matching,
the value composition and the cover-letter templates are all deterministic code
running in your browser. Skip this page and everything in
[Using JobFill](using-jobfill.md) still works, minus three features.

It is also the step people get wrong most often, so it is written out in more
detail than anything else here. If you are in a hurry:

> Pick the provider that **issued your key** in the dropdown, paste the key,
> leave the Model field empty, press **Check key**, then press **Save settings**.
> The last step is not optional and is not automatic.

---

## What the AI is used for

| Feature | Where | When it runs |
|---|---|---|
| **Generate motivation** | Popup button | Only when you press it |
| **Answer N open questions** | Popup button, appears when a form has essay-style questions | Only when you press it |
| **Identify unrecognized fields with AI** | Settings toggle, **off by default** | On every fill, once switched on |

The first two are on-demand. The third is the only one that runs by itself, and
it is off until you turn it on — and it cannot be turned on until a key is saved.
What it sends is described in [How it works](how-it-works.md#4-the-ais-role--and-why-it-never-sees-your-data) and in
the [privacy policy](../privacy-policy.md); the short version is that it is shown
the *attributes* of fields it could not name and the *names* of your profile
entries, never their values and never the page's text.

---

## The one mistake that costs an hour

JobFill talks to any service that speaks the OpenAI chat API. They all take a
field called "API key", they all reject each other's keys, and the error they
answer with is the same in every case: **Invalid API Key**.

So this happens:

1. You get a key at **openrouter.ai**.
2. You paste it into JobFill.
3. The Provider dropdown still says **Groq**, which is the default.
4. JobFill sends your perfectly valid OpenRouter key to `api.groq.com`.
5. Groq, correctly, says the key is invalid.
6. You spend an hour re-copying a key that was never the problem.

JobFill now refuses to make that request. Every provider stamps its keys with a
prefix, so a foreign key is recognisable *locally*, the moment you paste it —
before anything leaves the browser:

![The API tab warning that an OpenRouter key has been pasted while Groq is selected](images/groq-check-wrong-key.png)

Two things are worth noticing in that screenshot:

- The amber sentence under the key field appeared **while typing**. No request
  was made to produce it.
- Pressing *Check key* anyway answers **"Nothing was sent"** — a key issued by
  one company is not posted to another, even to find out whether it works.

The fix is the dropdown, not the key.

---

## Supported providers

These are exactly the entries in the Provider dropdown, taken from
[`shared/api/provider.ts`](../shared/api/provider.ts).

| Provider | Get a key at | Key looks like | Default model | Endpoint |
|---|---|---|---|---|
| **Groq** (default) | [console.groq.com/keys](https://console.groq.com/keys) | `gsk_…` | `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1` |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | `sk-or-v1-…` | `meta-llama/llama-3.3-70b-instruct` | `https://openrouter.ai/api/v1` |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `sk-proj-…` (older keys: `sk-…`) | `gpt-4o-mini` | `https://api.openai.com/v1` |
| **Together AI** | [api.together.xyz/settings/api-keys](https://api.together.xyz/settings/api-keys) | no fixed prefix — bare hex | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | `https://api.together.xyz/v1` |
| **Other (OpenAI-compatible)** | your own | anything | none — you type one | you type one |

**Anthropic keys (`sk-ant-…`) do not work here.** Anthropic's API is not
OpenAI-compatible, so there is no provider entry for it. JobFill recognises the
prefix anyway and says so, rather than letting you find out from a 401.

Together AI keys have no prefix, so nothing can be checked before the request —
absence of a prefix is never treated as a problem.

### Which one to choose

Any of them. The extension does not care. Groq is the default because it has a
free tier that is generous enough for this workload and is fast; if you already
pay for OpenAI or route everything through OpenRouter, use that instead. JobFill
sends a few hundred tokens per action, so cost is not a deciding factor.

---

## Setting it up

Settings → **API & Logging**.

![The API & Logging tab in full](images/options-api.png)

### 1. Provider

Pick the company that **issued the key you are about to paste**. Not the company
whose model you want — if you want Llama through OpenRouter, the provider is
OpenRouter.

The hint under the dropdown links straight to that provider's keys page.

### 2. API key

Paste it. The field is a password field, so you will see dots; that is expected.

Leading and trailing whitespace is stripped when you save and when you check, so
a key copied with a stray newline is not a problem.

If the prefix does not match the selected provider, the amber warning appears
immediately. Read it — it names both companies and tells you which of the two
things to change.

### 3. Choosing a provider may raise a permission prompt

Groq, Notion and Google Apps Script are in the extension's manifest, so they work
straight away. **OpenRouter, OpenAI and Together are not** — they are *optional*
host permissions, requested only if you actually select them.

Pick one of those three and a button appears:

> **Allow access to https://openrouter.ai/\*** — JobFill asks for one host at a
> time, so choosing OpenRouter does not widen anything for anyone who does not.

Click it and the browser asks whether JobFill may read and change data on that
site. Say yes, or the request cannot be made at all. The button disappears once
the permission is granted.

This is why the permission is not requested at install time: an origin in the
manifest is a line in the install dialog that *every* user has to accept forever,
including the majority who only ever use the default.

> **The `Other (OpenAI-compatible)` provider cannot be granted this way.** The
> browser only lets an extension request origins that its manifest already
> names, and the manifest deliberately does not contain `https://*/*` — that is
> the "read and change all your data on all websites" prompt. A custom endpoint
> therefore has no host permission, and the request only succeeds if that
> endpoint answers cross-origin requests permissively. Self-hosted gateways
> usually do; a random public API usually does not.

### 4. Model — leave it empty unless you know better

**Different providers use different names for the same model.** This is the
second most common way to get an "invalid key"-shaped error out of a working key:

| Provider | Llama 3.3 70B is called |
|---|---|
| Groq | `llama-3.3-70b-versatile` |
| OpenRouter | `meta-llama/llama-3.3-70b-instruct` |
| Together AI | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |

A Groq id sent to OpenRouter is a 404, and a 404 on a model endpoint reads
exactly like a broken key if nothing tells you otherwise.

To make that mistake harder, **switching the Provider dropdown clears the Model
field.** That is not a bug; an empty Model field means "use this provider's
default", which is always a working id, and the greyed-out placeholder shows you
which one it is.

Fill the field in only when you want a specific model. The hint under it tells
you the shape that provider expects.

### 5. Check key

![A successful key check](images/groq-check-ok.png)

The button asks the provider two questions, in this order, and stops at the first
"no":

1. **`GET /models`** — does this key exist? A 401 here, and only here, means the
   key is bad. The answer doubles as the list of models the key may use.
2. **One completion of one token** with the model above — is *this model* served?
   A retired or misspelled model is a `400` on the completions endpoint and
   shows up nowhere else, which is why the check spends a token on it.

It costs a fraction of a cent and stores nothing.

#### Reading the result

| What you see | What it means |
|---|---|
| Two green ticks | The key works and the model works. Press **Save settings**. |
| Green tick on the key, red on the model | Your key is fine. The model id is not — it was renamed, retired, or belongs to another provider. The list below the message is clickable: pick one, then save. |
| Red banner, *"Nothing was sent…"* | Wrong provider selected for this key. Nothing left the browser. |
| Red banner, *"Groq rejected this key…"* | The key really is wrong. Copy it again from the provider's dashboard — a half-pasted key looks identical in this field. |
| Red banner, *"…is rate-limiting this key"* | Wait a few seconds and check again. |
| Red banner, *"JobFill's background worker did not answer"* | Not about the key at all. Reload the extension on `chrome://extensions`, then check again. |

For Groq and OpenAI, the model list is *the models this key can use* — short, and
every entry is a valid choice, so all of them are shown as clickable pills. For
OpenRouter and Together, `GET /models` returns the whole catalogue — hundreds of
ids that have nothing to do with your key — so instead of a wall of pills you get
the count, a link to browse them properly, and the handful that resemble what you
typed.

#### The line under the button is the one that answers "did my key even save?"

Directly beneath *Check key* there is always one of three sentences:

- **"No API key is saved in this browser yet."** Typing one above is not enough.
- **"Unsaved changes. JobFill is still using `gsk_…f6a7` with `llama-3.3-70b-versatile`."**
  What you typed is not what JobFill uses.
- **"Saved in this browser: `gsk_…f6a7` with `llama-3.3-70b-versatile`."** Good.

The masked key is shown deliberately: if the last four characters do not match
what is in your clipboard, you are looking at an older key, and that is the
fastest way to find out.

### 6. Save settings

**Press the blue "Save settings" button at the bottom of the page.** Nothing on
this tab is saved as you type — not the key, not the model, not the provider, not
the Notion token.

While you have unsaved changes, an amber line next to the button says so:

> ⚠ Unsaved changes — JobFill still uses the previously saved values.

If you close the tab at that point, everything you typed is gone. *Check key* can
pass on a key that was never saved: the check tests the *typed* value on purpose,
because "is the thing in my clipboard any good?" has to be answerable before it
is stored.

### 7. Optional — Identify unrecognized fields with AI

The toggle is disabled until an API key is saved, and off by default.

Switched on, every fill sends the attributes of the fields the heuristics could
not name (at most 40 of them) and gets back a recipe such as
`{firstName} {lastName}`, which JobFill assembles locally. Fields filled this way
are always outlined **amber**, never green, so you know to check them.

It is never asked about consent boxes, employer or recruiter questions, money,
bank details, or dates of birth, and an answer aimed at one of those is discarded
on arrival. Its answer can only reference your profile entries and simple
separators — it cannot write words of its own into a form.

Turning the key off (clearing the field and saving) forces this toggle off too:
a switch that arms a feature you cannot see the state of is worse than no switch.

---

## Using a custom endpoint

Choose **Other (OpenAI-compatible)** and an *API base URL* field appears. JobFill
appends `/chat/completions` and `/models` to whatever you enter, so give it the
base — `https://my-gateway.example.com/v1`.

The URL is checked before it is stored, and refused if:

- it is not `https://` — a key sent over plain HTTP is a key given away;
- it embeds credentials (`https://user:pass@host`);
- it carries a query string or a `#fragment` — everything after the path is
  appended by JobFill, so anything there would end up in the middle of the URL.

Trailing slashes and a pasted `/chat/completions` are cleaned up for you.

A key of any shape is accepted for a custom endpoint; a proxy that forwards to
OpenAI legitimately wants an OpenAI key, and there is no way to know what a
self-hosted gateway expects.

See the note in [step 3](#3-choosing-a-provider-may-raise-a-permission-prompt)
about host permissions before relying on this.

---

## What it costs, and what is sent

Each action is a single request:

| Action | Roughly what is sent | Reply budget |
|---|---|---|
| Generate motivation | The posting's title, company and first 800 characters of its description, plus your *About* text | 300 tokens |
| Answer open questions | The questions, the role, the company, your *About* text | 800 tokens |
| Identify unrecognized fields | Up to 40 field fingerprints (attributes only) and the *names* of your profile entries | 1200 tokens |

Every request has a 15-second timeout. Your key never leaves your browser except
as the `Authorization` header of these requests, and it is stored in local
storage that is never synced to your other devices.

---

## Next

- [Using JobFill](using-jobfill.md) — the buttons these features add to the popup.
- [Troubleshooting](troubleshooting.md#invalid-api-key--but-the-key-is-definitely-right) —
  when it still does not work.
