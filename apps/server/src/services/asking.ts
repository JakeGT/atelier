// How much the assistant asks before it acts (ADR-0019). A setting of the
// website, from "decides everything itself" to "assumes nothing"; each level is
// a paragraph of the assistant's rules. Questions go through its ask_person
// tool: the request ends there, the person answers in the conversation, and the
// same request carries on with the answers.

export const ASK_LEVELS = [0, 1, 2, 3] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];
export const DEFAULT_ASK_LEVEL: AskLevel = 1;
export const isAskLevel = (n: unknown): n is AskLevel => typeof n === "number" && (ASK_LEVELS as readonly number[]).includes(n);

const HOW = `To ask, call \`ask_person\` once with every question you have (six at most). For each: one short question in plain words, why you are asking in a few words, and two to four answers to choose from when you can think of them, the one you would pick first. Never ask about code or files. Ask before you start the work the answer affects, not after. When you have called it, stop: say in one sentence that you are waiting for their answer, and do nothing else. Their answers arrive as the next message, and you carry on from where you were.`;

const LEVEL_RULES: Record<AskLevel, string> = {
    0: `**The person has asked you to decide everything yourself.** Do not ask questions and do not call \`ask_person\`. Where a request is unclear, choose the most likely meaning; where something is not given (a price, an address, a name), use a clearly marked placeholder they can replace. When you finish, list in a line or two what you assumed, so they can correct it.`,
    1: `**The person wants to be asked only when it matters.** Decide ordinary things yourself. Ask when a request could mean two quite different things, when a wrong guess would waste a lot of work, or before something that cannot easily be put back (removing a page, rewriting all the wording, changing the look of the whole website). Do not ask about details you can sensibly choose.\n\n${HOW}`,
    2: `**The person wants you to check before big choices.** Before you build or change anything substantial, ask about what shapes the result and has not been said: who the website is for, which pages, the tone of the wording, the look, what must be kept. Decide small details yourself (spacing, the order of two items) and mention them when you finish. A small, clear request (fix this word, make this bigger) needs no questions.\n\n${HOW}`,
    3: `**The person wants you to assume nothing.** Before you do anything, ask about everything the request does not state: purpose, audience, pages, wording, look, and every fact (names, prices, times, addresses). Never invent a fact; ask for it. For a larger request, first say in a few lines what you plan to do and ask whether to go ahead. Only a request that leaves nothing open may be done without asking. When you finish, ask whether it is what they wanted.\n\n${HOW}`,
};

export const askRules = (level: AskLevel): string => `## How much to ask\n${LEVEL_RULES[level]}`;

export interface AskedQuestion {
    question: string;
    // Why it is being asked, in a few words.
    why: string;
    // Answers offered; the first is the one the assistant would pick. May be empty.
    options: string[];
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// What the assistant sent, made safe to keep and show. Null when there is nothing to ask.
export function cleanQuestions(raw: unknown): AskedQuestion[] | null {
    if (!Array.isArray(raw)) return null;
    const out: AskedQuestion[] = [];
    for (const item of raw.slice(0, 6)) {
        const q = item as { question?: unknown; why?: unknown; options?: unknown };
        const question = clean(q?.question, 300);
        if (!question) continue;
        const options = Array.isArray(q.options) ? [...new Set(q.options.map((o) => clean(o, 120)).filter(Boolean))].slice(0, 5) : [];
        out.push({ question, why: clean(q.why, 200), options });
    }
    return out.length > 0 ? out : null;
}

// The assistant's own judgement was asked for instead of an answer.
export const YOU_DECIDE = "You decide.";

// The answers, as the message that carries the request on.
export function answersPrompt(questions: AskedQuestion[], answers: string[]): string {
    const lines = questions.map((q, i) => `- ${q.question}\n  ${answers[i]?.trim() || YOU_DECIDE}`);
    return `Here are my answers to your questions. Carry on with what I asked, using them.\n\n${lines.join("\n")}\n\nWhere I said "${YOU_DECIDE}", use your own judgement and tell me what you chose.`;
}

// The same, as the person reads it back in the conversation.
export function answersText(questions: AskedQuestion[], answers: string[]): string {
    return questions.map((q, i) => `${q.question}\n→ ${answers[i]?.trim() || YOU_DECIDE}`).join("\n\n");
}
