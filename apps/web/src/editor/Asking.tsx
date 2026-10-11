import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AssistantQuestions } from "../lib/api";

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

// The slider itself, always in view: under the message box, and in the website's settings.
// `full`: always say what the chosen stop means (settings); otherwise it is said while the
// slider is being used, to keep the conversation panel uncluttered.
export function AskLevelSlider({
    level,
    onChange,
    disabled,
    full,
    note,
}: {
    level: number;
    onChange: (level: number) => void;
    disabled?: boolean;
    full?: boolean;
    // Said after what the stop means, in place of the usual line about when it takes effect.
    note?: string;
}) {
    const [using, setUsing] = useState(false);
    const id = useId();
    const now = ASK_LEVELS[level] ?? ASK_LEVELS[1];
    return (
        <fieldset
            className={`asking ${full ? "asking-full" : ""}`}
            disabled={disabled}
            onFocus={() => setUsing(true)}
            onBlur={() => setUsing(false)}
            onMouseEnter={() => setUsing(true)}
            onMouseLeave={() => setUsing(false)}
        >
            <legend className="asking-head">
                <label htmlFor={id} className="eyebrow">
                    How much your assistant asks you
                </label>
                <strong className="asking-name">{now?.name}</strong>
            </legend>
            <input
                id={id}
                type="range"
                min={0}
                max={ASK_LEVELS.length - 1}
                step={1}
                value={level}
                onChange={(e) => onChange(Number(e.target.value))}
                aria-valuetext={now?.name}
                list={`${id}-stops`}
            />
            <datalist id={`${id}-stops`}>
                {ASK_LEVELS.map((l, i) => (
                    <option key={l.name} value={i} />
                ))}
            </datalist>
            <div className="asking-ends muted">
                <span>Decides everything itself</span>
                <span>Assumes nothing</span>
            </div>
            {(full || using) && (
                <p className="asking-now" aria-live="polite">
                    {now?.about}{" "}
                    <span className="muted">{note ?? "For this website, from your next request; shared by everyone working on it."}</span>
                </p>
            )}
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
