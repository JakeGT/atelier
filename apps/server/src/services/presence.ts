// Who has a website open right now, who is typing, and which request is being
// worked on: what lets several people share one editor without tripping over
// each other. Kept in memory: it is about this moment, and a restart simply
// starts it again (the conversation itself is in the database).
//
// `stamp` changes whenever something about the website changes (a message, a
// finished request, a saved wording, a publish), so every open editor knows to
// reload what it shows.

export interface Person {
    id: string;
    name: string;
    typing: boolean;
}

export interface ActiveRun {
    runId: string;
    // Who asked, for "Maren's request is being worked on".
    userId: string;
    name: string;
}

const HERE_MS = 15_000;
const TYPING_MS = 5_000;

interface Seen {
    name: string;
    at: number;
    typingAt: number;
}

export class Presence {
    private readonly people = new Map<string, Map<string, Seen>>();
    private readonly runs = new Map<string, ActiveRun>();
    private readonly stamps = new Map<string, number>();
    private readonly now: () => number;

    constructor(now: () => number = Date.now) {
        this.now = now;
    }

    // Called on every pulse from an open editor.
    seen(projectId: string, user: { id: string; name: string }, typing: boolean): void {
        let here = this.people.get(projectId);
        if (!here) {
            here = new Map();
            this.people.set(projectId, here);
        }
        const t = this.now();
        // Not typing any more clears it at once (they sent, or emptied the box).
        // "Never" rather than 0, which is a time like any other to a clock that starts there.
        here.set(user.id, { name: user.name, at: t, typingAt: typing ? t : Number.NEGATIVE_INFINITY });
    }

    // Everyone with the website open, the asker excluded.
    others(projectId: string, exceptUserId: string): Person[] {
        const here = this.people.get(projectId);
        if (!here) return [];
        const t = this.now();
        const out: Person[] = [];
        for (const [id, s] of here) {
            if (t - s.at > HERE_MS) {
                here.delete(id);
                continue;
            }
            if (id !== exceptUserId) out.push({ id, name: s.name, typing: t - s.typingAt <= TYPING_MS });
        }
        if (here.size === 0) this.people.delete(projectId);
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    setRun(projectId: string, run: ActiveRun): void {
        this.runs.set(projectId, run);
    }

    run(projectId: string): ActiveRun | null {
        return this.runs.get(projectId) ?? null;
    }

    clearRun(projectId: string, runId: string): void {
        if (this.runs.get(projectId)?.runId === runId) this.runs.delete(projectId);
    }

    // Something about the website changed.
    touch(projectId: string): void {
        this.stamps.set(projectId, Math.max(this.now(), (this.stamps.get(projectId) ?? 0) + 1));
    }

    stamp(projectId: string): number {
        return this.stamps.get(projectId) ?? 0;
    }

    forget(projectId: string): void {
        this.people.delete(projectId);
        this.runs.delete(projectId);
        this.stamps.delete(projectId);
    }
}
