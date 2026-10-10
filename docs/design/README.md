# Atelier interface design — the reference

Read this before building or changing anything a person sees. It is the whole
of Atelier's interface design in one place; each section ends with a link to
the document that goes into detail.

**Who the interface is for:** someone who is not technical, has never seen
Atelier before, and will not hover over things to find out what they do.

**The test for every screen:** *would this person find it, and understand it,
with nobody to ask?* If the answer needs an explanation from us, the design is
wrong, and the fix is to the design, not to the explanation.

> "Icons are not a replacement for intuitive design. If I don't know where
> something is, it's bad design." — Jake, 2026-10-10

| Document | What it covers |
| --- | --- |
| [01 — Words on every control](01-words-on-controls.md) | Labels, icons, tooltips, the few allowed exceptions |
| [02 — Finding things](02-finding-things.md) | Where actions go, showing state, more than one way in, small screens |
| [03 — Plain language](03-plain-language.md) | Wording rules and the glossary of what we call things |
| [04 — States and consequences](04-states-and-consequences.md) | Risky actions, confirmations, disabled controls, empty states, errors |
| [05 — Visual language](05-visual-language.md) | Colour, type, spacing, components |
| [06 — Review checklist](06-review-checklist.md) | What to check before any interface change ships, and how to audit |
| [Audit, 2026-10-10](audit-2026-10-10.md) | What the first full audit found and what was done |

---

## 1. Every control says what it does

- A button has **words**. An icon may sit beside the words; it never replaces them.
- A **tooltip is not a label.** You only hover over something you already suspect is the right thing.
- An icon alone is allowed only when its meaning is universal *and* the place makes it obvious (the ✕ that clears a search box), or when it repeats a control that is labelled elsewhere on the same screen.
- Name a control by **what happens**, in the person's words: "Unpublish", "Go back to this", "Take offline". Not by the mechanism ("Rollback", "Deploy").

→ [01 — Words on every control](01-words-on-controls.md)

## 2. Things are where you would look for them

- **Put an action on the thing it acts on.** Unpublish lives on the "Live" status, because that is what it changes.
- **Show state in words wherever the object appears:** "Live", "Not published", "Connected", "Waiting for DNS".
- **Important actions have more than one way in.** If two sensible people would look in two places, put it in both.
- **Nothing important is only inside a dialog** that is itself behind an unrelated button.
- **On a small screen, move actions into a worded menu.** Never drop the words to save space.

→ [02 — Finding things](02-finding-things.md)

## 3. Plain language

- No internal codes, ever: no commit hashes, ids, revision numbers, state names from the database, or slugs where a name will do.
- Use the person's word, not ours: "wording", not "content documents"; "put this one back", not "roll back".
- One name per thing, everywhere. The glossary is the list.
- If a term has to be technical (API key, token, CNAME), say what it is in the same place, in one sentence.

→ [03 — Plain language](03-plain-language.md)

## 4. No surprises

- An action that removes something, or changes what the public sees, says what will happen **before** it happens, and asks.
- A dangerous action sits **apart** from safe ones: after a divider, last in its group, in the warning colour, and never styled like its neighbour.
- A control that cannot be used **says why, in place.** No greyed-out buttons with the reason in a tooltip.
- An empty screen says what will appear there and how to make it appear.
- An error says what happened, whether anything changed, and what to do next.

→ [04 — States and consequences](04-states-and-consequences.md)

## 5. It looks like a studio

Warm paper, ink, and one vermilion accent. A serif for display, a sans for the
interface, a mono for small facts. Colour means something: green is live, amber
is not-yet-public, vermilion is the primary action or a warning. Clarity wins
over style whenever the two disagree.

→ [05 — Visual language](05-visual-language.md)

## 6. Check before it ships

Take real screenshots (light, dark, phone). Read every control out loud: does
each one say what it does? Find the three most important actions on the screen
without using the mouse to hover. Then run the checklist.

→ [06 — Review checklist](06-review-checklist.md)

---

## Where this applies in the code

| What | Where |
| --- | --- |
| Design tokens (colour, type, spacing) | `apps/web/src/styles/tokens.css` |
| Shared pieces (dialog, menus, toasts, account menu) | `apps/web/src/ui/kit.tsx` |
| The model picker (searchable list pattern) | `apps/web/src/ui/ModelPicker.tsx` |
| The editor bar and the Live status menu | `apps/web/src/pages/Editor.tsx` |
| Website cards and their More menu | `apps/web/src/pages/Studio.tsx` |

## Sources

The rules above follow established usability research as well as our own
mistakes. Further reading:

- Nielsen Norman Group, [Tips for Icon Usability](https://www.nngroup.com/videos/icon-usability/): most icons have no agreed meaning and need a label.
- Jakob Nielsen's sixth heuristic, [recognition rather than recall](https://uxdesign.cc/jakob-nielsens-sixth-usability-heuristic-for-user-interface-design-ac88e7d58ec): make actions and options visible.
- Nielsen Norman Group, [Proximity of consequential options](https://www.nngroup.com/articles/proximity-consequential-options/): keep dangerous actions away from harmless ones.
- Automattic design system, [Destructive actions](https://system.automattic.design/foundations/destructive-actions/): confirm what cannot be undone; do not rely on colour alone.
- Christopher Butler, [In Defense of Text Labels](https://chrbutler.com/in-defense-of-text-labels).
