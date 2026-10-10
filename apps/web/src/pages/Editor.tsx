import {
    ArrowLeft,
    ArrowUpRight,
    Check,
    Copy,
    Eye,
    Globe,
    History,
    MessageSquare,
    PanelRight,
    Rocket,
    SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Address } from "../editor/Address";
import { Chat, type Message } from "../editor/Chat";
import { type Device, Preview } from "../editor/Preview";
import { ProjectSettings } from "../editor/ProjectSettings";
import { Sidebar, type Tab } from "../editor/Sidebar";
import type { AgentSession, Checkpoint, ContentDocument, Org, Overview, Project, Release, Run, Session } from "../lib/api";
import { ApiError, can, orgApi, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, useStored } from "../lib/hooks";
import { Dialog, Dots, ThemeToggle, UserMenu, useToast } from "../ui/kit";
import { FIRST_PROMPT_KEY } from "./Studio";

type Pane = "chat" | "preview" | "side";

// What the person was doing when they were asked to confirm their sign-in.
type Intent = { action: "publish" } | { action: "rollback"; number: number };
const INTENT_KEY = "atelier.resume";
const INTENT_TTL_MS = 10 * 60_000;

const newId = () => crypto.randomUUID();

interface EditorProps {
    project: Project;
    org: Org;
    session: Session;
    onProjectChanged: (project: Project) => void;
    theme: Theme;
    onToggleTheme: () => void;
}

