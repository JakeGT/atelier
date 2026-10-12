# ADR-0018: Movement, with GSAP

- **Status:** Accepted and built (branch `motion-gsap`, 2026-10-11). The owner asked "Is there a framework for animations available?", was offered a layer of the kit's own or a library, and chose: "Lets go with GSAP."
- **Relates to:** ADR-0016 (the design kit), ADR-0017 (interactive sections without a framework).

## Decision

- **GSAP is a dependency of the server** (`gsap`, pinned by the lockfile). Its
  published files `dist/gsap.min.js` and `dist/ScrollTrigger.min.js` are read
  from the package and written into a website that asks for movement. Nothing
  is loaded from another address, as with everything else in a website.
- **`assets/motion.js` is the kit's layer over GSAP**, switched on by attributes
  on ordinary HTML: `data-k-reveal`, `data-k-stagger`, `data-k-count`,
  `data-k-parallax`, `data-k-delay`, and `data-k-motion="auto"` on `<html>` for
  the kit's own sections. The assistant uses these for ordinary movement and
  writes GSAP of its own, in a file of the website's, for a scene they cannot do.
- **Movement is part of the look.** Each look has `--motion-duration`,
  `--motion-ease` and `--motion-distance` in `theme.css`; `motion.js` reads
  them. Changing the look changes the movement. A website whose `theme.css`
  predates this uses the defaults until its look is next set.
- **Movement is opt-in.** The three files are written by the assistant's
  `design_motion` tool, not with every kit. A website nobody asked to move
  carries none of it.
- **A page never depends on it.** Nothing is hidden by a stylesheet; `gsap.from`
  starts from the hidden state and ends at the page as written, then clears what
  it set. Without script, or for a visitor whose device asks for reduced motion,
  the page is simply there. Words are never written by script (a number that
  counts up is put back exactly as written when it finishes).
- **The assistant's page check looks with movement off** (`prefers-reduced-motion:
  reduce` is emulated in `mcp/look.ts`), so it sees each page as it ends up. A
  script of its own that hides something without a reduced-motion check shows up
  there as something that cannot be seen.
- **People ask for movement in words.** Design → Movement lists requests that go
  to the assistant ("Gentle movement throughout", "Numbers that count up", …).
  There are deliberately no controls that set animations directly; see below.

## The licence

GSAP is not open source. It is free under Webflow's "standard no-charge
licence" (https://gsap.com/standard-license), read on 2026-10-11:

- Use on any website, commercial or not, is permitted, including by companies
  that compete with Webflow in other areas.
- **Prohibited:** using GSAP "in tools that allow users to build visual
  animations without code", and anything that helps create a product competing
  with Webflow's visual animation building. Their FAQ says AI-generated code is
  not a prohibited use.

Atelier is a website builder, so this matters. What is built stays on the
permitted side as the owner's agent reads it: the assistant writes animation
code; Atelier has no interface for building or editing animations. **Do not add
one on top of GSAP** (a timeline editor, sliders for an element's animation,
"choose an effect for this section") without written consent from Webflow or
replacing GSAP with something permissively licensed (Motion is MIT;
`motion.js` is the only file that would change for the attribute layer). This
reading is not legal advice; if Atelier is offered to other people commercially,
the owner should confirm it.

## Consequences

- A website with movement publishes about 120 KB more script (40 KB compressed).
- GSAP updates arrive by updating the dependency; a website gets the new files
  the next time `design_motion` runs there.
- The miniatures in the galleries do not show movement.
