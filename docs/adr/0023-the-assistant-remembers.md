# ADR-0023: The assistant remembers the conversation

- **Status:** Accepted. Asked for by the owner on 2026-10-12 and built the same day (`assistant-memory`).

## Context

Each request started the assistant as a new session: it was given its instructions, its tools and
the one message, and nothing of what had been said before. Only "Carry on" and answering its
questions continued a session. Nobody had decided this; it was how the first version was built.
It meant "make that bigger" had nothing to refer to, preferences had to be repeated, and the
assistant could not know why the website was as it was. It also could not know that something it
had built earlier was shaped by a fault in Atelier that had since been put right.

## Decision

1. **A website has a conversation, and every request belongs to it.** The engine continues its
   last session when that session is this conversation (`--continue`); the engine summarises a
   session that grows long.
2. **Where the engine does not have the conversation in mind, it is given it in writing.** The
   engine's memory lives in the workspace's temporary storage and is lost whenever the workspace
   is stopped or rebuilt, which is often. Atelier keeps the messages, so the most recent part of
   them (what the person asked, what was answered) is written out at the top of the request. A
   marker beside the engine's session records which conversation that session was, so the two are
   lost together and the choice between "continue" and "afresh, with the conversation written
   out" is made in the workspace, where the truth is.
3. **The person can start a new conversation.** `projects.conversation_at` records when. Messages
   before it stay in the chat for the person to read and are not given to the assistant. A line
   in the chat shows where the new one began. The action says what it does and that it cannot be
   undone, and is refused while the assistant is working.
4. **The assistant is told what has changed in Atelier, once.** `services/changes.ts` is a short,
   dated list of changes that affect what the assistant can do or how its work turns out, written
   by hand with each such change and only ever added to. `projects.changes_seen` counts how many a
   website's assistant has been told. At the start of a request the rest are given, as
   information and not as a request, with the note that earlier work may have been shaped by how
   things were. A website nobody has asked anything of yet has nothing to catch up on.

## Existing websites

The database change adds two columns, one empty and one zero, and touches no row. An existing
website's stored messages become its conversation the first time it is asked something, and it is
told every entry in the list once. A workspace still on an earlier runtime ignores the new fields
and behaves as before until it is rebuilt, which happens at the start of its next request.

## Consequences

- A request costs more: earlier turns are carried with it. That is the price of a builder you
  talk to; "Start a new conversation" is the way to shed it.
- The written conversation carries what was said, not the steps taken; the website's files are
  the record of those.
- The list of changes has to be kept by whoever changes Atelier. A change that is not on it is
  simply not announced; nothing breaks.
