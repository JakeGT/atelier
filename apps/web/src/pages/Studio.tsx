import {
    Archive,
    ArchiveRestore,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ArrowUpRight,
    CloudOff,
    Ellipsis,
    Globe,
    LayoutTemplate,
    PencilLine,
    Plus,
    Trash2,
    Type,
} from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AskLevelSlider } from "../editor/Asking";
import type { Org, Project, Session, Template } from "../lib/api";
import { api, can, orgApi, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, timeAgo, useClickOutside, useDragScroll } from "../lib/hooks";
import { Cover } from "../ui/Cover";
import { Gallery } from "../ui/Gallery";
import { Dialog, Dots, useToast } from "../ui/kit";
import { StudioNav } from "../ui/StudioNav";

// Where a brief typed on the dashboard waits for the editor to pick it up.
export const FIRST_PROMPT_KEY = "atelier.first-prompt";

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

const ASK_KEPT = "atelier.askLevel";

export function Studio({ session, org, orgs, onOrgsChanged, theme, onToggleTheme }: StudioProps) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [projects, setProjects] = useState<Project[] | null>(null);
    const [archived, setArchived] = useState<Project[]>([]);
    const [showArchived, setShowArchived] = useState(false);
    const [name, setName] = useState("");
    const [brief, setBrief] = useState("");
    const [busy, setBusy] = useState(false);
    // Starter templates: a finished small website to begin from, instead of an empty page.
    const [templates, setTemplates] = useState<Template[]>([]);
    const [template, setTemplate] = useState<string | null>(null);
    // How much the assistant asks on the new website. What was chosen last is offered again.
    const [askLevel, setAskLevelState] = useState(() => {
        const kept = Number(window.localStorage.getItem(ASK_KEPT));
        return Number.isInteger(kept) && kept >= 0 && kept <= 3 && window.localStorage.getItem(ASK_KEPT) !== null ? kept : 1;
    });
    const setAskLevel = (level: number) => {
        setAskLevelState(level);
        window.localStorage.setItem(ASK_KEPT, String(level));
    };
    const loadTemplates = useCallback(() => a.templates().then(setTemplates, () => api.templates().then(setTemplates, () => {})), [a]);
    useEffect(() => {
        void loadTemplates();
    }, [loadTemplates]);
    // Looks an empty website can start in, offered beside the templates.
    const [looks, setLooks] = useState<Template[]>([]);
    useEffect(() => {
        a.design().then(
            (d) =>
                setLooks(
                    d.looks.map((l) => ({
                        id: `look:${l.id}`,
                        name: `${l.name} look`,
                        description: l.description,
                        previewUrl: l.previewUrl,
                        imageUrl: l.imageUrl,
                    })),
                ),
            () => {},
        );
    }, [a]);
    // Everything a website can start from, in the order it is offered: the studio's own
    // templates, then looks (an empty website in a finished design), then finished websites.
    const starts: (Template & { tag: string })[] = [
        ...templates.filter((t) => t.own).map((t) => ({ ...t, tag: "Your studio's" })),
        ...looks.map((t) => ({ ...t, name: t.name.replace(/ look$/, ""), tag: "A look" })),
        ...templates.filter((t) => !t.own).map((t) => ({ ...t, tag: "A finished website" })),
    ];
    const chosen = starts.find((t) => t.id === template);
    const [choosing, setChoosing] = useState(false);
    const designsRow = useDragScroll<HTMLDivElement>();
    // Saving a website as one of the studio's own starting points.
    const [saving, setSaving] = useState<Project | null>(null);
    const [templateName, setTemplateName] = useState("");
    const [templateAbout, setTemplateAbout] = useState("");
    async function saveAsTemplate(e: FormEvent) {
        e.preventDefault();
        if (!saving) return;
        setBusy(true);
        try {
            await a.saveTemplate(saving.id, templateName.trim(), templateAbout.trim());
            toast(`“${templateName.trim()}” is now a starting point for new websites in this studio.`);
            setSaving(null);
            await loadTemplates();
        } catch (err) {
            toast((err as Error).message, "error");
        } finally {
            setBusy(false);
        }
    }
    async function removeTemplate(t: Template) {
        try {
            await a.removeTemplate(t.id);
            if (template === t.id) setTemplate(null);
            toast(`“${t.name}” was removed. Websites already made from it are not affected.`);
            await loadTemplates();
        } catch (err) {
            toast((err as Error).message, "error");
        }
    }
    const [deleting, setDeleting] = useState<Project | null>(null);
    const [unpublishing, setUnpublishing] = useState<Project | null>(null);
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
            const project = await a.createProject(name.trim(), template, askLevel);
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

    async function unpublish(p: Project) {
        try {
            await a.unpublish(p.id);
            setUnpublishing(null);
            toast(`${p.name} is offline. Publish it again from the editor to bring it back.`);
            await load();
        } catch (err) {
            if (err instanceof ReauthRequired) {
                toast("Please confirm your sign-in, then unpublish again.", "error");
                setTimeout(reauthenticate, 1200);
            } else toast((err as Error).message, "error");
        }
    }

    async function archive(p: Project) {
        try {
            await a.archiveProject(p.id);
            toast(`${p.name} is archived. You can restore it from the list below.`);
            await load();
        } catch (err) {
            toast((err as Error).message, "error");
        }
    }

    async function remove(p: Project) {
        try {
            // A website is archived (stopped and frozen) before it can be deleted.
            if (!p.archivedAt) {
                await a.archiveProject(p.id);
                setDeleting({ ...p, archivedAt: new Date().toISOString() });
            }
            await a.deleteProject(p.id);
            setDeleting(null);
            toast(`${p.name} was deleted.`);
            await load();
        } catch (err) {
            if (err instanceof ReauthRequired) {
                void load();
                toast("Please confirm your sign-in, then delete again. The website is archived in the meantime.", "error");
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
                            {/* The designs and templates are shown, not hidden behind a button: a row of
                                live miniatures to pick from, with the rest one step away. */}
                            <div className="designs" role="radiogroup" aria-labelledby="designs-label">
                                <div className="designs-head">
                                    <p className="designs-label" id="designs-label">
                                        <strong>Pick a design to start from</strong>
                                        <span className="muted"> · or leave it empty and describe what you want</span>
                                    </p>
                                    {(designsRow.more.before || designsRow.more.after) && (
                                        <div className="designs-move">
                                            <span className="muted designs-hint">Drag the row, or</span>
                                            <button
                                                type="button"
                                                className="btn btn-sm"
                                                disabled={!designsRow.more.before}
                                                onClick={() => designsRow.step(-1)}
                                            >
                                                <ArrowLeft /> Back
                                            </button>
                                            <button
                                                type="button"
                                                className="btn btn-sm"
                                                disabled={!designsRow.more.after}
                                                onClick={() => designsRow.step(1)}
                                            >
                                                More <ArrowRight />
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <div className="designs-row" ref={designsRow.ref}>
                                    {[
                                        { id: "", name: "An empty page", description: "", tag: "" } as Template & { tag: string },
                                        ...starts,
                                    ].map((t) => {
                                        const id = t.id || null;
                                        return (
                                            <label key={t.id || "blank"} className={`design ${template === id ? "on" : ""}`}>
                                                <input
                                                    type="radio"
                                                    name="design"
                                                    checked={template === id}
                                                    onChange={() => setTemplate(id)}
                                                />
                                                <span className="gallery-thumb" aria-hidden="true">
                                                    {t.imageUrl ? (
                                                        <img src={t.imageUrl} alt="" loading="lazy" draggable={false} />
                                                    ) : t.previewUrl ? (
                                                        <iframe
                                                            src={t.previewUrl}
                                                            title={`${t.name}, shown small`}
                                                            sandbox=""
                                                            loading="lazy"
                                                            tabIndex={-1}
                                                        />
                                                    ) : (
                                                        <span className="gallery-blank">Empty</span>
                                                    )}
                                                </span>
                                                <span className="design-name">{t.name}</span>
                                                {t.tag && <span className="design-tag mono muted">{t.tag}</span>}
                                            </label>
                                        );
                                    })}
                                </div>
                                <button type="button" className="btn btn-sm designs-all" onClick={() => setChoosing(true)}>
                                    <LayoutTemplate /> See all {starts.length} designs and templates, larger
                                </button>
                            </div>
                            <div className="brief-asking">
                                <AskLevelSlider
                                    level={askLevel}
                                    onChange={setAskLevel}
                                    full
                                    note="For this new website. You can change it at any time under the message box in the editor."
                                />
                            </div>
                            <p className="brief-start">
                                {chosen
                                    ? `${chosen.name}: ${chosen.description} It is there the moment you open the website; then ask your assistant to make it yours.`
                                    : "Your assistant builds the first page from your description, or you start in the editor with nothing."}
                            </p>
                            <div className="brief-foot">
                                <span className="starters">
                                    <span className="starters-label">Starts from</span>
                                    <strong className="starter-chosen">{chosen ? chosen.name : "An empty page"}</strong>
                                </span>
                                <button type="submit" className="btn btn-seal" disabled={busy}>
                                    {busy ? (
                                        <Dots />
                                    ) : (
                                        <>
                                            {brief.trim() ? "Create and start building" : "Create"} <ArrowUp />
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
                                <div key={p.id} className="card" style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}>
                                    <a
                                        className="card-link"
                                        href={`/o/${org.slug}/p/${p.slug}`}
                                        onClick={(e) => {
                                            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                                            e.preventDefault();
                                            navigate(`/o/${org.slug}/p/${p.slug}`);
                                        }}
                                    >
                                        <Cover seed={p.id} label={p.name} />
                                        <div className="card-meta">
                                            <strong>{p.name}</strong>
                                            <span className="mono muted">
                                                {p.productionRef ? <span className="card-live">Live</span> : "Not published"} ·{" "}
                                                {timeAgo(p.createdAt)}
                                            </span>
                                        </div>
                                    </a>
                                    <CardMenu
                                        project={p}
                                        href={`/o/${org.slug}/p/${p.slug}`}
                                        mayManage={mayManage}
                                        onUnpublish={() => setUnpublishing(p)}
                                        onArchive={() => void archive(p)}
                                        onDelete={() => setDeleting(p)}
                                        onTemplate={() => {
                                            setTemplateName(p.name);
                                            setTemplateAbout("");
                                            setSaving(p);
                                        }}
                                    />
                                </div>
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

            {unpublishing && (
                <Dialog onClose={() => setUnpublishing(null)}>
                    <p className="eyebrow">Unpublish</p>
                    <h2>Take {unpublishing.name} offline?</h2>
                    <p>
                        Its address and any domains will stop working straight away. Your pages, versions and releases stay, and publishing
                        from the editor brings it back at the same address.
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="btn" onClick={() => setUnpublishing(null)}>
                            Keep it live
                        </button>
                        <button type="button" className="btn btn-danger-solid" onClick={() => void unpublish(unpublishing)}>
                            <CloudOff /> Take offline
                        </button>
                    </div>
                </Dialog>
            )}
            {choosing && (
                <Gallery
                    templates={templates}
                    looks={looks}
                    chosen={template}
                    mayManage={mayManage}
                    onChoose={setTemplate}
                    onRemove={(t) => void removeTemplate(t)}
                    onClose={() => setChoosing(false)}
                />
            )}
            {saving && (
                <Dialog onClose={() => setSaving(null)}>
                    <form onSubmit={saveAsTemplate}>
                        <p className="eyebrow">Save as a template</p>
                        <h2>{saving.name}</h2>
                        <p>
                            New websites in this studio can then start as a copy of this one as it is now: its pages, its wording and the
                            pictures it uses. Changing this website afterwards does not change the template.
                        </p>
                        <label className="field-line">
                            <span className="eyebrow">Name of the template</span>
                            <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} maxLength={80} required />
                        </label>
                        <label className="field-line">
                            <span className="eyebrow">What it is good for</span>
                            <input
                                value={templateAbout}
                                onChange={(e) => setTemplateAbout(e.target.value)}
                                maxLength={240}
                                placeholder="A one-page site for a restaurant, with a menu and opening hours"
                            />
                        </label>
                        <div className="dialog-actions">
                            <button type="button" className="btn" onClick={() => setSaving(null)} disabled={busy}>
                                Cancel
                            </button>
                            <button type="submit" className="btn btn-primary" disabled={busy || !templateName.trim()}>
                                {busy ? <Dots /> : "Save as a template"}
                            </button>
                        </div>
                    </form>
                </Dialog>
            )}
            {deleting && <ConfirmDelete project={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void remove(deleting)} />}
        </div>
    );
}

// The three-dot menu on a website's card.
function CardMenu({
    project,
    href,
    mayManage,
    onUnpublish,
    onArchive,
    onDelete,
    onTemplate,
}: {
    project: Project;
    href: string;
    mayManage: boolean;
    onUnpublish: () => void;
    onArchive: () => void;
    onDelete: () => void;
    onTemplate: () => void;
}) {
    const [open, setOpen] = useState(false);
    // Opens upward when there is no room below (the last row of the shelf).
    const [up, setUp] = useState(false);
    const ref = useClickOutside(useCallback(() => setOpen(false), []));
    const run = (action: () => void) => () => {
        setOpen(false);
        action();
    };
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the menu from anywhere inside it
        <div
            className={`menu-wrap card-menu ${open ? "open" : ""}`}
            ref={ref}
            onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
            }}
        >
            <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={(e) => {
                    setUp(window.innerHeight - e.currentTarget.getBoundingClientRect().bottom < 220);
                    setOpen((o) => !o);
                }}
                aria-label={`More for ${project.name}`}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                <Ellipsis /> <span>More</span>
            </button>
            {open && (
                <div className={`menu ${up ? "menu-up" : ""}`} role="menu">
                    <button type="button" role="menuitem" onClick={run(() => navigate(href))}>
                        <PencilLine /> Open in the editor
                    </button>
                    <button type="button" role="menuitem" onClick={run(() => navigate(`${href}/content`))}>
                        <Type /> Manage its content
                    </button>
                    <button type="button" role="menuitem" onClick={run(() => window.open(href, "_blank", "noopener"))}>
                        <ArrowUpRight /> Open the editor in a new tab
                    </button>
                    {project.productionRef && (
                        <a role="menuitem" href={project.productionRef} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                            <Globe /> Visit the live website
                        </a>
                    )}
                    {mayManage && (
                        <>
                            <button type="button" role="menuitem" onClick={run(onTemplate)}>
                                <LayoutTemplate /> Save as a template…
                            </button>
                            <div className="menu-rule" />
                            {project.productionRef && (
                                <button type="button" role="menuitem" onClick={run(onUnpublish)}>
                                    <CloudOff /> Unpublish…
                                </button>
                            )}
                            <button type="button" role="menuitem" onClick={run(onArchive)}>
                                <Archive /> Archive
                            </button>
                            <button type="button" role="menuitem" className="menu-danger" onClick={run(onDelete)}>
                                <Trash2 /> Delete…
                            </button>
                        </>
                    )}
                </div>
            )}
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
                you only want it out of the way, {project.archivedAt ? "leave it archived" : "archive it instead"}.
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
