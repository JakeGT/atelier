# 06 — Review checklist

Part of the [interface design reference](README.md). Run this before any change
to the interface ships, and as a full audit of every screen when a phase ends.

## How to review

1. **Look at the real thing.** Run the app and take screenshots: light theme, dark theme, and phone width. Reading the code is not a review.
2. **Read every control aloud.** Each should say what it does without help.
3. **Do the tasks cold.** Pretend you have never seen the screen. Find the three most important actions without hovering over anything.
4. **Read every word as a stranger.** Circle anything you would have to explain.
5. **Fix the design, then re-capture.** Do not write an explanation of where something is; move it to where people look.

## Checklist

**Words on controls** ([01](01-words-on-controls.md))

- [ ] Every button and menu item has words.
- [ ] No meaning lives only in a tooltip.
- [ ] Any icon-only control is on the allowed list, with its reason.
- [ ] Labels name the outcome in the person's words.

**Finding things** ([02](02-finding-things.md))

- [ ] Each action is on, or next to, the thing it acts on.
- [ ] State is shown in words wherever the object appears.
- [ ] Important actions can be reached from every place a sensible person would look.
- [ ] Nothing important is only inside a dialog behind an unrelated button.
- [ ] Each panel, tab and settings page says what it is.
- [ ] On a phone, nothing was made icon-only to fit; the rest is in a worded menu.

**Plain language** ([03](03-plain-language.md))

- [ ] No hashes, ids, revision numbers, database state names, slugs-as-names, paths or JSON.
- [ ] Every term is in the glossary and used the same way as everywhere else.
- [ ] Each unavoidable technical term is explained in place, with what to do.

**States and consequences** ([04](04-states-and-consequences.md))

- [ ] Risky actions say what will happen and ask, with outcome-named buttons.
- [ ] Dangerous actions are separated from safe ones and do not rely on colour alone.
- [ ] No greyed-out control without a visible reason.
- [ ] Empty states say what will appear and how.
- [ ] Waiting is shown in words.
- [ ] Errors say what happened, whether anything changed, and what to do.

**Working and sharing** ([07](07-working-and-sharing.md))

- [ ] Any wait over ten seconds says what is happening, in words, and can be stopped.
- [ ] Nothing claims progress or time remaining that we do not actually know.
- [ ] Interrupted work is kept and can be carried on.
- [ ] With two people on the same screen: each sees the other's changes without reloading, and neither can silently overwrite the other.

**Look** ([05](05-visual-language.md))

- [ ] Tokens only; both themes checked.
- [ ] One primary action per screen.
- [ ] Colour meanings are respected and backed by words.
- [ ] **A control is never inside the thing it changes the size of.** (The preview's size chooser once lived inside the preview frame: choosing Phone shrank the bar and hid the way back.) Tools that do not fit take a second row; they are never clipped and never lose their words.

## Recording an audit

Write findings and fixes as `audit-YYYY-MM-DD.md` in this folder: the screen,
what was wrong, which rule it broke, and what was done. Link it from the
[reference](README.md). If an audit teaches a new rule, add it to the document
it belongs in and to the reference.
