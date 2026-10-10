import { ArrowUp, Clock, Lightbulb, Play, RotateCcw, Square } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clock, stepDone, stepList, summary } from "../lib/activity";
import type { Pulse, Run, ThreadMessage } from "../lib/api";
import { useClickOutside } from "../lib/hooks";
import { IDEAS } from "../lib/ideas";
import { Dots } from "../ui/kit";
import { Prose } from "./Prose";

export type Message = Pick<ThreadMessage, "id" | "role" | "text" | "tools"> & { authorId?: string | null };

const SUGGESTIONS = [
    "Build a home page with a hero, three features and a contact section",
    "Give it a warm, editorial look with a serif headline",
    "Add an About page and link it from the header",
    "Make it work beautifully on a phone",
];

interface ChatProps {
    messages: Message[];
    loading: boolean;
    // The request being worked on, if any, and whose it is.
    run: Run | null;
    runBy: Pulse["runBy"];
    // Other people who have this website open.
    people: Pulse["people"];
    // Names of the people in the conversation, and which of them is you.
    authors: Record<string, string>;
    me: string;
    ready: boolean;
    starting: boolean;
    // Why the conversation cannot be continued here (a viewer, an archived website), if so.
    locked?: string | null;
    onSend: (prompt: string) => void;
    onTyping: (typing: boolean) => void;
    onStop: () => void;
    onMoreTime: () => void;
    onCarryOn: () => void;
    onRetryWorkspace?: () => void;
}

// "Maren", "Maren and Sol", "Maren, Sol and 2 others"
function names(list: string[]): string {
    const first = list.map((n) => n.split(/[\s@]/)[0] || n);
    if (first.length <= 2) return first.join(" and ");
    return `${first.slice(0, 2).join(", ")} and ${first.length - 2} ${first.length - 2 === 1 ? "other" : "others"}`;
}