export function Editor({ project, org, session, onProjectChanged, theme, onToggleTheme }: EditorProps) {
    const toast = useToast();
    const pid = project.id;
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    // An archived website is frozen for everyone; otherwise the role decides.
    const archived = project.archivedAt !== null;
    const mayEdit = can.edit(org.role) && !archived;
    const canPublish = can.publish(org.role) && !archived;
    const mayManage = can.manage(org.role);
    const [settingsOpen, setSettingsOpen] = useState(false);

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
    const [addressOpen, setAddressOpen] = useState(false);
    const [published, setPublished] = useState<{ number: number; url: string } | null>(null);
    const [pendingIntent, setPendingIntent] = useState<Intent | null>(null);

    const loadThread = useCallback(async () => {
        try {
            const thread = await a.thread(pid);
            setMessages(thread.messages);
            setPending([]);
            setActiveRun(thread.activeRun);
        } catch {
            setMessages((m) => m ?? []);
        }
    }, [a, pid]);

    const note = useCallback((role: Message["role"], text: string) => {
        setPending((prev) => [...prev, { id: newId(), role, text, tools: null }]);
    }, []);

    // ---- data ------------------------------------------------------------------------

    const refresh = useCallback(async () => {
        const [cps, rels, docs, ov] = await Promise.all([
            a.listCheckpoints(pid).catch(() => [] as Checkpoint[]),
            a.listReleases(pid).catch(() => [] as Release[]),
            a.listContent(pid).catch(() => [] as ContentDocument[]),
            a.overview(pid).catch(() => null),
        ]);
        setCheckpoints(cps);
        setReleases([...rels].reverse());
        setDocuments(docs);
        setOverview(ov);
    }, [a, pid]);

    const reloadPreview = useCallback(() => {
        // A fresh signed link on every reload (they expire after two hours).
        a.previewUrl(pid)
            .then((url) => {
                setPreviewUrl(url);
                setReloadKey((k) => k + 1);
            })
            .catch(() => setPreviewUrl(null));
    }, [a, pid]);

    const openWorkspace = useCallback(async () => {
        // An archived website has no running workspace: it can be read, not worked on.
        if (archived) {
            setStarting(false);
            return;
        }
        setStarting(true);
        try {
            const sessions = await a.listSessions(pid);
            const s = sessions.find((x) => x.status === "ready") ?? (await a.createSession(pid));
            setAgent(s.status === "ready" ? s : null);
            if (s.status !== "ready") toast("The workspace didn't start. Try again in a moment.", "error");
        } catch (err) {
            toast((err as Error).message, "error");
        } finally {
            setStarting(false);
        }
    }, [a, pid, toast, archived]);

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
                setActiveRun(await a.startRun(pid, agent.id, prompt));
            } catch (err) {
                note("error", (err as Error).message);
            }
        },
        [a, agent, activeRun, note, pid],
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
                const run = await a.getRun(pid, runId);
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
    }, [a, runId, pid, loadThread, refresh, reloadPreview]);

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

    // Privileged actions (publish, roll back) may need a fresh sign-in. That is a
    // full-page trip to the identity provider, so the action is remembered and
    // finished automatically on return, instead of leaving the person to redo it.
    async function act(fn: () => Promise<string>, intent?: Intent, resuming = false) {
        setActing(true);
        try {
            const message = await fn();
            if (message) toast(message);
            await refresh();
        } catch (err) {
            if (!(err instanceof ReauthRequired)) toast((err as Error).message, "error");
            else if (resuming) {
                // We have just been to the provider and it still isn't enough: say so rather than loop.
                toast("We couldn't confirm it's you, so nothing was published. Sign out and in again, then retry.", "error");
            } else {
                setPendingIntent(intent ?? null);
            }
        } finally {
            setActing(false);
        }
    }

    const restore = (sha: string) =>
        act(async () => {
            await a.restoreCheckpoint(pid, sha);
            reloadPreview();
            return "Restored. The version you left is still in the list.";
        });

    const rollback = (number: number, resuming = false) =>
        act(
            async () => {
                const r = await a.rollback(pid, number);
                setTab("releases");
                return `Rolled back. Release ${r.number} is live.`;
            },
            { action: "rollback", number },
            resuming,
        );

    const publish = (resuming = false) => {
        setConfirmPublish(false);
        return act(
            async () => {
                const r = await a.publish(pid);
                setTab("releases");
                const { url } = await a.hosting(pid).catch(() => ({ url: null }));
                // With an address to show, say so properly; otherwise a line will do.
                if (url) setPublished({ number: r.number, url });
                return url ? "" : `Release ${r.number} is live.`;
            },
            { action: "publish" },
            resuming,
        );
    };

    const confirmIdentity = () => {
        if (pendingIntent) sessionStorage.setItem(INTENT_KEY, JSON.stringify({ ...pendingIntent, projectId: pid, at: Date.now() }));
        reauthenticate();
    };

    // Back from confirming identity: finish what was asked for (once, and only if recent).
    const resumed = useRef(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per editor mount
    useEffect(() => {
        if (resumed.current) return;
        resumed.current = true;
        const raw = sessionStorage.getItem(INTENT_KEY);
        if (!raw) return;
        sessionStorage.removeItem(INTENT_KEY);
        try {
            const saved = JSON.parse(raw) as Intent & { projectId: string; at: number };
            if (saved.projectId !== pid || Date.now() - saved.at > INTENT_TTL_MS) return;
            if (saved.action === "publish") void publish(true);
            else if (saved.action === "rollback" && Number.isInteger(saved.number)) void rollback(saved.number, true);
        } catch {
            // a malformed entry is simply dropped
        }
    }, [a, pid]);

    const saveDocument = async (doc: ContentDocument, draft: Record<string, unknown>) => {
        await a.saveContent(pid, doc.kind, doc.slug, draft);
        toast("Draft saved.");
        await refresh();
    };

    // ---- render ------------------------------------------------------------------------

    const running = activeRun !== null;
    const live = overview?.liveRelease ?? null;
    const liveUrl = live ? (overview?.project.productionRef ?? null) : null;
    const hasChanges = overview?.hasChanges ?? false;
    const nothingToPublish = overview !== null && !hasChanges;

    return (
        <div className={`editor pane-${pane} ${sideOpen ? "side-open" : ""}`}>
            <header className="editor-bar">
                <div className="editor-bar-left">
                    <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => navigate(`/o/${org.slug}`)}
                        title={`${org.name}'s websites`}
                    >
                        <ArrowLeft />
                    </button>
                    <h1 className="display">{project.name}</h1>
                    {archived ? (
                        <span className="chip chip-plain">Archived</span>
                    ) : live ? (
                        hasChanges ? (
                            <span className="chip chip-draft">Unpublished changes</span>
                        ) : (
                            <span className="chip chip-live">Live · release {live.number}</span>
                        )
                    ) : (
                        <span className="chip chip-plain">Not published</span>
                    )}
                    {liveUrl && (
                        <a className="live-link mono" href={liveUrl} target="_blank" rel="noreferrer" title="Open the live website">
                            {new URL(liveUrl).host} <ArrowUpRight />
                        </a>
                    )}
                </div>
                <div className="editor-bar-right">
                    <ThemeToggle theme={theme} onToggle={onToggleTheme} />
                    <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => setAddressOpen(true)}
                        title="Address and domains"
                    >
                        <Globe />
                    </button>
                    {mayManage && (
                        <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            onClick={() => setSettingsOpen(true)}
                            title="Website settings"
                        >
                            <SlidersHorizontal />
                        </button>
                    )}
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
                    ready={agent !== null && mayEdit}
                    starting={starting}
                    locked={
                        archived
                            ? "This website is archived. Restore it from its settings to keep working on it."
                            : !can.edit(org.role)
                              ? "You're a viewer in this studio, so you can look but not change things."
                              : null
                    }
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
                    canEdit={mayEdit}
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

            {addressOpen && (
                <Address
                    project={project}
                    api={a}
                    mayManage={mayManage}
                    canPublish={canPublish}
                    onUnpublished={() => {
                        setAddressOpen(false);
                        void refresh();
                    }}
                    onClose={() => setAddressOpen(false)}
                />
            )}

            {published && <Published project={project} published={published} onClose={() => setPublished(null)} />}

            {settingsOpen && (
                <ProjectSettings
                    project={project}
                    org={org}
                    api={a}
                    onClose={() => setSettingsOpen(false)}
                    onSaved={(next) => {
                        onProjectChanged(next);
                        setSettingsOpen(false);
                    }}
                />
            )}

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

            {pendingIntent && (
                <Dialog onClose={() => setPendingIntent(null)}>
                    <p className="eyebrow">One more step</p>
                    <h2>Confirm it's you.</h2>
                    <p>
                        {pendingIntent.action === "publish" ? "Publishing changes" : "Rolling back changes"} what the world sees, so we ask
                        you to confirm your sign-in first. You'll come straight back here and we'll finish{" "}
                        {pendingIntent.action === "publish" ? "publishing" : "the rollback"} for you.
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="btn" onClick={() => setPendingIntent(null)}>
                            Cancel
                        </button>
                        <button type="button" className="btn btn-seal" onClick={confirmIdentity}>
                            Confirm and {pendingIntent.action === "publish" ? "publish" : "roll back"}
                        </button>
                    </div>
                </Dialog>
            )}
        </div>
    );
}

// Shown once a publish has gone through: where the website now lives.
function Published({ project, published, onClose }: { project: Project; published: { number: number; url: string }; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const host = new URL(published.url).host;
    return (
        <Dialog onClose={onClose} wide>
            <p className="eyebrow">Release {published.number}</p>
            <h2>
                {project.name} is <em className="live-word">live.</em>
            </h2>
            <p>Anyone with this address can see it now. A brand-new address can take a minute to start answering.</p>
            <div className="address-line">
                <a href={published.url} target="_blank" rel="noreferrer" className="mono">
                    {host} <ArrowUpRight />
                </a>
                <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                        void navigator.clipboard.writeText(published.url).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1600);
                        })
                    }
                >
                    {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy link"}
                </button>
            </div>
            <div className="dialog-actions">
                <button type="button" className="btn" onClick={onClose}>
                    Done
                </button>
                <a className="btn btn-seal" href={published.url} target="_blank" rel="noreferrer" onClick={onClose}>
                    Open website <ArrowUpRight />
                </a>
            </div>
        </Dialog>
    );
}
