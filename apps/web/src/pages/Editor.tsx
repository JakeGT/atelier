import { ArrowLeft, Eye, History, MessageSquare, PanelRight, Rocket } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chat, type Message } from "../editor/Chat";
import { type Device, Preview } from "../editor/Preview";
import { Sidebar, type Tab } from "../editor/Sidebar";
import type { AgentSession, Checkpoint, ContentDocument, Overview, Project, Release, Run, Session } from "../lib/api";
import { ApiError, api, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, useStored } from "../lib/hooks";
import { Dialog, Dots, ThemeToggle, UserMenu, useToast } from "../ui/kit";
import { FIRST_PROMPT_KEY } from "./Studio";

type Pane = "chat" | "preview" | "side";

const newId = () => crypto.randomUUID();

interface EditorProps {
    project: Project;
    session: Session;
    canPublish: boolean;
    theme: Theme;
    onToggleTheme: () => void;
}

export function Editor({ project, session, canPublish, theme, onToggleTheme }: EditorProps) {
    const toast = useToast();
    const pid = project.id;

    const [agent, setAgent] = useState<AgentSession | null>(null);
    const [starting, setStarting] = useState(true);
    // The conversation is project data, loaded from the server. `pending` holds a
    // message shown the moment it is sent, until the server's copy replaces it.
    const [messages, setMessages] = useState<Message[] | null>(null);
    const [pending, setPending] = useState<Message[]>([]);
    const [activeRun, setActiveRun] = useState<Run | null>(null);

    const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
    const [releases, setReleases] = useState<Release[]>([]);
    const [documents, setDocuments] = useState<ContentDocument[]>([]);
    const [overview, setOverview] = useState<Overview | null>(null);

    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [device, setDevice] = useStored<Device>("atelier.device", "desktop");
    const [tab, setTab] = useState<Tab>("versions");
    const [sideOpen, setSideOpen] = useStored("atelier.side", true);
    const [pane, setPane] = useState<Pane>("chat");

    const [acting, setActing] = useState(false);
    const [confirmPublish, setConfirmPublish] = useState(false);
    const [needsReauth, setNeedsReauth] = useState(false);

    const loadThread = useCallback(async () => {
        try {
            const thread = await api.thread(pid);
            setMessages(thread.messages);
            setPending([]);
            setActiveRun(thread.activeRun);
        } catch {
            setMessages((m) => m ?? []);
        }
    }, [pid]);

    const note = useCallback((role: Message["role"], text: string) => {
        setPending((prev) => [...prev, { id: newId(), role, text, tools: null }]);
    }, []);

    // ---- data ------------------------------------------------------------------------

    const refresh = useCallback(async () => {
        const [cps, rels, docs, ov] = await Promise.all([
            api.listCheckpoints(pid).catch(() => [] as Checkpoint[]),
            api.listReleases(pid).catch(() => [] as Release[]),
            api.listContent(pid).catch(() => [] as ContentDocument[]),
            api.overview(pid).catch(() => null),
        ]);
        setCheckpoints(cps);
        setReleases([...rels].reverse());
        setDocuments(docs);
        setOverview(ov);
    }, [pid]);

    const reloadPreview = useCallback(() => {
        // A fresh signed link on every reload (they expire after two hours).
        api.previewUrl(pid)
            .then((url) => {
                setPreviewUrl(url);
                setReloadKey((k) => k + 1);
            })
            .catch(() => setPreviewUrl(null));
    }, [pid]);

    const openWorkspace = useCallback(async () => {
        setStarting(true);
        try {
            const sessions = await api.listSessions(pid);
            const s = sessions.find((x) => x.status === "ready") ?? (await api.createSession(pid));
            setAgent(s.status === "ready" ? s : null);
            if (s.status !== "ready") toast("The workspace didn't start. Try again in a moment.", "error");
        } catch (err) {
            toast((err as Error).message, "error");
        } finally {
            setStarting(false);
        }
    }, [pid, toast]);

    useEffect(() => {
        void loadThread();
        void openWorkspace().then(() => {
            void refresh();
            reloadPreview();
        });
    }, [openWorkspace, refresh, reloadPreview, loadThread]);

    // ---- runs: start, then poll until done ---------------------------------------------

    const send = useCallback(
        async (prompt: string) => {
            if (!agent || activeRun) return;
            note("user", prompt);
            try {
                setActiveRun(await api.startRun(pid, agent.id, prompt));
            } catch (err) {
                note("error", (err as Error).message);
            }
        },
        [agent, activeRun, note, pid],
    );

    const runId = activeRun?.id ?? null;
    useEffect(() => {
        if (!runId) return;
        let stopped = false;
        let misses = 0;
        const finish = () => {
            // The server has stored the reply; reload the thread and everything it may have changed.
            void loadThread();
            void refresh();
            reloadPreview();
        };
        const tick = async () => {
            try {
                const run = await api.getRun(pid, runId);
                misses = 0;
                if (!stopped && run.status !== "running") finish();
            } catch (err) {
                // The run is gone (workspace restarted) or the network is flaky: give it a few tries.
                misses++;
                if (!stopped && (misses >= 5 || (err instanceof ApiError && err.status === 404))) finish();
            }
        };
        const timer = setInterval(tick, 1500);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [runId, pid, loadThread, refresh, reloadPreview]);

    // A brief typed on the dashboard becomes the first message, once the workspace is ready.
    const sentFirst = useRef(false);
    useEffect(() => {
        if (!agent || sentFirst.current) return;
        const raw = sessionStorage.getItem(FIRST_PROMPT_KEY);
        if (!raw) return;
        try {
            const first = JSON.parse(raw) as { projectId: string; prompt: string };
            if (first.projectId !== pid) return;
            sentFirst.current = true;
            sessionStorage.removeItem(FIRST_PROMPT_KEY);
            void send(first.prompt);
        } catch {
            sessionStorage.removeItem(FIRST_PROMPT_KEY);
        }
    }, [agent, pid, send]);

    // ---- actions -----------------------------------------------------------------------

    async function act(fn: () => Promise<string>) {
        setActing(true);
        try {
            toast(await fn());
            await refresh();
        } catch (err) {
            if (err instanceof ReauthRequired) setNeedsReauth(true);
            else toast((err as Error).message, "error");
        } finally {
            setActing(false);
        }
    }

    const restore = (sha: string) =>
        act(async () => {
            await api.restoreCheckpoint(pid, sha);
            reloadPreview();
            return "Restored. The version you left is still in the list.";
        });

    const rollback = (number: number) =>
        act(async () => {
            const r = await api.rollback(pid, number);
            return `Rolled back. Release ${r.number} is live.`;
        });

    const publish = () => {
        setConfirmPublish(false);
        return act(async () => {
            const r = await api.publish(pid);
            setTab("releases");
            return `Release ${r.number} is live.`;
        });
    };

    const saveDocument = async (doc: ContentDocument, draft: Record<string, unknown>) => {
        await api.saveContent(pid, doc.kind, doc.slug, draft);
        toast("Draft saved.");
        await refresh();
    };

    // ---- render ------------------------------------------------------------------------

    const running = activeRun !== null;
    const live = overview?.liveRelease ?? null;
    const hasChanges = overview?.hasChanges ?? false;
    const nothingToPublish = overview !== null && !hasChanges;

    return (
        <div className={`editor pane-${pane} ${sideOpen ? "side-open" : ""}`}>
            <header className="editor-bar">
                <div className="editor-bar-left">
                    <button type="button" className="btn btn-ghost btn-icon" onClick={() => navigate("/")} title="All websites">
                        <ArrowLeft />
                    </button>
                    <h1 className="display">{project.name}</h1>
                    {live ? (
                        hasChanges ? (
                            <span className="chip chip-draft">Unpublished changes</span>
                        ) : (
                            <span className="chip chip-live">Live · release {live.number}</span>
                        )
                    ) : (
                        <span className="chip chip-plain">Not published</span>
                    )}
                </div>
                <div className="editor-bar-right">
                    <ThemeToggle theme={theme} onToggle={onToggleTheme} />
                    <button
                        type="button"
                        className={`btn btn-ghost btn-icon side-toggle ${sideOpen ? "on" : ""}`}
                        onClick={() => setSideOpen((o) => !o)}
                        title="Versions, releases and content"
                    >
                        <PanelRight />
                    </button>
                    {canPublish && (
                        <button
                            type="button"
                            className="btn btn-seal"
                            onClick={() => setConfirmPublish(true)}
                            disabled={acting || running || nothingToPublish || checkpoints.length + documents.length === 0}
                            title={nothingToPublish ? "Everything is already live" : "Publish this version"}
                        >
                            {acting ? <Dots /> : <Rocket />} Publish
                        </button>
                    )}
                    <UserMenu session={session} />
                </div>
            </header>

            <div className="editor-body">
                <Chat
                    messages={[...(messages ?? []), ...pending]}
                    loading={messages === null}
                    runningSince={activeRun?.startedAt ?? null}
                    ready={agent !== null}
                    starting={starting}
                    onSend={(p) => void send(p)}
                    onRetryWorkspace={() => void openWorkspace()}
                />
                <Preview
                    slug={project.slug}
                    url={previewUrl}
                    reloadKey={reloadKey}
                    device={device}
                    onDevice={setDevice}
                    onReload={reloadPreview}
                    hasPage={checkpoints.length > 0}
                    working={running}
                />
                <Sidebar
                    tab={tab}
                    onTab={setTab}
                    checkpoints={checkpoints}
                    releases={releases}
                    documents={documents}
                    busy={acting || running}
                    canPublish={canPublish}
                    onRestore={(sha) => void restore(sha)}
                    onRollback={(n) => void rollback(n)}
                    onSaveDocument={saveDocument}
                />
            </div>

            <nav className="pane-switch" aria-label="Editor panes">
                {(
                    [
                        ["chat", "Chat", MessageSquare],
                        ["preview", "Preview", Eye],
                        ["side", "History", History],
                    ] as const
                ).map(([id, label, Icon]) => (
                    <button key={id} type="button" className={pane === id ? "on" : ""} onClick={() => setPane(id)}>
                        <Icon />
                        {label}
                    </button>
                ))}
            </nav>

            {confirmPublish && (
                <Dialog onClose={() => setConfirmPublish(false)}>
                    <p className="eyebrow">Release {(releases[0]?.number ?? 0) + 1}</p>
                    <h2>Publish this version?</h2>
                    <p>This makes your current design and content the live website. You can roll back at any time.</p>
                    <ul className="manifest">
                        <li>
                            <span>Design</span>
                            <span className="mono">
                                {overview?.head ? overview.head.slice(0, 7) : "none yet"}
                                {overview?.codeChanged ? " · changed" : ""}
                            </span>
                        </li>
                        <li>
                            <span>Content</span>
                            <span className="mono">
                                {overview?.documents ?? 0} {overview?.documents === 1 ? "document" : "documents"}
                                {overview?.changedDocuments ? ` · ${overview.changedDocuments} changed` : ""}
                            </span>
                        </li>
                        <li>
                            <span>Replaces</span>
                            <span className="mono">{live ? `release ${live.number}` : "nothing (first release)"}</span>
                        </li>
                    </ul>
                    <div className="dialog-actions">
                        <button type="button" className="btn" onClick={() => setConfirmPublish(false)}>
                            Not yet
                        </button>
                        <button type="button" className="btn btn-seal" onClick={() => void publish()}>
                            <Rocket /> Publish
                        </button>
                    </div>
                </Dialog>
            )}

            {needsReauth && (
                <Dialog onClose={() => setNeedsReauth(false)}>
                    <p className="eyebrow">One more step</p>
                    <h2>Confirm it's you.</h2>
                    <p>
                        Publishing changes what the world sees, so we ask you to sign in again if it has been a while. Your work is saved.
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="btn" onClick={() => setNeedsReauth(false)}>
                            Cancel
                        </button>
                        <button type="button" className="btn btn-primary" onClick={reauthenticate}>
                            Sign in again
                        </button>
                    </div>
                </Dialog>
            )}
        </div>
    );
}
