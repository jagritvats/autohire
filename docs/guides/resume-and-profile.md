# Your résumé & profile

Your profile is what JobFlow ranks against and the only material it tailors from. It has
four parts:

| Part | What it is | Used for |
|---|---|---|
| **Base résumé** | the text (and, for LaTeX, the source) of your résumé | grounding for every tailored document and answer |
| **Evidence Bank** | individual, citeable claims — a project or role with a headline, detail and metric | the bullets tailoring may use; nothing outside it (or your résumé) is ever claimed |
| **Skills & level** | your stack, years of experience, level | stack-adjacency, seniority and experience-gap scoring |
| **Preferences** | home country, markets, remote regions, relocation, salary floor, role types, location weights | location, salary and archetype scoring; the two hard exclusions |

## Importing a résumé

```bash
pnpm jobflow profile import ./cv.pdf            # replaces your base résumé, adds evidence
pnpm jobflow profile import ./cv.docx --merge    # keeps what you have, fills gaps, unions skills
```

In the web app: **/onboarding**, or Settings → Base résumé.

| Format | Notes |
|---|---|
| PDF | Text PDFs only. A scanned PDF has no text layer — paste the text instead. Two-column layouts can come out in a strange order; review the draft. |
| DOCX | Paragraphs, bullets, tabs and line breaks are kept. |
| LaTeX (`.tex`) | The source is also kept as your tailoring template; tailoring rewrites only the document body and keeps your preamble byte-for-byte. |
| Markdown / text | As written. |
| JSON Resume | The [jsonresume.org](https://jsonresume.org) schema: basics, work highlights, projects, skills. |
| LinkedIn export | The `.zip` from LinkedIn → Settings → Data privacy → Get a copy of your data (or its `Positions.csv` / `Skills.csv` / `Profile.csv`). |

### What extraction does — and doesn't

The parser **copies spans from your file**. Evidence headlines and details are your own
bullet text, verbatim; metrics are numbers that appear in the bullet. Skills are matched
against a dictionary (unknown ones are offered for you to add, not dropped). Years of
experience are computed from dated roles, counting overlaps once.

With `--assist` (or the checkbox in the wizard) your configured LLM also reads the résumé.
Its output goes through a grounding filter: an evidence item survives only if ≥85% of its
words and every number appear in your file; a skill, contact field or role only if it's in
the text. Anything dropped is listed as a warning. With the offline `echo` provider, assist
does nothing.

You always review the draft before it's saved.

## Editing your profile

```bash
pnpm jobflow profile show
pnpm jobflow profile set home US
pnpm jobflow profile set markets US,CA
pnpm jobflow profile set floor "150000 USD"
pnpm jobflow profile edit                       # opens the editable fields in $EDITOR
pnpm jobflow evidence list
pnpm jobflow evidence add --project "Billing" --headline "Cut invoice latency 40%" --detail "…"
```

## Contact details & the form-filler

Only the contact fields you store are ever typed into an application form, and the filler
always stops before submitting. Set them in `jobflow init`, `jobflow profile set`, or
Settings → Contact.

## Starting over / trying it out

`pnpm jobflow init --sample` (or "try with a fictional sample profile" in the wizard)
replaces your profile with **Alex Example**, an invented candidate. Sample evidence is
labelled, and the tailor warns before drafting from it.
