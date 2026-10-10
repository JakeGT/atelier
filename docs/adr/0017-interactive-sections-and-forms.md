# ADR-0017: Interactive sections and forms, without a framework

- **Status:** Accepted and built (branch `interactive-forms`, 2026-10-10). Asked for by the owner after "How hard would it be to support React?" and "Is there an alternative to React for interactive elements?": "Build the interactive sections and form handling."
- **Relates to:** ADR-0010 (hosting), ADR-0014 (content bound to the page), ADR-0016 (the design kit).

## Context

A website in Atelier is plain files with no build step. Everything a person
uses to manage one (the Content page, "show me where", the editability check,
the looks) works by reading a page's HTML. A framework that draws the page with
script (React, Vue) makes those words invisible to all of it, and needs a build
that publishing does not have. But websites need things that move (a folding
menu, tabs, a carousel) and things that send (a contact form), and a published
website is static: a form has nowhere to send to.

## Decision

### Interactive sections: HTML first, one small script

- The design kit gains a third file, **`kit.js`**: plain script, no library, no
  build, nothing loaded from elsewhere. Behaviour is switched on by `data-k-…`
  attributes on ordinary HTML.
- **Every interactive section works without it.** All the words are in the page:
  tabs show every panel one after another, a filtered list shows everything,
  a form sends and gets a page in answer. The script only adds the moving parts,
  so the words stay editable on the Content page and readable by search engines.
- Sections added (`design/layouts.ts`, marked `interactive`): questions that
  open and close (`<details>`, no script at all), tabs, pictures to flick
  through, a list that can be narrowed, tick and add up, a contact form, a
  sign-up form. The navigation folds into a "Menu" button on a phone.
- The assistant is told to use these; for anything else, plain HTML and CSS
  first, then a small script of its own. No framework, nothing that needs a
  build, and never a page's words drawn by script.
- `design_section` brings an older website's `kit.css` and `kit.js` up to date
  before handing over a section, so the section is styled and works there.

### Forms: Atelier receives them

- A form in a page is **named and has no action**: `<form data-form="contact">`.
- When a page is served (preview) or published, the form's `action` becomes
  `<this Atelier>/f/<token>` (`services/fill.ts`, option `forms`). The token
  names the studio, the website, the form and whether it is a trial, and is
  signed (`services/forms.ts`, HMAC with a key derived from the secrets key), so
  the endpoint needs no lookup to know where a submission belongs and a link
  cannot be made up for someone else's website. The control plane works the
  links out and hands them to the deployer with the content; the deployer never
  holds the key.
- **`POST /f/<token>`** is public and open to any origin (a website is on its
  own address; nothing is read back and no cookie is used). It takes words
  only (no files), at most 64 KB, 40 boxes of 5,000 characters. A hidden box
  that only a robot fills in is added to every form; a submission that fills it
  is answered as if it had worked and is dropped. Limits, held in memory: 5 a
  minute and 60 a day per sender and website; 30 a minute and 300 a day per
  website whoever sends.
- A submission is kept (`form_submissions`, migration 0019, row-level security
  like every other studio table). The studio's owners and admins are told, in
  the app and by e-mail, with what was written. A submission from the preview is
  kept and marked as a trial, and nobody is notified.
- **Messages from visitors** is a tab on the Content page (and its own address,
  `…/content/messages`): newest first, each box labelled by its `name`, e-mail
  addresses as links, delete with a confirmation, and everything as a
  spreadsheet (cells that a spreadsheet would run as a formula are made plain).
- Kept for 12 months (`RETAIN_FORMS_DAYS`), included in a studio's export,
  deleted with the website.

## Consequences

- No framework support, by choice. A website that needs an application (a
  basket, accounts) is outside what Atelier builds today; a sandboxed build
  remains the way in if that changes.
- Submissions are personal data from people who are not Atelier's users. They
  are readable only inside the studio, kept for a stated time, deletable one by
  one, and exported with the studio. A website with a form should say what it
  does with what is sent; the assistant is told never to ask for passwords or
  card numbers.
- A form's link is in the published page for anyone to read. That is fine: it
  can only add a message to that website, within the limits. If a website is
  being flooded, the limits hold it to 300 a day; a stronger defence (a
  challenge) is not built.
- A website published before this has no forms connected; publishing again
  connects them. Changing the secrets key disconnects every form until each
  website is published again.
- The limits are per server process and reset on restart.

## To confirm

1. Whether notifications should also go to a website's editors, or to an address the studio chooses.
2. Whether the assistant's page check should press things (it sees a page as it loads; it cannot open a tab or send a form).
