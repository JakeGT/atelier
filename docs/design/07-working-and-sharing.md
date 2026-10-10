# 07 — While the assistant works, and when people share a website

Part of the [interface design reference](README.md).

## The rule

A wait is never opaque, and nobody is surprised by someone else. The person
always knows what the assistant is doing, how to stop it, and who else is in
the room.

## While the assistant works

A request takes from seconds to several minutes. "Working…" beside a timer is
not enough after about ten seconds: people cannot tell working from stuck.

**Say what it has just done, in plain words.** The assistant's engine reports
each step as it finishes (which tool, which file). `lib/activity.ts` turns that
into words: "Read the home page", "Wrote the styles", "Saved your wording". No
tool names, file paths or commands reach the screen.

**Be honest about what we know.** We learn of a step when it *finishes*. So the
card says "Working on the next step" and "Just finished: wrote the home page".
It does not claim to know what is being written right now, how far along it
is, or how long is left. No percentage, no estimate.

**One calm line, detail on demand.** The current state and the last step are
always visible. The full list of steps is one click away, and stays on the
reply afterwards as "What I did".

**Show the result taking shape.** The preview reloads whenever the assistant
writes a page, so the website appears piece by piece during the run.

**Say when it is slow.** If no step has finished for over a minute: "Still
working. This step is taking longer than usual." Not a frozen label.

**Always a way out.** A **Stop** button, with a line saying what stopping does
("Stopping keeps what it has done so far"). Stopped work is saved as a version
and can be carried on.

**Never run on unnoticed, never lose work.** A request is paused after 15
minutes. From three minutes before, the card says so and offers **Give it 10
more minutes** (up to an hour in all). A paused or stopped request leaves a
note, not an error, with **Carry on from here**.

**Let people keep going.** The message box stays usable while the assistant
works, and says "You can write your next request now and send it when this one
finishes."

## When several people have the same website open

A website has one conversation and one assistant. People share them.

**Show who is here.** "Sol is here too. You share this conversation and this
assistant." Only shown when someone else is.

**Show who is about to ask.** "Sol is typing a request. Only one request can be
worked on at a time." This is a warning, not a lock: it stops two people asking
for conflicting things at the same moment.

**One request at a time, and say whose.** While a request is being worked on,
everyone sees the same live card, labelled "Maren's request" for everyone but
Maren, and their message box says "Your assistant is working on Maren's
request…". Anyone who may edit can stop it.

**Everything stays in step without reloading.** A new request, a reply, a saved
version, saved wording, a publish, an unpublish: each shows up in every open
editor within a couple of seconds.

**Say who asked.** In a shared conversation, a request from someone else
carries their name.

**Never silently overwrite someone's work.** If two people edit the same
wording, the second save is refused: "Maren changed this while you were
editing." Their typing is kept on screen, with a way to see the other version.
The same applies when the assistant changes wording a person is editing.

## Words

| We say | Not |
| --- | --- |
| Working on the next step | Thinking, processing, generating |
| Just finished: wrote the home page | `write index.html` |
| Paused | Timed out, killed |
| Carry on from here | Resume, retry |
| Give it 10 more minutes | Extend timeout |
| Sol is here too | 2 users online |
