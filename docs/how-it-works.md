# How JobFill works

Written for the curious and for anyone deciding whether to trust this thing with
their personal data. No code required to read it; every claim below points at the
file that implements it, so you can check.

---

## 1. It reads how a field describes itself

JobFill never guesses from position on the page. For every input, textarea and
`<select>` it builds a **fingerprint** out of nine things the field says about
itself:

```
autocomplete | name | id | semantic-name | aria-label | label | placeholder | nearby-heading | help-text
```

"Semantic name" is the readable part rescued from a generated attribute — an ATS
that calls a field `_systemfield_name_a91f` still contributes `name`.

Controls it refuses to write into at all: password, one-time-code and card
fields, checkboxes and radio buttons, hidden, disabled and read-only inputs,
anything inside a form that looks like a sign-in box, and anything inside a search
or filter region — a job board's own "Search jobs" input is not an application
field. File inputs are the one exception that is *looked* at but never filled:
they are outlined blue and counted, so you do not submit without your CV.

📄 [`shared/field-matcher/fingerprint.ts`](../shared/field-matcher/fingerprint.ts) ·
[`shared/filler/fillable.ts`](../shared/filler/fillable.ts)

## 2. It scores that fingerprint against a dictionary

There are **14 field types** — first name, last name, full name, email, phone,
LinkedIn, GitHub, website, salary, city, cover letter, availability, work permit,
about — and each one is a rule with three parts:

- **positive patterns**: several hundred spellings across **English, Czech and
  Slovak**, including every case form a Czech label takes (`jméno` / `jména` /
  `jménem`), both with and without diacritics, the exact wording the large ATS
  use (`Legal Name`, `Full name`, `Cover letter`, `Message to Hiring Manager`),
  compound phrasings (`Jméno a příjmení`, `Kdy můžete nastoupit?`), abbreviations
  (`tel.`, `mob.`, `č.`) and attribute spellings (`first_name`, `fname`,
  `candidate[first_name]`);
- **weak patterns** for genuinely ambiguous words — `location`, `motivation`,
  `lokalita`. They can push a field over the line together with a real signal but
  can never carry it alone;
- **negative patterns** that disqualify the rule outright. `Company name`,
  `Referral email`, `Emergency contact phone`, `Rodné příjmení` — a field that
  belongs to someone other than you must never receive your data.

Each source that matches contributes weight:

| Source | Weight |
|---|---|
| exact `autocomplete` match | 70 |
| `name` / `id` | 30 |
| semantic name | 25 |
| `aria-label` | 20 (+15) |
| `<label>` | 20 (+15) |
| placeholder | 15 (+15) |
| nearby heading | 10 (+15) |
| help text | 5 |

**≥ 70 fills green. ≥ 35 fills amber. Below 35 nothing is written.**

The `(+15)` is the *dedicated* bonus: it applies when the rule's match consumes
the entire text, give or take grammar. "Přiložte motivační dopis" is a dedicated
match for the cover-letter rule — `přiložte` is an imperative, not a subject — so
it scores 20 + 15 = 35 and fills. "What is your availability to travel?" is not:
`travel` is a real word the rule did not consume, so the label only *mentions*
availability and scores 20, which fills nothing.

That threshold is calibrated exactly there: `label + bonus = 35 = the fill
threshold`. On Czech job boards the visible label is routinely the *only* readable
signal — `name` and `id` are generated hashes — so a label that names the field
has to be just enough, and a label that merely mentions the word has to be not
enough.

One more guard: if the runner-up rule is within 15 points of the winner, the match
is downgraded and nothing is written. A photo finish means the field is genuinely
ambiguous and the winner owes its victory to the order rules happen to be listed
in.

📄 [`shared/field-matcher/dictionary.ts`](../shared/field-matcher/dictionary.ts) ·
[`shared/field-matcher/scorer.ts`](../shared/field-matcher/scorer.ts)

## 3. It works out which *spelling* of the value the form wants

This is the part that is easy to miss, and it has nothing to do with AI.

