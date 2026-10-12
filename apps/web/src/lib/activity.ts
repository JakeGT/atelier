import type { AgentToolEvent } from "./api";

// Turns what the assistant's engine reports (a tool and, sometimes, a file) into
// words a person would use. No file paths, commands or tool names reach the screen.

// "index.html" -> "the home page"; "about.html" -> "the About page"; "css/site.css" -> "the styles".
export function plainFile(target: string | null | undefined): string {
    if (!target) return "a file";
    const name = target.split("/").pop() ?? target;
    const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
    const base = name.replace(/\.[^.]+$/, "");
    if (ext === "html" || ext === "htm") {
        if (base.toLowerCase() === "index") {
            const folder = target.split("/").slice(0, -1).pop();
            return folder ? `the ${words(folder)} page` : "the home page";
        }
        if (base === "404") return "the “not found” page";
        // A file with no name before its ending (".html").
        if (!words(base)) return "a page";
        return `the ${words(base)} page`;
    }
    if (ext === "css") return "the styles";
    if (ext === "js" || ext === "mjs" || ext === "ts") return "the scripts";
    if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"].includes(ext)) return "an image";
    if (ext === "json" || ext === "md" || ext === "txt") return "a notes file";
    return "a file";
}

// "opening-hours" -> "Opening hours"
function words(s: string): string {
    const t = s.replace(/[-_]+/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
}

type Kind =
    | "read"
    | "write"
    | "edit"
    | "look"
    | "check"
    | "wording-save"
    | "wording-read"
    | "web"
    | "plan"
    | "see"
    | "editable"
    | "files"
    | "design"
    | "other";

function kindOf(name: string): Kind {
    if (name === "read") return "read";
    if (name === "write") return "write";
    if (name === "edit" || name === "patch" || name === "multiedit") return "edit";
    if (name === "glob" || name === "grep" || name === "list") return "look";
    if (name === "bash") return "check";
    if (name.includes("design_")) return "design";
    if (name.includes("page_look")) return "see";
    if (name.includes("content_check")) return "editable";
    if (name.includes("media_list")) return "files";
    if (name.includes("content_upsert")) return "wording-save";
    if (name.includes("content_")) return "wording-read";
    if (name.includes("webfetch") || name.includes("websearch") || name.includes("web_")) return "web";
    if (name.includes("todo")) return "plan";
    return "other";
}

const SIZES: Record<string, string | undefined> = { desktop: "on a desktop", tablet: "on a tablet", phone: "on a phone" };

// A step that is over. The engine does not always say how a step ended ("unknown"): it is
// counted as done, the same in the list of steps and in the one-line summary.
const finished = (step: AgentToolEvent): boolean => step.state === "completed" || step.state === "unknown";

// What a finished step was, in the past tense: "Wrote the home page".
export function stepDone(step: AgentToolEvent): string {
    const file = plainFile(step.target);
    switch (kindOf(step.name)) {
        case "read":
            return `Read ${file}`;
        case "write":
            return `Wrote ${file}`;
        case "edit":
            return `Changed ${file}`;
        case "look":
            return "Looked through your pages";
        case "check":
            return "Checked its work";
        case "see": {
            if (!step.target) return "Looked at the page";
            // "about.html@phone": the page, then the size it was looked at.
            const at = step.target.lastIndexOf("@");
            const page = plainFile(at < 0 ? step.target : step.target.slice(0, at));
            const size = at < 0 ? undefined : SIZES[step.target.slice(at + 1)];
            return size ? `Looked at ${page} ${size}` : `Looked at ${page}`;
        }
        case "design":
            return step.name.includes("use_look")
                ? "Changed the look"
                : step.name.includes("section")
                  ? "Fetched a ready-made section"
                  : "Looked at the design kit";
        case "editable":
            return "Checked that everything can be edited";
        case "files":
            return "Looked through your pictures and files";
        case "wording-save":
            return "Saved your wording";
        case "wording-read":
            return "Read your wording";
        case "web":
            return "Looked something up";
        case "plan":
            return "Planned the work";
        default:
            return "Did some work";
    }
}

// Whether a step changed a file (the preview is worth reloading after one).
export const changedFiles = (step: AgentToolEvent): boolean => ["write", "edit"].includes(kindOf(step.name));

// Something the assistant said while it worked, rather than something it did.
export const isSaid = (step: AgentToolEvent): boolean => step.name === "say" && Boolean(step.said);

// The steps in order, repeats folded, with what the assistant said along the way kept as its own lines.
export function stepItems(steps: AgentToolEvent[]): { text: string; said: boolean }[] {
    const out: { label: string; n: number; said: boolean }[] = [];
    for (const s of steps) {
        if (isSaid(s)) {
            out.push({ label: s.said ?? "", n: 1, said: true });
            continue;
        }
        if (s.name === "say" || !finished(s)) continue;
        const label = stepDone(s);
        const last = out.at(-1);
        if (last && !last.said && last.label === label) last.n++;
        else out.push({ label, n: 1, said: false });
    }
    return out.map((x) => ({ text: x.n > 1 ? `${x.label} ×${x.n}` : x.label, said: x.said }));
}

// Only what it did: ["Read the home page", "Wrote the styles ×2"].
export function stepList(steps: AgentToolEvent[]): string[] {
    return stepItems(steps.filter((s) => s.name !== "say")).map((x) => x.text);
}

// One line for a finished reply: "Wrote 3 pages and the styles · saved your wording".
export function summary(steps: AgentToolEvent[]): string {
    const done = steps.filter(finished);
    const count = (k: Kind[]) => done.filter((t) => k.includes(kindOf(t.name))).length;
    const parts: string[] = [];
    // Counted by file, not by what a file is called here: two pictures are two parts, not one "an image".
    const changed = new Set(done.filter(changedFiles).map((t) => t.target ?? ""));
    if (changed.size === 1) parts.push(`worked on ${plainFile([...changed][0])}`);
    else if (changed.size > 1) parts.push(`worked on ${changed.size} parts of the website`);
    if (count(["wording-save"])) parts.push("saved your wording");
    if (count(["see"])) parts.push("looked at the result");
    if (count(["web"])) parts.push("looked something up");
    if (!parts.length && count(["read", "look", "wording-read"])) parts.push("looked through the website");
    const text = parts.join(" · ");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// "0:42"
export function clock(ms: number): string {
    // A time that cannot be worked out reads as none, not as "NaN:NaN".
    const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
