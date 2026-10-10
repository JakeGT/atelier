# 01 — Words on every control

Part of the [interface design reference](README.md).

## The rule

Every control a person can press says, in words, what pressing it does.

## Why

Most icons have no agreed meaning. A globe could be language, the internet, a
public setting or an address. A person who does not know what a control does
will not press it, and will not hover over it either, because hovering is
something you do to confirm a guess, not to make one. Atelier's users are not
technical and should never have to guess.

## How

**Buttons**

- Words always. An icon may come first, as a visual anchor: `[globe] Address`.
- Name the outcome in the person's terms: **Publish**, **Unpublish**, **Go back to this**, **Remove**, **Check again**.
- Two or three words is fine. A clear long label beats a short vague one ("Versions and wording", not "History").
- A link that leaves Atelier says so and carries the ↗ arrow *with* words: "Open the live website ↗".

**Menus**

- A menu button has a word: **More**, not three dots alone. Or it is a status that reads as a sentence: "Live · release 3 ▾".
- Every item is words, with an optional icon before.

**Icons**

- Decoration and anchor only. If you delete every icon, the screen must still be fully usable.
- From one set (lucide), one weight.

**Tooltips (`title`)**

- For extra detail on a control that is already labelled. Never the only place a meaning lives.

## Allowed exceptions

Each of these is a decision, not a default. Keep the list short.

| Control | Why it may be icon-only |
| --- | --- |
| ✕ inside a search box | Universal, and its position says what it clears |
| ← back arrow on a phone-width editor bar | Universal; the labelled "All websites" is also in the account menu |
| The avatar circle | Opens the account menu; the convention is strong and the menu is all words |
| The two preview sizes not in use (the one in use is named), and Back/Forward arrows when the preview frame is very narrow | Arrows and device shapes are widely understood, and all are labelled whenever there is room |
| Preview size icons when the preview frame is very narrow | The same three choices are labelled whenever there is room |

Anything else needs words. If there is no room for the words, see
[Finding things § Small screens](02-finding-things.md#small-screens).

## Examples from Atelier

| Before | After |
| --- | --- |
| A globe icon | **Address** |
| A sliders icon | **Settings** |
| A panel icon | **Versions and wording** |
| Three dots on a website card | **⋯ More** |
| A bin icon on a domain row | **Remove** |
| A moon icon | "Switch to night colours" in the account menu; **Night** / **Day** on public pages |
| An arrow in a circle in the composer | **Send ↑** |