Knowing a box wants "the name" is not enough, because your profile stores a first
name and a last name in two fields and the form may want them in one, in either
order. So a match does not resolve to a profile property — it resolves to a
**template**, which is then filled in locally:

| The field says | Template chosen | You get |
|---|---|---|
| `Full name` | `{givenName} {familyName}` | `Dias Nurgaliyev` |
| `Jméno a příjmení` | `{givenName} {familyName}` | `Dias Nurgaliyev` |
| `Příjmení a jméno` | `{familyName} {givenName}` | `Nurgaliyev Dias` |
| `Surname, first name` | `{familyName}, {givenName}` | `Nurgaliyev, Dias` |
| `Initials` | `{firstInitial}{lastInitial}` | `DN` |

The choice is made from what the page *states out loud*, in this priority order:

1. **attribute constraints** — `type`, `pattern`, `inputmode`. A
   `pattern="[0-9]{9}"` on a phone field is not a preference, so it wins over
   everything: you get `777123456`, not `+420 777 123 456`, which would fail the
   form's own validation.
2. **the field's own wording** — "bez předvolby", "LinkedIn username", "Country
   code", "Location" versus "City".
3. **the placeholder**, weakest, because a placeholder is decoration — but
   `+420 123 456 789` in one does tell you the form expects grouped digits.
4. **`maxlength`**, handled last and separately. It never *selects* a spelling,
   it only rejects one that does not fit, and then the fullest spelling that does
   fit is used instead.

**Nothing is ever truncated to length.** A cut value is a wrong value that looks
right — "Dias Nurgaliy" is not a surname, and twelve digits of a thirteen-digit
number is somebody else's phone. If no spelling fits, the chosen one goes in
whole and the field is highlighted for review like any other.

And nothing is ever invented. A derived spelling of a fact you did not enter is
empty, not plausible: `phoneNational` of an empty phone is empty.

📄 [`shared/filler/valueTemplate.ts`](../shared/filler/valueTemplate.ts) ·
[`shared/filler/templateVariants.ts`](../shared/filler/templateVariants.ts) ·
[`shared/filler/atoms.ts`](../shared/filler/atoms.ts)

## 4. The AI's role — and why it never sees your data

The language model is optional, and where it *is* used, it is deliberately kept
on the wrong side of a wall from your personal information.

Consider the hardest case: the "Identify unrecognized fields with AI" pass. The
model has to be able to say "this box wants your first name and your surname
together". The obvious way to let it do that is to show it your profile. JobFill
does not do that. Instead:

1. The model is shown the **names** of the things your profile holds —
   `firstName`, `lastName`, `email`, `phone`, `city`, `linkedin`, `github`,
   `website`, `salary`, `availability`, `workPermit`, `about`, `coverLetter` —
   and the fingerprints of the fields that were not recognised. Attribute text
   only: no field contents, no page text.
2. It answers with a **recipe**, not a value: `"{firstName} {lastName}"`.
3. **Your browser** substitutes the recipe against data that never left it.

The model sees `firstName`. It never sees *Dias*. That is the whole rule, and it
is the reason this feature can exist at all.

The answer is not trusted either. On arrival — twice, once in the extension's
background worker and again in the page, right before anything is written — it is
checked:

- it may only reference names that actually exist;
- at most three of them per field;
- the literal text between them may only be spaces and simple punctuation, up to
  12 characters. **Letters and digits are not in that set**, so
  `"I confirm that I have read the terms"` and `"1990-01-01"` are not expressible
  answers. Every character that reaches a form comes from your own data or from a
  separator;
- fields about consent, the employer, a third party (reference, emergency
  contact, guardian), money, bank details, or identity documents are refused
  outright, whatever the model said;
- money fields may only receive your salary entry and date fields only your
  availability entry — nothing else, ever.

Anything filled this way is outlined **amber**, never green. That ceiling is
enforced by the type system rather than by convention: the value passed to the
highlighter on that path has exactly one possible value, so there is no
expression in the codebase that could mark a model-derived fill as confident.

