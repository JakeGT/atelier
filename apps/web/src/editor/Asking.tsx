import { MessageCircleQuestion, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AssistantQuestions } from "../lib/api";
import { useClickOutside } from "../lib/hooks";

// How much the assistant asks before it acts: one end decides everything itself,
// the other assumes nothing. What each stop means is said in words, always.
export const ASK_LEVELS: { short: string; name: string; about: string }[] = [
    {
        short: "never",
        name: "Decides everything itself",
        about: "Never stops to ask. It makes its best guess, uses placeholders for facts it does not have, and tells you what it assumed.",
    },
    {
        short: "only when it matters",
        name: "Asks only when it matters",
        about: "Decides ordinary things itself. Asks when a request could mean two things, or before something hard to put back.",
    },
    {
        short: "before big choices",
        name: "Checks before big choices",
        about: "Before building anything substantial it asks who it is for, which pages, the tone and the look. Small details it decides itself.",
    },
    {
        short: "about everything",
        name: "Assumes nothing",
        about: "Asks about everything you have not said, never invents a fact, and tells you its plan before it starts.",
    },
];

export function AskLevelControl({ level, onChange }: { level: number; onChange: (level: number) => void }) {
    const [open, setOpen] = useState(false);
    const wrap = useClickOutside(() => setOpen(false));
    const now = ASK_LEVELS[level] ?? ASK_LEVELS[1];
    return (
        <div className="menu-wrap" ref={wrap}>
            <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
            >
                <SlidersHorizontal /> Asks you: {now?.short}
            </button>
            {open && (
                <div className="menu menu-left menu-up asking" role="dialog" aria-label="How much your assistant asks">
                    <p className="menu-label eyebrow">How much should your assistant ask you?</p>
                    <input
                        type="range"
                        min={0}
                        max={ASK_LEVELS.length - 1}
                        step={1}
                        value={level}
                        onChange={(e) => onChange(Number(e.target.value))}
                        aria-label="How much your assistant asks before it acts"
                        aria-valuetext={now?.name}
                        list="asking-stops"
                    />
                    <datalist id="asking-stops">
                        {ASK_LEVELS.map((l, i) => (
                            <option key={l.name} value={i} />
                        ))}
                    </datalist>
                    <div className="asking-ends muted">
                        <span>Decides everything itself</span>
                        <span>Assumes nothing</span>
                    </div>
                    <p className="asking-now" aria-live="polite">
                        <strong>{now?.name}.</strong> {now?.about}
                    </p>
                    <p className="muted asking-note">For this website, from your next request. Everyone working on it shares this.</p>
                </div>
            )}
        </div>
    );
}

// The assistant has stopped to ask. Each question has answers to pick from and room
// for the person's own; anything left alone is the assistant's to decide.
export function QuestionCard({
    asked,
    canAnswer,
    onAnswer,
}: {
    asked: AssistantQuestions;
    canAnswer: boolean;
    onAnswer: (answers: string[]) => void;
}) {
    const [picked, setPicked] = useState<(string | null)[]>(() => asked.questions.map(() => null));
    const [own, setOwn] = useState<string[]>(() => asked.questions.map(() => ""));
    const [sent, setSent] = useState(false);
    const card = useRef<HTMLElement>(null);
    useEffect(() => {
        card.current?.scrollIntoView({ block: "nearest" });
    }, []);
    const answers = asked.questions.map((_, i) => own[i]?.trim() || picked[i] || "");
    const given = answers.filter(Boolean).length;
    const send = (list: string[]) => {
        setSent(true);
        onAnswer(list);
    };
    return (
        <article className="msg msg-question" ref={card} aria-label="Your assistant is asking">
            <p className="eyebrow question-eyebrow">
                <MessageCircleQuestion /> Your assistant is asking
            </p>
            {asked.questions.map((q, i) => (
                <fieldset key={q.question} className="question" disabled={!canAnswer || sent}>
                    <legend>{q.question}</legend>
                    {q.why && <p className="muted question-why">{q.why}</p>}
                    {q.options.length > 0 && (
                        <div className="question-options">
                            {q.options.map((o, n) => (
                                <label key={o} className={`question-option ${picked[i] === o && !own[i]?.trim() ? "on" : ""}`}>
                                    <input
                                        type="radio"
                                        name={`q-${asked.id}-${i}`}
                                        checked={picked[i] === o && !own[i]?.trim()}
                                        onChange={() => {
                                            setPicked((p) => p.map((v, k) => (k === i ? o : v)));
                                            setOwn((w) => w.map((v, k) => (k === i ? "" : v)));
                                        }}
                                    />
                                    <span>{o}</span>
                                    {n === 0 && <span className="muted question-first">its suggestion</span>}
                                </label>
                            ))}
                        </div>
                    )}
                    <input
                        type="text"
                        className="question-own"
                        value={own[i] ?? ""}
                        maxLength={2000}
                        onChange={(e) => setOwn((w) => w.map((v, k) => (k === i ? e.target.value : v)))}
                        placeholder={q.options.length > 0 ? "Or write your own answer" : "Write your answer"}
                        aria-label={`Your own answer to: ${q.question}`}
                    />
                </fieldset>
            ))}
            {canAnswer && (
                <div className="question-actions">
                    <button type="button" className="btn btn-sm btn-primary" disabled={sent || given === 0} onClick={() => send(answers)}>
                        {given < asked.questions.length && given > 0 ? "Send these; it decides the rest" : "Send my answers"}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={sent} onClick={() => send(asked.questions.map(() => ""))}>
                        Decide all of this for me
                    </button>
                </div>
            )}
            <p className="muted question-note">
                {canAnswer
                    ? "It is waiting, and has changed nothing since it asked. You can also just write to it below."
                    : "It is waiting for an answer from someone who can make changes."}
            </p>
        </article>
    );
}