export function Chat(props: ChatProps) {
    const { messages, loading, run, runBy, people, authors, me, ready, starting, locked, onSend, onTyping, onRetryWorkspace } = props;
    const [input, setInput] = useState("");
    const scroller = useRef<HTMLDivElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const busy = run !== null;
    const steps = run?.steps.length ?? 0;
    const [ideasOpen, setIdeasOpen] = useState(false);
    const ideasRef = useClickOutside(useCallback(() => setIdeasOpen(false), []));

    // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows or the work moves on
    useEffect(() => {
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    }, [messages.length, busy, steps]);

    // Grow the composer with its content, up to a limit.
    // biome-ignore lint/correctness/useExhaustiveDependencies: resize when the text changes
    useEffect(() => {
        const el = textarea.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }, [input]);

    function change(value: string) {
        setInput(value);
        onTyping(value.trim().length > 0);
    }

    function submit(e?: FormEvent) {
        e?.preventDefault();
        const prompt = input.trim();
        if (!prompt || busy || !ready) return;
        setInput("");
        onTyping(false);
        onSend(prompt);
    }

    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
        }
    };

    const typing = people.filter((p) => p.typing).map((p) => p.name);
    const theirs = busy && runBy && !runBy.you ? (runBy.name.split(/[\s@]/)[0] ?? runBy.name) : null;
    const last = messages.at(-1);

    return (
        <section className="chat">
            <div className="chat-scroll" ref={scroller}>
                {loading ? (
                    <div className="chat-loading">
                        <Dots />
                    </div>
                ) : messages.length === 0 && !busy ? (
                    <div className="chat-empty">
                        <p className="eyebrow">Your assistant</p>
                        <h2 className="display">
                            Where shall we <em>begin?</em>
                        </h2>
                        <p className="muted">Describe what you want. Each request is saved as a version you can return to.</p>
                        <div className="suggestions">
                            {SUGGESTIONS.map((s) => (
                                <button key={s} type="button" disabled={!ready} onClick={() => onSend(s)}>
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="thread">
                        {messages.map((m) => (
                            <article key={m.id} className={`msg msg-${m.role}`}>
                                {m.role === "user" ? (
                                    <>
                                        {/* With several people on one website, each request says who asked. */}
                                        {m.authorId && m.authorId !== me && authors[m.authorId] && (
                                            <span className="msg-author">{authors[m.authorId]}</span>
                                        )}
                                        <p>{m.text}</p>
                                    </>
                                ) : m.role === "error" ? (
                                    <p>{m.text}</p>
                                ) : m.role === "note" ? (
                                    <>
                                        <p>{m.text}</p>
                                        <Steps tools={m.tools} label="What it had done" />
                                        {m === last && !busy && ready && (
                                            <button type="button" className="btn btn-sm btn-primary" onClick={props.onCarryOn}>
                                                <Play /> Carry on from here
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <Prose text={m.text || "Done."} />
                                        <Steps tools={m.tools} label="What I did" />
                                    </>
                                )}
                            </article>
                        ))}
                        {run && <Working run={run} whose={theirs} canAct={ready} onStop={props.onStop} onMoreTime={props.onMoreTime} />}
                    </div>
                )}
            </div>

            <form className="composer" onSubmit={submit}>
                {!ready && (
                    <div className="composer-status">
                        {locked ? (
                            locked
                        ) : starting ? (
                            <>
                                <Dots /> Opening the workspace…
                            </>
                        ) : (
                            <>
                                The workspace didn't start.
                                {onRetryWorkspace && (
                                    <button type="button" className="btn btn-sm" onClick={onRetryWorkspace}>
                                        <RotateCcw /> Try again
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
                {people.length > 0 && (
                    <p className={`composer-people ${typing.length ? "typing" : ""}`} aria-live="polite">
                        {typing.length > 0 ? (
                            <>
                                <Dots /> {names(typing)} {typing.length === 1 ? "is" : "are"} typing a request. Only one request can be
                                worked on at a time.
                            </>
                        ) : (
                            <>
                                <i className="here-dot" /> {names(people.map((p) => p.name))} {people.length === 1 ? "is" : "are"} here too.
                                You share this conversation and this assistant.
                            </>
                        )}
                    </p>
                )}
                <div className="composer-box">
                    <textarea
                        ref={textarea}
                        rows={1}
                        value={input}
                        onChange={(e) => change(e.target.value)}
                        onKeyDown={onKey}
                        placeholder={
                            locked
                                ? "Read-only"
                                : theirs
                                  ? `Your assistant is working on ${theirs}'s request…`
                                  : busy
                                    ? "Your assistant is working…"
                                    : "Describe a change…"
                        }
                        disabled={!ready}
                        aria-label="Message the assistant"
                    />
                    <button type="submit" className="send" disabled={!ready || busy || !input.trim()}>
                        Send <ArrowUp />
                    </button>
                </div>
                {ready && (
                    <div className="menu-wrap ideas" ref={ideasRef}>
                        <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setIdeasOpen((o) => !o)}
                            aria-haspopup="menu"
                            aria-expanded={ideasOpen}
                        >
                            <Lightbulb /> Ideas for what to ask
                        </button>
                        {ideasOpen && (
                            <div className="menu menu-left menu-up" role="menu">
                                <p className="menu-label eyebrow">Choose one, then change it or send it</p>
                                {IDEAS.map((idea) => (
                                    <button
                                        key={idea.name}
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setIdeasOpen(false);
                                            change(idea.request);
                                            textarea.current?.focus();
                                        }}
                                    >
                                        {idea.name}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <p className="composer-hint mono muted">
                    {busy
                        ? "You can write your next request now and send it when this one finishes."
                        : "Enter to send · Shift + Enter for a new line"}
                </p>
            </form>
        </section>
    );
}

// What the assistant did, one line that opens into the steps.
function Steps({ tools, label }: { tools: Message["tools"]; label: string }) {
    const list = stepList(tools ?? []);
    if (list.length === 0) return null;
    const line = summary(tools ?? []);
    return (
        <details className="msg-steps">
            <summary>
                <span className="mono">{line || label}</span>
                <span className="steps-toggle">
                    {label}: {list.length} {list.length === 1 ? "step" : "steps"}
                </span>
            </summary>
            <ol>
                {list.map((s, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of what happened, in order
                    <li key={i}>{s}</li>
                ))}
            </ol>
        </details>
    );
}

// How long without a new step before we say so (writing a long page takes a while).
const QUIET_MS = 75_000;
// How long before it would be paused that we offer more time.
const WARN_MS = 3 * 60_000;

// The request being worked on: what the assistant has just done, how long it has
// been going, and the ways to act on it. It never claims to know how far along
// it is, because it does not.
function Working({
    run,
    whose,
    canAct,
    onStop,
    onMoreTime,
}: {
    run: Run;
    whose: string | null;
    canAct: boolean;
    onStop: () => void;
    onMoreTime: () => void;
}) {
    const [now, setNow] = useState(Date.now());
    const [open, setOpen] = useState(false);
    const [stopping, setStopping] = useState(false);
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    const list = stepList(run.steps);
    const lastStep = run.steps.at(-1);
    const quiet = now - new Date(run.lastActivityAt).getTime();
    const left = new Date(run.deadlineAt).getTime() - now;
    const headline = stopping
        ? "Stopping…"
        : !lastStep
          ? "Reading your request and looking at the website"
          : quiet > QUIET_MS
            ? "Still working. This step is taking longer than usual"
            : "Working on the next step";

    return (
        <article className="msg msg-assistant working" aria-live="polite">
            <div className="working-head">
                <Dots />
                <span className="working-now">
                    {whose && <span className="working-whose">{whose}'s request · </span>}
                    {headline}
                </span>
                <span className="mono muted">{clock(now - new Date(run.startedAt).getTime())}</span>
            </div>
            {lastStep && (
                <p className="working-last">Just finished: {stepDone(lastStep).charAt(0).toLowerCase() + stepDone(lastStep).slice(1)}.</p>
            )}

            {list.length > 1 && (
                <>
                    <button type="button" className="link working-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                        {open ? "Hide" : "Show"} the {list.length} steps so far
                    </button>
                    {open && (
                        <ol className="working-steps">
                            {list.map((s, i) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: a growing list of what happened, in order
                                <li key={i}>{s}</li>
                            ))}
                        </ol>
                    )}
                </>
            )}

            {left < WARN_MS && !stopping && (
                <p className="working-time">
                    <Clock />
                    <span>
                        This is a long one. It will be paused in {clock(left)} so it can't run on unnoticed; what it has done will be kept
                        and you can carry on from there.
                    </span>
                    {canAct && run.canExtend && (
                        <button type="button" className="btn btn-sm" onClick={onMoreTime}>
                            Give it 10 more minutes
                        </button>
                    )}
                </p>
            )}

            {canAct && (
                <div className="working-actions">
                    <button
                        type="button"
                        className="btn btn-sm"
                        disabled={stopping}
                        onClick={() => {
                            setStopping(true);
                            onStop();
                        }}
                        title="Stop now. What it has done so far is kept as a version."
                    >
                        <Square /> Stop
                    </button>
                    <span className="muted">Stopping keeps what it has done so far.</span>
                </div>
            )}
        </article>
    );
}
