# ADR-0022: The assistant is limited only where safety requires it

Date: 2026-10-11. Status: accepted. Changes ADR-0016, ADR-0017 and ADR-0018.

## What happened

ADR-0016 gave websites a "look" (a set of CSS variables) so a look could be changed in one step,
and told the assistant to take every colour and font from the look and never write its own. There
were eight looks and no way to make another, so in practice the assistant could only design in
eight palettes. Its instructions also steered it to ready-made sections, forbade loading anything
from elsewhere, allowed one animation library, capped how often it could look at a page, and told
it to use only uploaded pictures. None of this was put to the owner. An assistant's own report
("the eight looks don't include … I had to pick the nearest") brought it to light.

## The rule

The owner's rule, verbatim: **"if it is not a safety concern, don't limit it"**, and **"the
templates are starting points, not prisons"**. Any future instruction, tool or check that narrows
what the assistant may make needs a safety reason, or the owner's say-so first.

## What changed

- **Design is unrestricted.** Any colours, typefaces, layout, style and movement. The ready-made
  looks and sections are things a person may pick; the assistant is told not to reach for them.
  When a person did pick one (a look or a template), it is where the design starts, and the
  assistant may change or leave any part of it.
- **A look of the website's own** (`design_make_look`, `design/ownLook.ts`): any CSS values, any
  font, variables of its own. The only refusal is a value that would break the stylesheet it is
  written into. Contrast is measured and reported as advice. The look is kept in the website
  (`theme.css`, and `.atelier/own-look.css` to come back to), is shown in Design beside the
  ready-made looks, and switches in one step like them.
- **Fonts** (`design/fonts.ts`): nine open-licence typefaces the website can carry as its own
  files, as a convenience; any other font may be added or loaded from a font service.
- **Using the look's variables is advice**, with its reason (one-step restyling), not a rule.
- Libraries, other animation tools, third-party form services, pictures from elsewhere and
  pictures the assistant draws are all allowed. The cap on page previews is gone.

## What stays, and why

- It cannot publish; it works in one website's files; its workspace reaches the internet only
  through the allow-list; it never holds the studio's keys. (Safety, enforced by the system.)
- It must not build forms that ask visitors for passwords or card numbers. (Safety of visitors.)
- It must not invent picture addresses, and says where outside pictures came from. (Honesty, and
  the person answers for the right to use them.)
- Wording stays connected to the Content page, and it checks its work by looking. These are how
  the product works, not limits on what can be made.
- No build step exists, so whatever it uses must run as plain files. That is a fact, stated as one.

## Not yet possible

Searching for photographs and generating photographic images need tools that do not exist. The
instructions say so plainly rather than forbidding it.

## Also fixed here

Page previews stalled ("the browser did not answer"). Closed browsers left dead helper processes
that counted towards the workspace's process limit, and nothing recovered a browser that had
stopped answering. Workspaces now run with an init process; a browser is killed with its whole
process group and when its owner exits; looks run one at a time; a stuck browser is replaced and
the look retried once.
