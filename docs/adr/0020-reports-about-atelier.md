# ADR-0020: Reports about Atelier, from people and from the assistant

- **Status:** Accepted and built (branch `feedback-reports`, 2026-10-11). Asked for by the owner: "Can we also implement a report issue button or have the AI agent be able to generate feedback reports on the system every so often for iterative improvements?" Both were built.

## Decision

- **One place for reports about Atelier itself:** `feedback_reports` (migration
  0021). Like the audit log it looks across studios, so it is not
  tenant-scoped; only operator routes read it, and the runtime role cannot
  delete from it.
- **People:** "Report a problem or suggest an idea" in the account menu on every
  page, and "Report this problem" beside an error from the assistant. The
  dialog asks one thing (what happened / what would be better). The page, the
  screen size, the browser, the build, and the names of the studio and website
  (only if the person belongs to them) are attached, so nobody has to describe
  where they were. Nothing from inside a website is sent. Ten an hour per person.
- **The assistant:** a tool, `report_to_atelier`, and a rule: when something in
  Atelier itself got in its way (a tool failed or misled, the rules were unclear
  or contradictory, something it needed did not exist), say so once, after the
  work, in a sentence or two. Never the person's wording, names or content.
  Five a day per website. This is the part that feeds iteration: the assistant
  is the heaviest user of the tools and rules, and until now nobody heard when
  they failed it.
- **The operator** is notified (in the app at most hourly per kind, by e-mail at
  most every thirty minutes per kind) and reads them under **Operator → Reports**:
  to look at / dealt with, and **everything open as one document**
  (`GET /api/v1/admin/feedback.md`), which is what to hand to whoever improves
  Atelier next, person or agent.

## Consequences

- Reports from the assistant leave a studio for the operator. They are limited
  by instruction to the system and not the content, capped at 1,200 characters,
  and carry only the studio's and website's names and the model. An operator
  who is not the studio's owner can therefore see those names. If Atelier is
  opened to studios who should not be visible to the operator even by name,
  drop them from `context`.
- "Every so often" is event-driven (the assistant reports when something
  happens), not a scheduled survey. A scheduled digest e-mail is not built; the
  operator's notifications and the one-document download cover it.
- Reports are not deleted by age.

## To confirm

1. Whether the person who reported should be told when it is dealt with.
2. Whether a weekly digest by e-mail is wanted.
