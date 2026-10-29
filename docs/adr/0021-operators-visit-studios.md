# ADR-0021: Operators can go into a studio, for a limited time, in the open

- **Status:** Accepted and built (branch `operator-access`, 2026-10-11). The owner asked "Is there a way for an Admin to access other studios?", was told no and offered this, and said: "Yes, build it for operators only."

## Context

Whoever runs an Atelier (an operator: someone in the identity provider's admin
group) could see every studio's figures and pause one, but could not see inside
one. That is right as a default and wrong when someone needs help: the operator
could only ask to be invited.

## Decision

- **A visit, not a membership.** In the Operator console, a studio's dialog has
  "Go into this studio". It needs a recent sign-in (step-up) and a **reason**,
  and starts a visit of **60 minutes** (`operator_visits`, migration 0023; not
  tenant-scoped, read only by operator code).
- **What a visit gives:** the studio's **admin** role, through the one place
  roles are resolved (`studiosFor` in `middleware/auth.ts`, used by `loadOrg`
  and the list of a person's studios). Not the owner's: a visitor cannot delete
  or export the studio. Only someone who is an operator now benefits from a
  visit; a row left behind for someone who no longer is does nothing.
- **In the open.** Starting a visit writes `operator.enter` (with the reason and
  the end time) to the studio's own activity and notifies its owners and admins
  in the app and by e-mail, with the operator's name and reason. Everything done
  during it is in the studio's activity under the operator's name, like anyone
  else's actions. Leaving writes `operator.leave`. The operator is not added to
  the studio's members; while they have a website open, the people in it see
  them as present.
- **While inside,** a strip across the top of every page says whose studio it
  is, that this is an operator's visit, when it ends, and has "Leave this
  studio". A visited studio is never remembered as "the studio I was last in".
- **It ends** when the operator leaves or the time runs out, whichever is
  first. A paused studio cannot be entered.

## Consequences

- An operator can read and change everything an admin can, including wording,
  media, conversations and messages from visitors, and can connect or remove a
  provider key (keys are never shown to anyone). That is a real power, bounded
  by time, a required reason, the notification and the record, not by the
  software refusing. If Atelier is run for studios who must be able to refuse,
  add a setting for a studio to require its own approval first.
- Studio admins are unchanged: their role stops at their own studio.

## To confirm

1. Whether a visit should be read-only by default, with changes a second step.
2. Whether a studio should be able to switch visits off, or approve each one.
