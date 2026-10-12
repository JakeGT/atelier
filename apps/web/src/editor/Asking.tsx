import { ChevronDown, MessageCircleQuestion, SlidersHorizontal } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { AssistantQuestions } from "../lib/api";

// How much the assistant asks before it acts: one end decides everything itself,
// the other assumes nothing. What each stop means is said in words, always.
// `short` completes "Asks you: …"; `brief` follows the setting's name on one line; `about` is the full account.
export const ASK_LEVELS: { short: string; name: string; brief: string; about: string }[] = [
    {
        short: "never",
        name: "Decides everything itself",
        brief: "it never stops to ask, and tells you afterwards what it assumed",
        about: "Never stops to ask. It makes its best guess, uses placeholders for facts it does not have, and tells you what it assumed.",
    },
    {
        short: "only when it matters",
        name: "Asks only when it matters",
        brief: "it decides ordinary things, and asks when a wrong guess would cost you",
        about: "Decides ordinary things itself. Asks when a request could mean two things, or before something hard to put back.",
    },
    {
        short: "before big choices",
        name: "Checks before big choices",
        brief: "it asks who it is for, which pages and the look before it builds",
        about: "Before building anything substantial it asks who it is for, which pages, the tone and the look. Small details it decides itself.",
    },
    {
        short: "about everything",
        name: "Assumes nothing",
        brief: "it asks about everything you have not said, and shows its plan first",
        about: "Asks about everything you have not said, never invents a fact, and tells you its plan before it starts.",
    },
];

// The slider, drawn by Atelier rather than the browser so it looks the same everywhere: a line
// with a stop for each choice and a handle that glides between them. Underneath it is an
// ordinary range input, so dragging, clicking, the arrow keys and screen readers all work.
// `labels`: name every stop under the line ("all", where there is room across), or only the two ends.
function Track({ id, level, onChange, labels }: { id: string; level: number; onChange: (level: number) => void; labels: "all" | "ends" }) {
    const last = ASK_LEVELS.length - 1;
    const now = ASK_LEVELS[level] ?? ASK_LEVELS[1];
    return (
        <div className={`ask-track ask-track-${labels}`} style={{ "--at": level / last } as CSSProperties}>
            <div className="ask-line" aria-hidden="true">
                <span className="ask-fill" />
                {ASK_LEVELS.map((l, i) => (
                    <span key={l.name} className={`ask-stop ${i <= level ? "passed" : ""}`} style={{ "--i": i / last } as CSSProperties} />
                ))}
                <span className="ask-handle" />
            </div>
            <input
                id={id}
                type="range"
                min={0}
                max={last}
                step={1}
                value={level}
                onChange={(e) => onChange(Number(e.target.value))}
                aria-label="How much your assistant asks you before it acts"
                aria-valuetext={now?.name}
            />
            <div className="ask-names">
                {ASK_LEVELS.map((l, i) => (
                    <button
                        key={l.name}
                        type="button"
                        // The slider itself takes the keyboard; these are for pointing at.
                        tabIndex={-1}
                        className={`${i === level ? "on" : ""} ${i === 0 ? "first" : i === last ? "last" : "middle"}`}
                        style={{ "--i": i / last } as CSSProperties}
                        onClick={() => onChange(i)}
                    >
                        {l.name}
                    </button>
                ))}
            </div>
        </div>
    );
}

// How much the assistant asks, in three settings of the same control:
// `row` (the new-website form): its name and what the chosen stop means on one line, the slider across the whole width;
// `full` (the website's settings): boxed, with the explanation always shown;
// neither (under the message box): a button that names the setting and opens the slider in place.
export function AskLevelSlider({
    level,
    onChange,
    disabled,
    full,
    row,
    note,
}: {
    level: number;
    onChange: (level: number) => void;
    disabled?: boolean;
    full?: boolean;
    row?: boolean;
    // Said after what the stop means, in place of the usual line about when it takes effect.
    note?: string;
}) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const now = ASK_LEVELS[level] ?? ASK_LEVELS[1];
    if (row) {
        return (
            <fieldset className="asking-row" disabled={disabled}>
                <p className="asking-row-head">
                    <label htmlFor={id}>How much your assistant asks you</label>
                    <span className="asking-row-now" aria-live="polite">
                        <span className="asking-row-dot" aria-hidden="true">
                            ·
                        </span>
                        {now?.brief}
                    </span>
                </p>
                <Track id={id} level={level} onChange={onChange} labels="all" />
            </fieldset>
        );
    }
    if (!full) {
        return (
            <div className={`asking-fold ${open ? "open" : ""}`}>
                <button
                    type="button"
                    className="btn btn-sm btn-ghost asking-fold-button"
                    onClick={() => setOpen((o) => !o)}
                    aria-expanded={open}
                    aria-controls={`${id}-panel`}
                    disabled={disabled}
                >
                    <SlidersHorizontal />
                    <span>How much your assistant asks you:</span>
                    <strong>{now?.short}</strong>
                    <ChevronDown className="asking-fold-chevron" />
                </button>
                <div className="asking-fold-panel" id={`${id}-panel`} inert={!open}>
                    <div>
                        <fieldset className="asking-fold-inner" disabled={disabled}>
                            <Track id={id} level={level} onChange={onChange} labels="ends" />
                            <p className="asking-now" aria-live="polite">
                                <strong>{now?.name}.</strong> {now?.about}{" "}
                                <span className="muted">{note ?? "For this website, from your next request."}</span>
                            </p>
                        </fieldset>
                    </div>
                </div>
            </div>
        );
    }
    return (
        <fieldset className="asking asking-full" disabled={disabled}>
            <legend className="asking-head">
                <label htmlFor={id} className="eyebrow">
                    How much your assistant asks you
                </label>
                <strong className="asking-name">{now?.name}</strong>
            </legend>
            <Track id={id} level={level} onChange={onChange} labels="ends" />
            <p className="asking-now" aria-live="polite">
                {now?.about}{" "}
                <span className="muted">{note ?? "For this website, from your next request; shared by everyone working on it."}</span>
            </p>
        </fieldset>
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
