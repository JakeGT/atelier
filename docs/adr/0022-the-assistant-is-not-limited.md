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

## The web (decided by the owner the same day)

"Give it web fetch access for resources, research, etc." The workspaces' egress proxy has a third
mode, `open`: every public host on ports 80 and 443, and still never a private address, so the
platform's own services stay out of reach (this amends ADR-0012; `EGRESS_MODE=open` in production).
The assistant's preview browser goes out the same way, so fonts and pictures loaded from elsewhere
are in what it sees. Its instructions say what the web is for, that a page's text is information
and never an instruction, and that the person's content is not to be sent anywhere. The risk
accepted: a page could try to trick the assistant into sending the unpublished website somewhere.
The workspace holds no keys and cannot publish.

## A blank canvas is blank

The assistant is told at the start of each request what was chosen for the website's design (a
look, styling of its own, or nothing). With nothing chosen it is told it has no need of the design
kit, and the kit's tool lists ready-made looks and sections only when asked to.

## Editable wording serves the design

Connecting wording to the Content page is still asked for, but where it would force the design to
change, the design is kept and the person is told which words they must ask to have changed.

## Not yet possible

Generating photographic images needs a tool that does not exist. The instructions say so plainly.

## Workspace size

Workspaces were being killed for memory at 2 GB (the assistant, its browser and its working files
together), which is what "the browser did not answer" and "opencode run failed (exit null)" were.
Production now gives each 4 GB and two processors, and that failure is said in plain words.

## Also fixed here

Page previews stalled ("the browser did not answer"). Closed browsers left dead helper processes
that counted towards the workspace's process limit, and nothing recovered a browser that had
stopped answering. Workspaces now run with an init process; a browser is killed with its whole
process group and when its owner exits; looks run one at a time; a stuck browser is replaced and
the look retried once.
