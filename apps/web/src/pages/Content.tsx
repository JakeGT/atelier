import { ArrowLeft, Crosshair, History, Images, Search, Type, Undo2, Unlink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MediaLibrary, MediaProvider } from "../editor/Media";
import { countPieces, documentName, fieldsOf, WordingForm } from "../editor/Wording";
import type { ContentDocument, ContentRevision, Org, Project, Session, SitePage } from "../lib/api";
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

const unpublished = (d: ContentDocument): boolean => JSON.stringify(d.draft) !== JSON.stringify(d.published);
const order = (d: ContentDocument): string => `${d.slug === "home" ? "0" : d.slug === "shared" ? "9" : "1"}${d.kind}${d.slug}`;
const refOf = (d: Pick<ContentDocument, "kind" | "slug">, field: string): string => `${d.kind}/${d.slug}#${field}`;
const REF = /^([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})#([A-Za-z][\w-]{0,63})$/;

// "index.html" -> "Home page"; "about.html" -> "About page"; "blog/first.html" -> "Blog / first page".
export function pageName(path: string): string {
    if (path === "index.html") return "Home page";
    const stem = path
        .replace(/\.html?$/i, "")
        .replace(/\/index$/, "")
        .replace(/[-_]+/g, " ")
        .replace(/\//g, " / ");
    return `${stem.charAt(0).toUpperCase()}${stem.slice(1)} page`;
}

// The request that connects older wording to the pages. Shown to the person before it is sent.
const CONNECT_REQUEST =
    "Connect all of this website's saved wording to its pages, so I can edit it myself on the Content page. Keep every word and the design exactly as they are. Give every piece a plain label and mark where it appears on each page.";

// The request that makes the rest of a page editable.
const EDITABLE_REQUEST =
    "Some text on this website cannot be edited on the Content page yet. Run your content check, connect every piece of text and every picture it lists so that I can edit them myself, and give each a plain label. Keep every word and the design exactly as they are.";

// The request that gives older wording proper labels.
const LABEL_REQUEST =
    "Describe every piece of this website's saved wording so it is easy for me to edit: give each one a plain label, the right type, and a line saying where it appears. Do not change any wording or any page.";

// Everything a website says, in one place. Each piece of wording has a plain
// label and says where on the website it appears; choosing it shows that place
// in the preview beside it, and clicking something in the preview finds its
// field. Wording that no page shows is said to be so, plainly, with the way to
// fix it. (ADR-0014)
export function Content({ project, org, session, theme, onToggleTheme }: Props) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const pid = project.id;
    const canEdit = can.edit(org.role) && project.archivedAt === null;
    const editor = `/o/${org.slug}/p/${project.slug}`;

    const [documents, setDocuments] = useState<ContentDocument[] | null>(null);
    const [pages, setPages] = useState<SitePage[] | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [field, setField] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [previewKey, setPreviewKey] = useState(0);
    const [page, setPage] = useState("index.html");
    const [tab, setTab] = useState<"wording" | "files">("wording");

    const load = useCallback(async () => {
        try {
            const [docs, map] = await Promise.all([a.listContent(pid), a.contentMap(pid).catch(() => [] as SitePage[])]);
            const sorted = [...docs].sort((x, y) => order(x).localeCompare(order(y)));
            setDocuments(sorted);
            setPages(map);
            setSelected((s) => (s && sorted.some((d) => d.id === s) ? s : (sorted[0]?.id ?? null)));
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

    // Which pages show a piece of wording.
    const pagesOf = useCallback((ref: string): SitePage[] => (pages ?? []).filter((p) => p.refs.includes(ref)), [pages]);
    const connected = useCallback(
        (d: ContentDocument): number => fieldsOf(d).filter((f) => pagesOf(refOf(d, f.key)).length > 0).length,
        [pagesOf],
    );

    // ---- the preview beside the fields -----------------------------------------------------
    const frame = useRef<HTMLIFrameElement>(null);
    // What to point at once the page that shows it has loaded.
    const wanted = useRef<string | null>(null);
    const tell = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ atelierPreview: 1, ...message }, "*");
    const pageRef = useRef(page);
    pageRef.current = page;

    const showWhere = (ref: string) => {
        const on = pagesOf(ref);
        if (on.length === 0) return;
        // Stay on the page being looked at if it shows this; otherwise go to the first that does.
        const target = on.find((p) => p.path === pageRef.current) ?? on[0];
        if (!target) return;
        if (target.path === pageRef.current) tell({ highlight: ref });
        else {
            wanted.current = ref;
            setPage(target.path);
        }
    };

    const state = useRef({ documents, canEdit });
    state.current = { documents, canEdit };
    // biome-ignore lint/correctness/useExhaustiveDependencies: the handlers read the latest state through refs
    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            if (e.source !== frame.current?.contentWindow) return;
            // What the page says is untrusted: only well-formed references and short strings are acted on.
            const data = e.data as { atelierPreview?: unknown; path?: unknown; picked?: unknown; open?: unknown; change?: unknown } | null;
            if (data?.atelierPreview !== 1) return;
            if (typeof data.path === "string" && data.path.length < 300) {
                // Each page that arrives outlines what can be edited, and is asked for what was wanted.
                tell({ edit: true });
                if (wanted.current) tell({ highlight: wanted.current });
                wanted.current = null;
                if (data.path !== pageRef.current && /^[\w./-]+$/.test(data.path)) setPage(data.path);
                return;
            }
            const picked = typeof data.picked === "string" ? data.picked : typeof data.open === "string" ? data.open : null;
            const change = data.change as { ref?: unknown; value?: unknown } | undefined;
            const ref = picked ?? (typeof change?.ref === "string" ? change.ref : null);
            const m = ref ? REF.exec(ref) : null;
            if (!m) return;
            const doc = state.current.documents?.find((d) => d.kind === m[1] && d.slug === m[2]);
            if (!doc) return;
            setSelected(doc.id);
            setField(m[3] ?? null);
            // Text typed straight into the page is saved like any other edit.
            if (
                change &&
                typeof change.value === "string" &&
                change.value.length <= 5000 &&
                state.current.canEdit &&
                doc.draft?.[m[3] ?? ""] !== change.value
            ) {
                void save(doc, { ...(doc.draft ?? {}), [m[3] ?? ""]: change.value });
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

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
    const loose = (documents ?? []).filter((d) => connected(d) < fieldsOf(d).length);
    const askToConnect = () => navigate(`${editor}?ask=${encodeURIComponent(CONNECT_REQUEST)}`);
    // Pages with text a visitor can read that nobody can edit here.
    const patchy = (pages ?? []).filter((p) => p.loose > 0);
    const looseCount = patchy.reduce((n, p) => n + p.loose, 0);
    // Wording whose names were worked out from how it is stored, rather than given by the assistant.
    const unlabelled = (documents ?? []).filter((d) => !d.fields?.length && fieldsOf(d).length > 0);

    // Choosing a section shows a page it is on.
    const choose = (d: ContentDocument) => {
        setSelected(d.id);
        setField(null);
        // A page that shows it; failing that, for a page's wording, the page of that name.
        const guess = d.kind === "page" ? (d.slug === "home" ? "index.html" : `${d.slug}.html`) : null;
        const first =
            fieldsOf(d)
                .map((f) => pagesOf(refOf(d, f.key))[0])
                .find(Boolean) ?? (pages ?? []).find((p) => p.path === guess);
        if (first && first.path !== pageRef.current) setPage(first.path);
    };
    const docPages = doc
        ? [
              ...new Map(
                  fieldsOf(doc)
                      .flatMap((f) => pagesOf(refOf(doc, f.key)))
                      .map((p) => [p.path, p]),
              ).values(),
          ]
        : [];
    const docConnected = doc ? connected(doc) : 0;
    const docTotal = doc ? fieldsOf(doc).length : 0;

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
                        The words and pictures on your website. Choose a piece to see where it appears; change it and the preview shows it
                        at once. Changes go public the next time you publish.
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
                    <>
                        {pages !== null && loose.length > 0 && (
                            <div className="content-loose" role="status">
                                <Unlink />
                                <div>
                                    <strong>
                                        {loose.length === documents.length && documents.every((d) => connected(d) === 0)
                                            ? "This wording is not connected to your website yet."
                                            : "Some of this wording is not connected to your website yet."}
                                    </strong>
                                    <p>
                                        It was saved, but no page is set up to show it, so changing it here will not change the website.
                                        Your assistant can connect it: every word stays as it is, and each piece is linked to the place it
                                        appears. Pieces that are not connected are marked below.
                                    </p>
                                </div>
                                {canEdit && (
                                    <button type="button" className="btn btn-primary" onClick={askToConnect}>
                                        Ask my assistant to connect it
                                    </button>
                                )}
                            </div>
                        )}
                        {loose.length === 0 && looseCount > 0 && (
                            <div className="content-loose" role="status">
                                <Unlink />
                                <div>
                                    <strong>
                                        {looseCount} {looseCount === 1 ? "piece" : "pieces"} of text on your website cannot be edited here
                                        yet.
                                    </strong>
                                    <p>
                                        Your assistant did not connect everything on{" "}
                                        {patchy.length === 1
                                            ? `the ${pageName(patchy[0]?.path ?? "").toLowerCase()}`
                                            : `${patchy.length} pages`}
                                        . For example:{" "}
                                        {patchy
                                            .flatMap((p) =>
                                                p.examples.map(
                                                    (e) =>
                                                        `“${e.text.length > 44 ? `${e.text.slice(0, 44)}…` : e.text}” (${pageName(p.path)})`,
                                                ),
                                            )
                                            .slice(0, 4)
                                            .join(", ")}
                                        . It can finish the job without changing a word.
                                    </p>
                                </div>
                                {canEdit && (
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={() => navigate(`${editor}?ask=${encodeURIComponent(EDITABLE_REQUEST)}`)}
                                    >
                                        Ask my assistant to make them editable
                                    </button>
                                )}
                            </div>
                        )}
                        {loose.length === 0 && looseCount === 0 && unlabelled.length > 0 && (
                            <div className="content-loose content-quiet" role="status">
                                <Type />
                                <div>
                                    <strong>The names of these pieces were worked out automatically.</strong>
                                    <p>
                                        They come from how the wording was saved, so some may be vague ("Title", "Intro"). Your assistant
                                        can give each one a clearer name and a line saying what it is. No wording or page is changed.
                                    </p>
                                </div>
                                {canEdit && (
                                    <button
                                        type="button"
                                        className="btn"
                                        onClick={() => navigate(`${editor}?ask=${encodeURIComponent(LABEL_REQUEST)}`)}
                                    >
                                        Ask my assistant to name them
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="content-body">
                            <nav className="content-list" aria-label="Sections of wording">
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
                                    {shown.map((d) => {
                                        const n = countPieces(d);
                                        const none = pages !== null && connected(d) === 0;
                                        return (
                                            <li key={d.id}>
                                                <button type="button" className={d.id === selected ? "on" : ""} onClick={() => choose(d)}>
                                                    <strong>{documentName(d)}</strong>
                                                    <span className="muted">
                                                        {n} {n === 1 ? "piece" : "pieces"}
                                                        {none ? " · not on the website yet" : unpublished(d) ? " · not published yet" : ""}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                                {shown.length === 0 && <p className="muted content-none">Nothing matches “{query.trim()}”.</p>}
                            </nav>

                            <section className="content-edit">
                                {doc ? (
                                    <>
                                        <h2 className="display">{documentName(doc)}</h2>
                                        {pages !== null && (
                                            <p className="content-on">
                                                {docPages.length === 0 ? (
                                                    <span className="chip chip-plain">Not shown on any page yet</span>
                                                ) : (
                                                    <>
                                                        Appears on:{" "}
                                                        {docPages.map((p) => (
                                                            <button
                                                                key={p.path}
                                                                type="button"
                                                                className={`btn btn-sm ${p.path === page ? "btn-primary" : ""}`}
                                                                onClick={() => setPage(p.path)}
                                                            >
                                                                {pageName(p.path)}
                                                            </button>
                                                        ))}
                                                        {docConnected < docTotal && (
                                                            <span className="muted">
                                                                {" "}
                                                                · {docTotal - docConnected} of its {docTotal} pieces{" "}
                                                                {docTotal - docConnected === 1 ? "is" : "are"} not on the website yet
                                                            </span>
                                                        )}
                                                    </>
                                                )}
                                            </p>
                                        )}
                                        <WordingForm
                                            key={doc.id}
                                            doc={doc}
                                            canEdit={canEdit}
                                            onSave={save}
                                            focus={field}
                                            onField={(key) => {
                                                if (key === field) return;
                                                setField(key);
                                                showWhere(refOf(doc, key));
                                            }}
                                            where={(key) => {
                                                if (pages === null) return null;
                                                const on = pagesOf(refOf(doc, key));
                                                return on.length === 0 ? (
                                                    <span
                                                        className="where where-none"
                                                        title="No page is set up to show this, so changing it will not change the website"
                                                    >
                                                        <Unlink /> Not on the website yet
                                                    </span>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="where"
                                                        onClick={() => showWhere(refOf(doc, key))}
                                                        title="Show this in the preview"
                                                    >
                                                        <Crosshair /> Show me where · {on.map((p) => pageName(p.path)).join(", ")}
                                                    </button>
                                                );
                                            }}
                                        />
                                        <Past a={a} pid={pid} doc={doc} canEdit={canEdit} onRestored={load} />
                                    </>
                                ) : (
                                    <p className="muted">Choose a section on the left.</p>
                                )}
                            </section>

                            <aside className="content-preview" aria-label="Preview">
                                <p className="eyebrow">Preview · {pageName(page)} · private</p>
                                {(pages ?? []).length > 1 && (
                                    <div className="content-pages">
                                        {(pages ?? []).slice(0, 12).map((p) => (
                                            <button
                                                key={p.path}
                                                type="button"
                                                className={`btn btn-sm ${p.path === page ? "btn-primary" : ""}`}
                                                onClick={() => setPage(p.path)}
                                            >
                                                {pageName(p.path)}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {previewUrl ? (
                                    <iframe
                                        ref={frame}
                                        key={`${previewKey}:${page}`}
                                        src={`${previewUrl}${page === "index.html" ? "" : page}`}
                                        title={`Preview of the ${pageName(page)}`}
                                        sandbox="allow-scripts allow-forms allow-popups allow-modals"
                                    />
                                ) : (
                                    <div className="content-preview-empty muted">The preview appears here.</div>
                                )}
                                <p className="muted content-preview-hint">
                                    Outlined parts of the page can be edited. Click one to find it on the left, or type straight into a line
                                    of text.
                                </p>
                            </aside>
                        </div>
                    </>
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
