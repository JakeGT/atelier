# 04 — States and consequences

Part of the [interface design reference](README.md).

## The rule

Nothing happens that the person did not expect, and nothing sits on the screen
without saying why it is the way it is.

## Risky actions

An action is risky if it removes something, cannot be undone, or changes what
the public sees.

**Say what will happen before it happens.** The confirmation states, in order:
what stops or disappears, what is kept, and how to undo it if it can be undone.

> **Take Okoro Ceramics offline?** Its address and domains will stop working
> straight away. Your pages, versions and releases stay here, and Publish
> brings it back at the same address.

**Match the confirmation to the damage.**

| The action | Ask |
| --- | --- |
| Easily undone (save wording, go back to a version, which is itself a new version) | Nothing; just do it and say it was done |
| Changes what the public sees (publish, unpublish, put a release back) | One confirmation that states the effect; a recent sign-in |
| Destroys work for good (delete a website) | Type the website's name |

**Name both buttons by their outcome:** "Keep it live" / "Take offline", not
"Cancel" / "OK".

**Keep dangerous actions apart from safe ones.** After a divider, last in the
menu, in the warning colour, and with an icon *and* words, never colour alone.
Never the same style as the harmless button next to it.

**A dangerous action explains itself where it sits.** Next to Archive: what
archiving does, what it does not do, and where deleting is.

## Controls that cannot be used

- Do not leave a greyed-out button with the reason in a tooltip. Either remove the control and **say why in its place** ("You're the only owner, so you can't leave. Make someone else an owner first."), or keep it enabled and explain when pressed.
- A button disabled only because nothing has changed yet (Save) is fine: its state is self-explanatory.
- If a person lacks permission, say who can do it ("An owner or admin of this studio can add one.").
- A model whose provider is not connected is shown, dimmed, with **Add key**: the way forward is part of the item.

## Empty states

An empty list says what will appear there and how to make it appear.

> **Not published yet.** When you press Publish, it is recorded here.

Never a blank area, never just "No data".

## Waiting

- Anything that takes longer than a moment shows that it is working, in words ("Opening the workspace…", "Working · 0:42").
- A long job continues if the person leaves and is still there when they come back.

## After an action

- Say what happened, in the place it happened or in a short message: "Okoro Ceramics is offline. Publish to bring it back."
- An outcome the person needs to act on (a new public address) gets a proper dialog with the thing itself: the link, Copy, Open.

## Errors

An error message answers three questions:

1. **What happened?** In plain words.
2. **Did anything change?** ("The version that was live is still live.")
3. **What now?** ("Try again in a moment", "Ask your assistant to replace it with a real file.")

Never show a code, a stack trace or a raw message from another service. Errors
stay on screen longer than successes.

## Signing in again

Some actions ask for a fresh sign-in. Say why before sending the person away,
and finish what they asked for automatically when they come back.