The two on-demand features are less exotic: *Generate motivation* and *Answer
open questions* do send your *About* text, because writing a letter about you
without knowing anything about you is not a feature. They send nothing else from
your profile, and they only run when you press the button.

📄 [`shared/api/fieldTemplates.ts`](../shared/api/fieldTemplates.ts) ·
[`shared/api/groq.ts`](../shared/api/groq.ts)

## 5. Where your data lives

**There is no JobFill server.** No account, no sign-up, no telemetry, no analytics,
no crash reporting. There is nowhere for your data to go, because there is nothing
on the other end.

| What | Where | Leaves the device? |
|---|---|---|
| Profiles, cover letter templates, settings | `chrome.storage.sync` | Only through your browser's own account sync, to your other signed-in browsers |
| API keys, Notion token, Sheets URL | `chrome.storage.local` | Never — not even to your other browsers |
| Application log, retry queue | `chrome.storage.local` | Only to the Notion / Sheets backend you configured yourself |
| The last fill's summary | `chrome.storage.session` (in memory) | Never. Cleared when the browser restarts |

Uninstalling the extension deletes all of it.

---

## Privacy, in two paragraphs

**What leaves your browser, and when.** Three things, all of them optional and
all of them under your control. If you have configured an AI provider: pressing
*Generate motivation* sends the posting's title, company and a description
excerpt together with your profile's *About* text; asking JobFill to answer an
open question sends that question, the posting and your *About* text; and — only
if you switch the off-by-default "Identify unrecognized fields with AI" toggle on
— each fill sends the *attributes* of the fields it could not name (name, id,
label, placeholder, section heading, help text — at most 40 of them) plus the
*names* of your profile entries. If you have configured application logging:
pressing *Log this application* sends one record — position, company, URL, date,
status, profile id — to your own Notion database or your own Google Sheet. Every
one of these goes to a service you chose, with a key you supplied, and none of
them passes through anything belonging to JobFill.

**What never leaves, under any setting.** Your profile *values* — name, email,
phone, links, salary, availability. The contents of any form field, including the
ones JobFill just filled and the ones it did not understand. The text of the pages
you visit. Your browsing history, which JobFill has no permission to read: the
extension holds exactly three permissions (`storage`, `activeTab`, `alarms`) plus
the specific API hosts it talks to. Your API keys, which are stored locally, are
never synced to your other devices, and are never included in an export file. And
nothing at all is sent to the authors of JobFill, because there is no address to
send it to.

The formal version is in [`privacy-policy.md`](../privacy-policy.md).

---

## Known limits

Written down so nobody rediscovers them as bugs. The full list, with the
reasoning and the cost of changing each one, is in
[`TZ_jobfill_extension.md` §11.1](../TZ_jobfill_extension.md) and
[`PROJECT_AUDIT.md`](../PROJECT_AUDIT.md).

- **The dictionary is English, Czech and Slovak.** A German or Polish form falls
  back to whatever `autocomplete` and English attribute names it happens to carry.
- **A field whose only signal is its visible label, with no attributes at all, is
  sometimes left empty.** Label alone scores 20 and the fill threshold is 35 —
  unless the label *names* the field exactly, in which case the dedicated bonus
  carries it. Raising the label weight would start filling wrong fields, which is
  much worse.
- **A "Minimum salary" filter on a search-results page is filled** with your
  salary expectation, because by every signal available it is a salary field.
- **Any URL containing `login`, `signin`, `checkout` or `payment` anywhere in it
  is excluded** — including a perfectly ordinary posting reached through
  `?utm_source=login`. That is the price of a rule that keeps the extension off
  every sign-in page on the web.
- **On a page with more than one form frame, a slow second frame's fields are
  filled but not counted** in the popup summary. Fixing it would cost a "read
  your browsing history" permission at install.
- **In Firefox the extension is temporary** and has to be reloaded after every
  browser restart. See [installation](install.md#step-2b--firefox).
