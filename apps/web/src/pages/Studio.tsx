import { ArchiveRestore, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Org, Project, Session } from "../lib/api";
import { can, orgApi, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, timeAgo } from "../lib/hooks";
import { Cover } from "../ui/Cover";
import { Dialog, Dots, useToast } from "../ui/kit";
import { StudioNav } from "../ui/StudioNav";

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

interface StudioProps {
    session: Session;
    org: Org;
    orgs: Org[];
    onOrgsChanged: () => Promise<Org[]>;
    theme: Theme;
    onToggleTheme: () => void;
}

export function Studio({ session, org, orgs, onOrgsChanged, theme, onToggleTheme }: StudioProps) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [archived, setArchived] = useState<Project[]>([]);
    const [showArchived, setShowArchived] = useState(false);
    const [name, setName] = useState("");
    const [brief, setBrief] = useState("");
    const [busy, setBusy] = useState(false);
    const [deleting, setDeleting] = useState<Project | null>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const firstName = session.name.split(/[\s@]/)[0] || "there";
    const mayManage = can.manage(org.role);

    const load = useCallback(async () => {
        try {
            const [live, gone] = await Promise.all([a.listProjects(), a.listProjects(true)]);
            setProjects([...live].reverse());
            setArchived([...gone].reverse());
        } catch (err) {
            setProjects([]);
            toast((err as Error).message, "error");
        }
    }, [a, toast]);

    useEffect(() => {
        void load();
    }, [load]);

    async function create(e?: FormEvent) {
        e?.preventDefault();
        if (busy) return;
        if (!name.trim()) {
            nameRef.current?.focus();
            return;
        }
        setBusy(true);
        try {
            const project = await a.createProject(name.trim());
            if (brief.trim()) sessionStorage.setItem(FIRST_PROMPT_KEY, JSON.stringify({ projectId: project.id, prompt: brief.trim() }));
            navigate(`/o/${org.slug}/p/${project.slug}`);
        } catch (err) {
            toast((err as Error).message, "error");
            setBusy(false);
        }
    }

    const onBriefKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
    };

    async function restore(p: Project) {
        try {
            await a.restoreProject(p.id);
            toast(`${p.name} is back on the shelf.`);
            await load();
        } catch (err) {
            toast((err as Error).message, "error");
        }
    }

    async function remove(p: Project) {
        try {
            await a.deleteProject(p.id);
            setDeleting(null);
            toast(`${p.name} was deleted.`);
            await load();
        } catch (err) {
            if (err instanceof ReauthRequired) {
                toast("Please confirm your sign-in, then delete again.", "error");
                setTimeout(reauthenticate, 1200);
            } else toast((err as Error).message, "error");
        }
    }

    return (
        <div className="studio">
            <StudioNav
                session={session}
                org={org}
                orgs={orgs}
                onOrgsChanged={onOrgsChanged}
                theme={theme}
                onToggleTheme={onToggleTheme}
                section="websites"
            />

            <main className="studio-main">
                <section className="commission">
                    <p className="eyebrow">
                        {greeting()}, {firstName}
                    </p>
                    <h1 className="display">
                        What shall we <em>make?</em>
                    </h1>

                    {mayManage ? (
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
                    ) : (
                        <p className="commission-note">
                            You're {org.role === "editor" ? "an editor" : "a viewer"} in {org.name}. Owners and admins start new websites;{" "}
                            {org.role === "editor" ? "you can work on the ones below." : "you can look at the ones below."}
                        </p>
                    )}
                </section>

                <section className="shelf">
                    <div className="shelf-head">
                        <h2 className="eyebrow">{org.name}'s websites</h2>
                        {projects && projects.length > 0 && <span className="mono muted">{projects.length}</span>}
                    </div>

                    {projects === null ? (
                        <div className="shelf-grid">
                            {[0, 1, 2].map((i) => (
                                <div key={i} className="card card-ghost" />
                            ))}
                        </div>
                    ) : projects.length === 0 ? (
                        <button type="button" className="shelf-empty" onClick={() => nameRef.current?.focus()} disabled={!mayManage}>
                            <Plus />
                            <span className="display">Nothing on the shelf yet.</span>
                            <span className="muted">
                                {mayManage
                                    ? "Name a website above to make your first one."
                                    : "Websites made in this studio will appear here."}
                            </span>
                        </button>
                    ) : (
                        <div className="shelf-grid">
                            {projects.map((p, i) => (
                                <a
                                    key={p.id}
                                    className="card"
                                    href={`/o/${org.slug}/p/${p.slug}`}
                                    style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        navigate(`/o/${org.slug}/p/${p.slug}`);
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

                {archived.length > 0 && (
                    <section className="shelf shelf-archived">
                        <button
                            type="button"
                            className="shelf-head shelf-toggle"
                            onClick={() => setShowArchived((s) => !s)}
                            aria-expanded={showArchived}
                        >
                            <h2 className="eyebrow">Archived</h2>
                            <span className="mono muted">
                                {archived.length} · {showArchived ? "hide" : "show"}
                            </span>
                        </button>
                        {showArchived && (
                            <ul className="rows">
                                {archived.map((p) => (
                                    <li key={p.id}>
                                        <a
                                            className="row-main"
                                            href={`/o/${org.slug}/p/${p.slug}`}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                navigate(`/o/${org.slug}/p/${p.slug}`);
                                            }}
                                        >
                                            <strong>{p.name}</strong>
                                            <span className="mono muted">archived {p.archivedAt ? timeAgo(p.archivedAt) : ""}</span>
                                        </a>
                                        {mayManage && (
                                            <span className="row-actions">
                                                <button type="button" className="btn btn-sm" onClick={() => void restore(p)}>
                                                    <ArchiveRestore /> Restore
                                                </button>
                                                <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(p)}>
                                                    <Trash2 /> Delete
                                                </button>
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                )}
            </main>

            {deleting && <ConfirmDelete project={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void remove(deleting)} />}
        </div>
    );
}

// Deleting cannot be undone, so it asks for the website's name.
function ConfirmDelete({ project, onCancel, onConfirm }: { project: Project; onCancel: () => void; onConfirm: () => void }) {
    const [typed, setTyped] = useState("");
    const matches = typed.trim().toLowerCase() === project.name.trim().toLowerCase();
    return (
        <Dialog onClose={onCancel}>
            <p className="eyebrow">Delete for good</p>
            <h2>Delete {project.name}?</h2>
            <p>
                Its pages, every saved version, its content, its releases and its conversation will be removed. This cannot be undone. If
                you only want it out of the way, leave it archived.
            </p>
            <label className="field-line">
                <span className="eyebrow">Type the website's name to confirm</span>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={project.name} autoFocus />
            </label>
            <div className="dialog-actions">
                <button type="button" className="btn" onClick={onCancel}>
                    Keep it
                </button>
                <button type="button" className="btn btn-danger-solid" disabled={!matches} onClick={onConfirm}>
                    <Trash2 /> Delete forever
                </button>
            </div>
        </Dialog>
    );
}
