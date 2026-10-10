import { ArrowUp, RotateCcw } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { AgentToolEvent, ThreadMessage } from "../lib/api";
import { useElapsed } from "../lib/hooks";
import { Dots } from "../ui/kit";
import { Prose } from "./Prose";

export type Message = Pick<ThreadMessage, "id" | "role" | "text" | "tools">;

const SUGGESTIONS = [
    "Build a home page with a hero, three features and a contact section",
    "Give it a warm, editorial look with a serif headline",
    "Add an About page and link it from the header",
    "Make it work beautifully on a phone",
];

// "write" ×2, "atelier-content_content_upsert_draft" ×1  →  "Wrote 2 files · saved content"
function summarize(tools: AgentToolEvent[]): string {
    const done = tools.filter((t) => t.state === "completed");
    const count = (pred: (n: string) => boolean) => done.filter((t) => pred(t.name)).length;
    const parts: string[] = [];
    const wrote = count((n) => n === "write");
    const edited = count((n) => n === "edit" || n === "patch" || n === "multiedit");
    const content = count((n) => n.includes("content_upsert"));
    const ran = count((n) => n === "bash");
    const read = count((n) => ["read", "glob", "grep", "list"].includes(n) || n.includes("content_get") || n.includes("content_list"));
    if (wrote) parts.push(`wrote ${wrote} ${wrote === 1 ? "file" : "files"}`);
    if (edited) parts.push(`made ${edited} ${edited === 1 ? "edit" : "edits"}`);
    if (content) parts.push(`saved ${content === 1 ? "content" : `${content} content drafts`}`);
    if (ran) parts.push(`ran ${ran} ${ran === 1 ? "command" : "commands"}`);
    if (!parts.length && read) parts.push("looked through the project");
    const text = parts.join(" · ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

interface ChatProps {
    messages: Message[];
    loading: boolean;
    runningSince: string | null;
    ready: boolean;
    starting: boolean;
    // Why the conversation cannot be continued here (a viewer, an archived website), if so.
    locked?: string | null;
    onSend: (prompt: string) => void;
    onRetryWorkspace?: () => void;
}

export function Chat({ messages, loading, runningSince, ready, starting, locked, onSend, onRetryWorkspace }: ChatProps) {
    const [input, setInput] = useState("");
    const scroller = useRef<HTMLDivElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const elapsed = useElapsed(runningSince);
    const busy = runningSince !== null;

    // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows
    useEffect(() => {
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    }, [messages.length, busy]);

    // Grow the composer with its content, up to a limit.
    // biome-ignore lint/correctness/useExhaustiveDependencies: resize when the text changes
    useEffect(() => {
        const el = textarea.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }, [input]);

    function submit(e?: FormEvent) {
        e?.preventDefault();
        const prompt = input.trim();
        if (!prompt || busy || !ready) return;
        setInput("");
        onSend(prompt);
    }

    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
        }
    };

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
                                    <p>{m.text}</p>
                                ) : m.role === "error" ? (
                                    <p>{m.text}</p>
                                ) : (
                                    <>
                                        <Prose text={m.text || "Done."} />
                                        {m.tools && m.tools.length > 0 && summarize(m.tools) && (
                                            <p className="msg-tools mono">{summarize(m.tools)}</p>
                                        )}
                                    </>
                                )}
                            </article>
                        ))}
                        {busy && (
                            <article className="msg msg-assistant msg-working">
                                <Dots />
                                <span>Working</span>
                                <span className="mono muted">{elapsed}</span>
                            </article>
                        )}
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
                <div className="composer-box">
                    <textarea
                        ref={textarea}
                        rows={1}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={onKey}
                        placeholder={locked ? "Read-only" : busy ? "The assistant is working…" : "Describe a change…"}
                        disabled={!ready}
                        aria-label="Message the assistant"
                    />
                    <button type="submit" className="send" disabled={!ready || busy || !input.trim()}>
                        Send <ArrowUp />
                    </button>
                </div>
                <p className="composer-hint mono muted">Enter to send · Shift + Enter for a new line</p>
            </form>
        </section>
    );
}
