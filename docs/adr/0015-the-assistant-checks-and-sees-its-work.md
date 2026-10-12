# ADR-0015: The assistant checks and sees its own work

- **Status:** Accepted and built (branch `assistant-sight`, 2026-10-10). The owner asked for both on 2026-10-10: "The agent doesn't seem to always tag everything as editable", and "make it so the assistant takes screenshots of the page so that it can see the rendered page and make changes/fixes".
- **Relates to:** ADR-0003 and ADR-0012 (the workspace sandbox), ADR-0014 (content bound to the page).

## Context

Two things the assistant got wrong could not be seen by it.

1. **It did not always connect every piece of text to content.** ADR-0014 made
   content the source of a page's wording, bound with `data-content…`
   attributes. The assistant is told to bind what a person will want to change;
   in practice it missed things (navigation labels, footers, a paragraph here
   and there). ADR-0014 listed this as something to confirm, with "a check
   after each run" as the fallback.
2. **It could not see the page.** It wrote HTML and CSS and reasoned about what
   they would look like. It said pages worked on a phone without having looked.

## Decision

### 1. A check of what a visitor can read but nobody can edit

`services/coverage.ts` reads a page and returns the text (block by block) and
the pictures that sit outside every bound element. Scripts, styles, code and
drawings are not wording. An element can opt out with `data-content-skip` when
it is truly not wording to edit.

The same check is used in two places:

- **By the assistant, before it finishes.** A tool, `content_check`, reads the
  workspace's pages as they are at that moment and reports, per page, what is
  not editable and what is marked for a field with nothing saved; and overall,
  what is saved but on no page and what is saved without a described field. The
  house rules say to call it after any request that added or changed pages or
  wording, fix what it reports, and repeat until it says `ok`.
- **By the person, on the Content page.** `GET …/content/map` now carries, for
  each page, how many pieces are not editable and the first few. The Content
  page says so ("3 pieces of text on your website cannot be edited here yet",
  with examples) and offers **Ask my assistant to make them editable**, which
  puts the request in the editor's message box.

Nothing runs the assistant again by itself: a second pass costs the studio's
own tokens, so it is offered, not taken.

### 2. A browser in the workspace, and a tool to look with

The runtime image carries Chromium. A tool, `page_look`, opens a page of the
website at phone, tablet or desktop width and returns:

- **pictures** of it (JPEG, the visitor's width; a long page in up to three
  parts of 1,400 px, with `from` to look further down);
- **what is wrong that a picture may not make obvious**, measured in the page:
  content wider than the screen and which element causes it, pictures that did
  not load, script errors, text smaller than 11 px, text blocks that overlap,
  text that is cut off, text touching the edge of the screen;
- **an outline in words**: the main elements with their position, size and
  text size.

The page is served by a small web server inside the tool's own process, on the
workspace's loopback only, the way the preview serves it: saved wording filled
in and library pictures included (`mcp/site.ts`). The browser is driven over
the DevTools protocol with Node's built-in WebSocket; there is no browser
automation library (`mcp/look.ts`).

**Models that cannot read pictures.** Whether the chosen model accepts images
comes from the model catalog and is passed to the tool. A model that cannot is
given the problems and the outline and no pictures. The built-in model (no key)
cannot read pictures; the model picker says which models can ("can look at your
pages"). The house rules tell the assistant to say, in that case, that it
checked the layout by measurement rather than by eye.

**Limits.** Sixteen looks per request. The browser closes after ninety seconds
without use.

## Security

- Chromium runs with `--no-sandbox`. Its own sandbox needs privileges the
  workspace container deliberately does not grant (no capabilities, no new
  privileges). The container is the sandbox: read-only root, a memory and
  process limit, no route to the internet except the allow-listing proxy, which
  the browser is told not to use (`--no-proxy-server`), so a page cannot fetch
  anything from outside.
- The page the browser runs is the website's own, written by the assistant: the
  same code that the assistant can already run in the same container. Looking
  adds no new reach.
- The tool reads library files through a new read-only route with the run's own
  token (`GET /api/agent/media/file/:name`), limited to that website.
- The page path is confined to the workspace; anything else is refused.
- What the person is shown about a look is which page and at what size, nothing
  the page contains.

## Consequences

- The runtime image grows by roughly 700 MB of files (Chromium and what it
  needs). Every workspace shares the same layers.
- A look takes about one to two seconds for the first and under a second after.
  The browser uses memory inside the workspace's limit; the limit is raised from
  1,536 MB to 2,048 MB.
- Requests take longer and use more tokens when the assistant looks and fixes.
  That is the point; the cap bounds it.
- gVisor (P6) will need Chromium re-tested under it.

## Tested

- Unit tests: the coverage check; the browser against a deliberately broken
  page (wider than the screen, a missing picture, a script error, tiny text, no
  margin), skipped where there is no Chromium.
- End to end: the browser inside a real workspace container under its real
  confinement.
- The real assistant, once, building a two-page website with these rules: it
  called `content_check` three times and `page_look` four times (both pages, phone
  and desktop) and finished with nothing uneditable.
- Three models that accept images each read a number that existed only as pixels
  on a canvas, through this tool. The built-in model reported that it cannot
  read images, which is what led to the measured description.

## Not done

- The assistant cannot click, scroll a menu open or fill in a form: it sees the
  page as it loads.
- No comparison of before and after.
- The pictures are not shown to the person.

## Update, 2026-10-10 (evening): bars that showed nothing

On a real website the assistant said twice that it had fixed empty chart bars
and had not. Two causes, neither visible to it:

1. **Its own CSS:** the bar's fill was a `<span>` with a width and a height,
   which browsers ignore on an inline element. `page_look` now reports anything
   that has a colour and takes up no space, and says why ("it is an inline
   element, so its width and height are ignored; give it display:block").
2. **Ours:** every entry of a bound list is a copy of the first entry's markup,
   so four bars written with four widths all came out at the first one's. There
   was no way to give an entry its own length. There is now: a number part with
   `data-item-percent` on the bar (`data-content-percent` outside a list) sets
   its width from 0 to 100. `content_check` reports a list whose entries are
   written differently in the page (`entriesWillAllLookTheSame`), and the house
   rules say that anything that differs between entries must be a value of its own.

Tried on a copy of that website with the real assistant and the same complaint:
it made the fill a block, gave each bar its own number, and the four bars
measured 98%, 41%, 95% and 3% of their track.
