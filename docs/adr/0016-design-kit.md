# ADR-0016: The design kit: looks and layouts

- **Status:** Accepted and built (branch `design-kit`, 2026-10-10). Asked for by the owner: "Can we build some templates for design language, styling, layouts etc?"
- **Relates to:** ADR-0014 (content bound to the page), ADR-0015 (the assistant checks and sees its work).

## Context

Every website's design was whatever the assistant invented that day. Results
varied in quality, could not be compared before building, and could only be
changed by asking the assistant to restyle everything, which is slow, costs
tokens and often changes things nobody asked to change.

## Decision

A website can carry a **design kit** of two ordinary files:

- **`theme.css`: the look.** A look is a complete design language (colours,
  lettering, corners, borders, shadows, rhythm) expressed as about twenty CSS
  variables. Its first line names the look.
- **`kit.css`: the sections' styles.** The same for every website. It styles
  plain elements and a small set of classes (`k-…`) using only those variables.

Pages take every colour, font and corner from the variables. So:

- **Changing the look is replacing one file.** `PUT …/look` writes `theme.css`
  as a new version (`Workspace.write`, daemon `/write`). No page changes, no
  word changes, no assistant, and it can be undone from History.
- **A look can be tried before it is chosen.** The preview route serves the
  website with another look's `theme.css` substituted, so the Design panel
  shows the person's own website in every look.

### Looks (`design/looks.ts`)

Eight to start: Editorial, Studio, Bold, Soft, Mono, Botanical, Midnight,
Classic. Each has a description for the person and guidance for the assistant
on how to design in it. Fonts are system font stacks: nothing is loaded from
anywhere (the house rule), so a look costs a visitor nothing.

### Layouts (`design/layouts.ts`)

Fourteen ready-made sections: name and menu, two openings, three things side by
side, words beside a picture, numbers, bars, a quotation, a picture grid,
prices, questions, a call to action, where and when, the foot of the page. Each
is plain HTML with the kit's classes, and each already marks its wording as
editable (ADR-0014), so a section placed by the assistant is editable from the
start. A test checks that no section has uneditable text or its own colours.

### Where it shows

- **Starting a website:** "Start simply, in a look" in the starting-point
  gallery. The website begins with the kit, a first page (name, opening, foot)
  and its wording saved with labels.
- **In the editor:** a **Design** button. **Looks** shows the website in each
  look with "Use this look"; **Sections** shows each section in the website's
  look with "Ask my assistant to add this", which writes the request in the
  message box.
- **A website built without the kit** cannot be switched in one step. The panel
  says so and offers "Ask my assistant to restyle it" in a chosen look.

### The assistant

Three tools: `design_kit` (the look it is working in and how to design in it,
the other looks, the sections), `design_section` (a section's HTML) and
`design_use_look` (writes the two files). The house rules: call `design_kit`
first; take every colour, font and corner from the variables; never edit the two
files by hand; build from sections where one fits.

## Consequences

- Websites made from now on are more alike in structure. That is the trade: a
  dependable standard and instant restyling, against unlimited variety. The
  assistant may still write its own sections and its own third stylesheet.
- The four built-in templates and websites made before this do not have the kit.
- `kit.css` is copied into each website, so improving it does not reach existing
  websites until their look is next changed (which rewrites both files).

## Tested

- Unit tests: every look defines the same variables and loads nothing; `kit.css`
  uses only variables the looks define; every section is fully editable as
  written; starting in a look; switching (only `theme.css` differs, a version is
  made); a website without the kit; the previews.
- End to end on real containers: start in a look, change it, the real workspace
  has the new file and the same page.
- Every look rendered with every section at desktop and phone width: nothing
  scrolls sideways.
- The real assistant, once, on a website started in the Botanical look: it
  called `design_kit`, fetched seven sections, built the page from them, wrote no
  colour or font outside the look, left nothing uneditable, and looked at the
  page on desktop and phone. The same page was then shown in Midnight without a
  change to it.

## Not done

- A studio's own looks (its brand colours and type as a look).
- Editing a single value of a look (just the accent colour).
- Moving the built-in templates onto the kit.
- More than one look per website (a dark variant).

## Added 2026-10-11: pictures in the galleries

The galleries showed every design as a live miniature page. A dozen pages at
once made "See all designs" slow, and the closer look was a small dialog in
which a desktop page fell into its phone layout. Now Atelier's own designs are
pictured ahead of time (`pnpm thumbs`, committed, fingerprinted against the
pages they show, checked by a test), the galleries show the pictures, and the
live page is loaded only for a closer look, in a large dialog that lays the page
out 1280 wide and scales it to fit. Prefetching every live page was considered
and rejected: it makes the first paint slower for something most people never
open.
