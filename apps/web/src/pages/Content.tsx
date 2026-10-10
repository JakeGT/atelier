import { ArrowLeft, History, Images, Search, Type, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaLibrary, MediaProvider } from "../editor/Media";
import { documentName, fieldsOf, WordingForm } from "../editor/Wording";
import type { ContentDocument, ContentRevision, Org, Project, Session } from "../lib/api";
import { can, orgApi } from "../lib/api";
import { navigate, type Theme, timeAgo } from "../lib/hooks";
import { Dots, UserMenu, useToast, Wordmark } from "../ui/kit";

interface Props {
    project: Project;
    org: Org;
    session: Session;
    theme: Theme;
    onToggleTheme: () => void;
}

// Which page of the website a piece of wording belongs to, for the preview beside it.
const pageFile = (doc: ContentDocument): string =>
    doc.kind !== "page" || doc.slug === "home" || doc.slug === "shared" ? "" : `${doc.slug}.html`;
const unpublished = (d: ContentDocument): boolean => JSON.stringify(d.draft) !== JSON.stringify(d.published);
const order = (d: ContentDocument): string => `${d.slug === "home" ? "0" : d.slug === "shared" ? "9" : "1"}${d.slug}`;

// Everything a website says, in one place: its wording page by page, what has
// changed since it was last published, and the history of each piece. The same
// wording can be edited in the editor's side panel and by clicking it in the
// preview; this is the page for managing all of it (ADR-0014).
export function Content({ project, org, session, theme, onToggleTheme }: Props) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const pid = project.id;
    const canEdit = can.edit(org.role) && project.archivedAt === null;
    const editor = `/o/${org.slug}/p/${project.slug}`;

    const [documents, setDocuments] = useState<ContentDocument[] | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [previewKey, setPreviewKey] = useState(0);
    const [tab, setTab] = useState<"wording" | "files">("wording");

    const load = useCallback(async () => {
        try {
            const docs = [...(await a.listContent(pid))].sort((x, y) => order(x).localeCompare(order(y)));
            setDocuments(docs);
            setSelected((s) => (s && docs.some((d) => d.id === s) ? s : (docs[0]?.id ?? null)));
        } catch (err) {
            setDocuments((d) => d ?? []);
            toast((err as Error).message, "error");
        }
    }, [a, pid, toast]);

    useEffect(() => {
        void load();
        a.previewUrl(pid).then(setPreviewUrl, () => {});
    }, [a, pid, load]);

    // Stay in step with other people (and the assistant) changing this website.
    const stamp = useRef<number | null>(null);
    useEffect(() => {
        const beat = async () => {
            if (document.hidden) return;
            const pulse = await a.pulse(pid, false).catch(() => null);
            if (!pulse) return;
            if (stamp.current !== null && pulse.stamp !== stamp.current) {
                void load();
                setPreviewKey((k) => k + 1);
            }
            stamp.current = pulse.stamp;
        };
        void beat();
        const timer = setInterval(beat, 3000);
        return () => clearInterval(timer);
    }, [a, pid, load]);

    const save = async (doc: ContentDocument, draft: Record<string, unknown>) => {
        await a.saveContent(pid, doc.kind, doc.slug, draft, doc.rev);
        toast("Saved. It shows in the preview, and goes public when you publish.");
        await load();
        setPreviewKey((k) => k + 1);
    };

    const q = query.trim().toLowerCase();
    const shown = (documents ?? []).filter((d) => !q || `${documentName(d)} ${JSON.stringify(d.draft ?? {})}`.toLowerCase().includes(q));
    const doc = documents?.find((d) => d.id === selected) ?? null;
    const waiting = (documents ?? []).filter(unpublished);

    return (
        <MediaProvider a={a} projectId={pid} canEdit={canEdit}>
            <div className="content-page">
                <header className="studio-nav">
                    <div className="studio-nav-left">
                        <Wordmark />
                        <span className="nav-slash" aria-hidden="true">
                            /
                        </span>
                        <span className="org-name">{project.name}</span>
                    </div>
                    <nav className="studio-nav-right">
                        <button type="button" className="btn btn-ghost" onClick={() => navigate(editor)}>
                            <ArrowLeft /> Back to the editor
                        </button>
                        <UserMenu session={session} theme={theme} onToggleTheme={onToggleTheme} />
                    </nav>
                </header>

                <div className="content-head">
                    <p className="eyebrow">{project.name}</p>
                    <h1 className="display">
                        Its <em>content.</em>
                    </h1>
                    <p className="muted">
                        The words and pictures on your website. Change them here and the preview shows it at once; they go public the next
                        time you publish.
                    </p>
                    {waiting.length > 0 && (
                        <p className="content-waiting">
                            <span className="chip chip-draft">Not published yet</span>
                            {waiting.map((d) => documentName(d)).join(", ")}.{" "}
                            <button type="button" className="link" onClick={() => navigate(editor)}>
                                Go to the editor to publish
                            </button>
                        </p>
                    )}
                </div>

                <div className="tabs content-tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === "wording"}
                        className={tab === "wording" ? "on" : ""}
                        onClick={() => setTab("wording")}
                    >
                        <Type /> Wording
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === "files"}
                        className={tab === "files" ? "on" : ""}
                        onClick={() => setTab("files")}
                    >
                        <Images /> Pictures and files
                    </button>
                </div>

                {tab === "files" ? (
                    <div className="content-files">
                        <MediaLibrary />
                    </div>
                ) : documents === null ? (
                    <div className="panel-loading">
                        <Dots />
                    </div>
                ) : documents.length === 0 ? (
                    <div className="content-empty">
                        <h2 className="display">No wording to manage yet.</h2>
                        <p className="muted">
                            Wording appears here once your assistant has made it editable. In the editor, ask: "Make the wording on this
                            website editable."
                        </p>
                        <button type="button" className="btn btn-primary" onClick={() => navigate(editor)}>
                            <ArrowLeft /> Back to the editor
                        </button>
                    </div>
                ) : (
                    <div className="content-body">
                        <nav className="content-list" aria-label="Pages">
                            <label className="content-search">
                                <Search />
                                <input
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder="Search all wording"
                                    aria-label="Search all wording"
                                />
                            </label>
                            <ul>
                                {shown.map((d) => (
                                    <li key={d.id}>
                                        <button type="button" className={d.id === selected ? "on" : ""} onClick={() => setSelected(d.id)}>
                                            <strong>{documentName(d)}</strong>
                                            <span className="muted">
                                                {fieldsOf(d).length} {fieldsOf(d).length === 1 ? "piece" : "pieces"}
                                                {unpublished(d) ? " · not published yet" : ""}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                            {shown.length === 0 && <p className="muted content-none">Nothing matches “{query.trim()}”.</p>}
                        </nav>

                        <section className="content-edit">
                            {doc ? (
                                <>
                                    <h2 className="display">{documentName(doc)}</h2>
                                    <WordingForm key={doc.id} doc={doc} canEdit={canEdit} onSave={save} />
                                    <Past a={a} pid={pid} doc={doc} canEdit={canEdit} onRestored={load} />
                                </>
                            ) : (
                                <p className="muted">Choose a page on the left.</p>
                            )}
                        </section>

                        <aside className="content-preview" aria-label="Preview">
                            <p className="eyebrow">Preview · private</p>
                            {previewUrl && doc ? (
                                <iframe
                                    key={`${previewKey}:${doc.id}`}
                                    src={`${previewUrl}${pageFile(doc)}`}
                                    title="Preview of this page"
                                    sandbox="allow-scripts allow-forms allow-popups allow-modals"
                                />
                            ) : (
                                <div className="content-preview-empty muted">The preview appears here.</div>
                            )}
                        </aside>
                    </div>
                )}
            </div>
        </MediaProvider>
    );
}

// Earlier versions of one piece of wording, and a way back to any of them.
function Past({
    a,
    pid,
    doc,
    canEdit,
    onRestored,
}: {
    a: ReturnType<typeof orgApi>;
    pid: string;
    doc: ContentDocument;
    canEdit: boolean;
    onRestored: () => Promise<void>;
}) {
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [revisions, setRevisions] = useState<ContentRevision[] | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the document or its revision changes
    useEffect(() => {
        if (!open) return;
        a.contentHistory(pid, doc.kind, doc.slug).then(setRevisions, () => setRevisions([]));
    }, [open, doc.id, doc.rev]);

    const restore = async (rev: number) => {
        try {
            await a.restoreContent(pid, doc.kind, doc.slug, rev);
            toast("That earlier wording is back. The wording you replaced is still in this list.");
            await onRestored();
        } catch (err) {
            toast((err as Error).message, "error");
        }
    };
    const summary = (r: ContentRevision): string => {
        const first = Object.values(r.draft ?? {}).find((v) => typeof v === "string" && v.trim()) as string | undefined;
        return first ? (first.length > 70 ? `${first.slice(0, 70)}…` : first) : "(no text)";
    };

    return (
        <div className="content-past">
            <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <History /> {open ? "Hide earlier versions" : "Show earlier versions of this wording"}
            </button>
            {open &&
                (revisions === null ? (
                    <Dots />
                ) : revisions.length <= 1 ? (
                    <p className="muted">There is only one version so far.</p>
                ) : (
                    <ol className="rows rows-quiet">
                        {revisions.map((r) => (
                            <li key={r.rev}>
                                <span className="row-main">
                                    <strong>{summary(r)}</strong>
                                    <span className="mono muted">{timeAgo(r.createdAt)}</span>
                                </span>
                                <span className="row-actions">
                                    {r.rev === doc.rev ? (
                                        <span className="chip chip-seal">What you see now</span>
                                    ) : (
                                        canEdit && (
                                            <button type="button" className="btn btn-sm" onClick={() => void restore(r.rev)}>
                                                <Undo2 /> Go back to this
                                            </button>
                                        )
                                    )}
                                </span>
                            </li>
                        ))}
                    </ol>
                ))}
        </div>
    );
}
