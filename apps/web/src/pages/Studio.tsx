import { ArrowUp, Plus } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { Project, Session } from "../lib/api";
import { api } from "../lib/api";
import { navigate, type Theme, timeAgo } from "../lib/hooks";
import { Cover } from "../ui/Cover";
import { Dots, ThemeToggle, UserMenu, useToast, Wordmark } from "../ui/kit";

// Where a brief typed on the dashboard waits for the editor to pick it up.
export const FIRST_PROMPT_KEY = "atelier.first-prompt";

const STARTERS = [
    {
        name: "Portfolio",
        brief: "A portfolio for a photographer: a full-bleed hero image, a grid of selected work, and a short about section.",
    },
    { name: "Café", brief: "A one-page site for a neighbourhood café: opening hours, a short menu, and where to find us." },
    { name: "Consultancy", brief: "A landing page for an independent consultant: what I do, three services, and a contact section." },
    { name: "Invitation", brief: "A wedding invitation page: the date, the venue, a schedule for the day, and an RSVP note." },
];

function greeting(): string {
    const h = new Date().getHours();
    if (h < 5) return "Working late";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
}

export function Studio({ session, theme, onToggleTheme }: { session: Session; theme: Theme; onToggleTheme: () => void }) {
    const toast = useToast();
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [name, setName] = useState("");
    const [brief, setBrief] = useState("");
    const [busy, setBusy] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);
    const firstName = session.name.split(/[\s@]/)[0] || "there";

    useEffect(() => {
        api.listProjects()
            .then((p) => setProjects([...p].reverse()))
            .catch((err: Error) => {
                setProjects([]);
                toast(err.message, "error");
            });
    }, [toast]);

    async function create(e?: FormEvent) {
        e?.preventDefault();
        if (busy) return;
        if (!name.trim()) {
            nameRef.current?.focus();
            return;
        }
        setBusy(true);
        try {
            const project = await api.createProject(name.trim());
            if (brief.trim()) sessionStorage.setItem(FIRST_PROMPT_KEY, JSON.stringify({ projectId: project.id, prompt: brief.trim() }));
            navigate(`/p/${project.slug}`);
        } catch (err) {
            toast((err as Error).message, "error");
            setBusy(false);
        }
    }

    const onBriefKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
    };

    return (
        <div className="studio">
            <header className="studio-nav">
                <Wordmark />
                <div className="studio-nav-right">
                    <ThemeToggle theme={theme} onToggle={onToggleTheme} />
                    <UserMenu session={session} />
                </div>
            </header>

            <main className="studio-main">
                <section className="commission">
                    <p className="eyebrow">
                        {greeting()}, {firstName}
                    </p>
                    <h1 className="display">
                        What shall we <em>make?</em>
                    </h1>

                    <form className="brief" onSubmit={create}>
                        <input
                            ref={nameRef}
                            className="brief-name"
                            placeholder="Name your website"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={120}
                            aria-label="Website name"
                        />
                        <textarea
                            className="brief-text"
                            placeholder="Describe it, and your assistant starts building straight away. Or leave this blank and begin in the editor."
                            value={brief}
                            onChange={(e) => setBrief(e.target.value)}
                            onKeyDown={onBriefKey}
                            rows={3}
                            aria-label="Describe the website"
                        />
                        <div className="brief-foot">
                            <div className="starters">
                                {STARTERS.map((s) => (
                                    <button
                                        key={s.name}
                                        type="button"
                                        className="btn btn-sm"
                                        onClick={() => {
                                            setBrief(s.brief);
                                            if (!name.trim()) nameRef.current?.focus();
                                        }}
                                    >
                                        {s.name}
                                    </button>
                                ))}
                            </div>
                            <button type="submit" className="btn btn-seal" disabled={busy}>
                                {busy ? (
                                    <Dots />
                                ) : (
                                    <>
                                        {brief.trim() ? "Start building" : "Create"} <ArrowUp />
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                </section>

                <section className="shelf">
                    <div className="shelf-head">
                        <h2 className="eyebrow">Your websites</h2>
                        {projects && projects.length > 0 && <span className="mono muted">{projects.length}</span>}
                    </div>

                    {projects === null ? (
                        <div className="shelf-grid">
                            {[0, 1, 2].map((i) => (
                                <div key={i} className="card card-ghost" />
                            ))}
                        </div>
                    ) : projects.length === 0 ? (
                        <button type="button" className="shelf-empty" onClick={() => nameRef.current?.focus()}>
                            <Plus />
                            <span className="display">Nothing on the shelf yet.</span>
                            <span className="muted">Name a website above to make your first one.</span>
                        </button>
                    ) : (
                        <div className="shelf-grid">
                            {projects.map((p, i) => (
                                <a
                                    key={p.id}
                                    className="card"
                                    href={`/p/${p.slug}`}
                                    style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        navigate(`/p/${p.slug}`);
                                    }}
                                >
                                    <Cover seed={p.id} label={p.name} />
                                    <div className="card-meta">
                                        <strong>{p.name}</strong>
                                        <span className="mono muted">
                                            {p.slug} · {timeAgo(p.createdAt)}
                                        </span>
                                    </div>
                                </a>
                            ))}
                        </div>
                    )}
                </section>
            </main>
        </div>
    );
}
