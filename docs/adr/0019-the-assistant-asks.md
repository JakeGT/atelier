# ADR-0019: The assistant asks, and the person chooses how much

- **Status:** Accepted and built (branch `assistant-questions`, 2026-10-11). Asked for by the owner: "Can we implement a human-in-the-loop question architecture for the AI assistant as well? Maybe offer the user a slider from completely autonomous to make no assumptions."
- **Relates to:** ADR-0015 (the assistant checks and sees its work).

## Decision

### Asking ends the request; the answer carries it on

- The assistant has a tool, **`ask_person`**: up to six questions in one call,
  each with a few words on why, and two to four answers to choose from when it
  can think of them (its own suggestion first).
- The tool stores the questions (`agent_questions`, migration 0020, one open
  set per website) and tells the assistant to stop. The request ends normally.
  Nothing waits: no run is held open, no time or tokens are spent while the
  person thinks, and it does not matter if they answer in a minute or a week.
- The conversation shows a **question card**: each question with its choices and
  room for the person's own answer. "Send my answers" (anything left blank is
  the assistant's to decide) or "Decide all of this for me".
- Answering sends a message that **continues the same request**
  (`--continue`), so the assistant still knows what it was doing. Writing
  something else in the message box instead does the same and sets the
  questions aside.
- If the person has walked away, they are notified in the app and by e-mail
  that the assistant is waiting.

Blocking the tool call until an answer arrived was considered and rejected: a
run has a time limit, a proxy between the parts would cut a long wait, and an
unanswered question would hold a workspace busy.

### How much it asks is a setting of the website

`projects.ask_level`, four stops, set with a slider under the message box
(`PUT …/asking`, anyone who can make requests):

| | Name | What the assistant is told |
| --- | --- | --- |
| 0 | Decides everything itself | Never ask; pick the likeliest meaning; placeholders for missing facts; say what was assumed. |
| 1 | Asks only when it matters (default) | Decide ordinary things; ask when a request is ambiguous, a wrong guess is costly, or something is hard to put back. |
| 2 | Checks before big choices | Before anything substantial, ask what shapes it (audience, pages, tone, look); decide small details. |
| 3 | Assumes nothing | Ask about everything not stated; never invent a fact; state the plan before starting. |

Each stop is a paragraph of the assistant's rules (`services/asking.ts`). At 0
the endpoint also refuses to show questions, whatever the model does.

## Consequences

- The levels are instructions to a language model: they shift how often it asks,
  they do not guarantee it. Level 0 is the only one enforced in code.
- One set of questions is open at a time; asking again replaces it.
- A workspace still running an older runtime has no `ask_person` tool until it
  is next recreated (it is, before its next request).

## To confirm

1. Whether the level should be per person rather than per website.
2. Whether a studio should set a default for its new websites.
