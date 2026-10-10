import {
    ArrowLeft,
    ArrowUpRight,
    Check,
    ChevronDown,
    CloudOff,
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
import { WordingDialog } from "../editor/Wording";
import { changedFiles } from "../lib/activity";
import type { AgentSession, Checkpoint, ContentDocument, Org, Overview, Project, Pulse, Release, Run, Session } from "../lib/api";
import { can, orgApi, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, useClickOutside, useStored } from "../lib/hooks";
import { Dialog, Dots, UserMenu, useToast } from "../ui/kit";
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
    // Several people can have one website open: who else is here, whose request
    // is being worked on, and the names of the people in the conversation.
    const [people, setPeople] = useState<Pulse["people"]>([]);
    const [runBy, setRunBy] = useState<Pulse["runBy"]>(null);
    const [authors, setAuthors] = useState<Record<string, string>>({});
    const typing = useRef(false);

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
    // Opened from "Unpublish": the address dialog goes straight to its confirmation.
    const [addressUnpublish, setAddressUnpublish] = useState(false);
    const openAddress = (unpublish: boolean) => {
        setAddressUnpublish(unpublish);
        setAddressOpen(true);
    };
    const [published, setPublished] = useState<{ number: number; url: string } | null>(null);
    const [pendingIntent, setPendingIntent] = useState<Intent | null>(null);

    const loadThread = useCallback(async () => {
        try {
            const thread = await a.thread(pid);
            setMessages(thread.messages);
            setAuthors(thread.authors ?? {});
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

    // ---- the pulse: one heartbeat that keeps this editor in step with the website ---------
    // Every couple of seconds it says "I am here" (and whether I am typing) and
    // learns who else is, how the request being worked on is getting along, and
    // whether anything changed. That is what lets two people share a website:
    // either one's request, reply, saved wording or publish shows up for the other.
    const seen = useRef<{ stamp: number | null; runId: string | null; written: number }>({ stamp: null, runId: null, written: 0 });
    const [stale, setStale] = useState(0);
    useEffect(() => {
        let stopped = false;
        let misses = 0;
        const beat = async () => {
            // A hidden tab stops saying "I am here", and catches up when it is looked at again.
            if (document.hidden) return;
            try {
                const pulse = await a.pulse(pid, typing.current);
                if (stopped) return;
                misses = 0;
                setPeople(pulse.people);
                setRunBy(pulse.runBy);
                setActiveRun(pulse.run);
                const was = seen.current;
                // Pages written while it works show in the preview straight away.
                const written = pulse.run ? pulse.run.steps.filter(changedFiles).length : 0;
                if (pulse.run && written > was.written) reloadPreview();
                const finished = was.runId !== null && pulse.run === null;
                const changed = was.stamp !== null && pulse.stamp !== was.stamp;
                seen.current = { stamp: pulse.stamp, runId: pulse.run?.id ?? null, written };
                // A request finished, or someone changed something: show it.
                if (finished || changed) setStale((n) => n + 1);
            } catch {
                // The network is flaky or the server is restarting: after a few misses, reload what we show.
                if (++misses === 5) setStale((n) => n + 1);
            }
        };
        void beat();
        const timer = setInterval(beat, 2000);
        const onVisible = () => void beat();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [a, pid, reloadPreview]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: `stale` is the signal to reload
    useEffect(() => {
        if (stale === 0) return;
        void loadThread();
        void refresh();
        reloadPreview();
    }, [stale]);

    const stopRun = () => {
        if (activeRun) a.stopRun(pid, activeRun.id).catch((err: Error) => toast(err.message, "error"));
    };
    const moreTime = () => {
        if (!activeRun) return;
        a.extendRun(pid, activeRun.id).then(
            (run) => {
                setActiveRun(run);
                toast("It has 10 more minutes.");
            },
            (err: Error) => toast(err.message, "error"),
        );
    };
    const carryOn = async () => {
        if (!agent || activeRun) return;
        try {
            setActiveRun(await a.carryOn(pid, agent.id));
            void loadThread();
        } catch (err) {
            note("error", (err as Error).message);
        }
    };

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
                return `The earlier one is back: it is live as release ${r.number}.`;
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

    // Text typed into the page in the preview ("Edit text"). The page only says what
    // changed; the saving, with the same conflict check as everywhere else, is here.
    const saveFromPreview = async (ref: string, value: string) => {
        const [docRef = "", field = ""] = ref.split("#");
        const [kind = "", slug = ""] = docRef.split("/");
        const doc = documents.find((d) => d.kind === kind && d.slug === slug);
        if (doc?.draft?.[field] === value) return;
        try {
            await a.saveContent(pid, kind, slug, { ...(doc?.draft ?? {}), [field]: value }, doc?.rev);
            toast("Saved. It goes public when you publish.");
        } catch (err) {
            toast((err as Error).message, "error");
        }
        await refresh();
        reloadPreview();
    };
    // A formatted piece or a list was clicked in the preview: it is edited in the pop-up.
    const [editingRef, setEditingRef] = useState<{ doc: ContentDocument; field: string } | null>(null);
    const openFromPreview = (ref: string) => {
        const [docRef = "", field = ""] = ref.split("#");
        const [kind, slug] = docRef.split("/");
        const doc = documents.find((d) => d.kind === kind && d.slug === slug);
        if (doc) setEditingRef({ doc, field });
        else toast("That part of the page has no saved wording yet. Ask your assistant to make it editable.", "error");
    };

    const saveDocument = async (doc: ContentDocument, draft: Record<string, unknown>) => {
        await a.saveContent(pid, doc.kind, doc.slug, draft, doc.rev);
        toast("Saved. It shows in the preview, and goes public when you publish.");
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
                    <button type="button" className="btn btn-ghost bar-back" onClick={() => navigate(`/o/${org.slug}`)}>
                        <ArrowLeft /> <span className="bar-label">Websites</span>
                    </button>
                    <h1 className="display">{project.name}</h1>
                    {archived ? (
                        <span className="chip chip-plain">Archived</span>
                    ) : live ? (
                        <LiveMenu
                            number={live.number}
                            hasChanges={hasChanges}
                            url={liveUrl}
                            canPublish={canPublish}
                            onAddress={() => openAddress(false)}
                            onUnpublish={() => openAddress(true)}
                        />
                    ) : (
                        <span className="chip chip-plain">Not published</span>
                    )}
                </div>
                <div className="editor-bar-right">
                    <button type="button" className="btn btn-ghost bar-wide" onClick={() => openAddress(false)}>
                        <Globe /> <span className="bar-label">Address</span>
                    </button>
                    {mayManage && (
                        <button type="button" className="btn btn-ghost bar-wide" onClick={() => setSettingsOpen(true)}>
                            <SlidersHorizontal /> <span className="bar-label">Settings</span>
                        </button>
                    )}
                    <button
                        type="button"
                        className={`btn btn-ghost side-toggle ${sideOpen ? "on" : ""}`}
                        onClick={() => setSideOpen((o) => !o)}
                        aria-pressed={sideOpen}
                        title="Show or hide the panel with saved versions, what is published, and your wording"
                    >
                        <PanelRight /> <span className="bar-label">Versions and wording</span>
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
                    <UserMenu
                        session={session}
                        theme={theme}
                        onToggleTheme={onToggleTheme}
                        items={[
                            { label: "Address and domains", icon: <Globe />, onClick: () => openAddress(false) },
                            ...(mayManage
                                ? [{ label: "Website settings", icon: <SlidersHorizontal />, onClick: () => setSettingsOpen(true) }]
                                : []),
                            { label: `All of ${org.name}'s websites`, icon: <ArrowLeft />, onClick: () => navigate(`/o/${org.slug}`) },
                        ]}
                    />
                </div>
            </header>

            <div className="editor-body">
                <Chat
                    messages={[...(messages ?? []), ...pending]}
                    loading={messages === null}
                    run={activeRun}
                    runBy={runBy}
                    people={people}
                    authors={authors}
                    me={session.id}
                    onTyping={(t) => {
                        typing.current = t;
                    }}
                    onStop={stopRun}
                    onMoreTime={moreTime}
                    onCarryOn={() => void carryOn()}
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
                    url={previewUrl}
                    reloadKey={reloadKey}
                    device={device}
                    onDevice={setDevice}
                    onReload={reloadPreview}
                    canEdit={mayEdit}
                    onWording={(ref, value) => void saveFromPreview(ref, value)}
                    onOpenWording={openFromPreview}
                    hasPage={checkpoints.length > 0 || (activeRun?.steps.some(changedFiles) ?? false)}
                    working={running}
                />
                <Sidebar
                    contentHref={`/o/${org.slug}/p/${project.slug}/content`}
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
                        ["side", "Versions", History],
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
                    startUnpublish={addressUnpublish}
                    onUnpublished={() => {
                        setAddressOpen(false);
                        void refresh();
                    }}
                    onClose={() => setAddressOpen(false)}
                />
            )}

            {published && <Published project={project} published={published} onClose={() => setPublished(null)} />}

            {editingRef && (
                <WordingDialog
                    doc={documents.find((d) => d.id === editingRef.doc.id) ?? editingRef.doc}
                    focus={editingRef.field}
                    canEdit={mayEdit}
                    onSave={saveDocument}
                    onClose={() => setEditingRef(null)}
                />
            )}

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
                    <p>
                        What you see in the preview becomes your public website. You can put an earlier version back at any time, or take
                        the website offline.
                    </p>
                    <ul className="manifest">
                        <li>
                            <span>Pages and design</span>
                            <span>{!overview?.head ? "Nothing built yet" : overview.codeChanged ? "Changed" : "No changes"}</span>
                        </li>
                        <li>
                            <span>Wording</span>
                            <span>
                                {overview?.changedDocuments
                                    ? `${overview.changedDocuments} ${overview.changedDocuments === 1 ? "change" : "changes"}`
                                    : "No changes"}
                            </span>
                        </li>
                        <li>
                            <span>Public right now</span>
                            <span>{live ? `Release ${live.number}` : "Nothing yet"}</span>
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
                        {pendingIntent.action === "publish" ? "Publishing changes" : "Putting an earlier release back changes"} what the
                        world sees, so we ask you to confirm your sign-in first. You'll come straight back here and we'll finish{" "}
                        {pendingIntent.action === "publish" ? "publishing" : "that"} for you.
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="btn" onClick={() => setPendingIntent(null)}>
                            Cancel
                        </button>
                        <button type="button" className="btn btn-seal" onClick={confirmIdentity}>
                            Confirm and {pendingIntent.action === "publish" ? "publish" : "put it back"}
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

// The website's published state, and what can be done about it: said in words,
// next to the thing it describes.
function LiveMenu({
    number,
    hasChanges,
    url,
    canPublish,
    onAddress,
    onUnpublish,
}: {
    number: number;
    hasChanges: boolean;
    url: string | null;
    canPublish: boolean;
    onAddress: () => void;
    onUnpublish: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const ref = useClickOutside(useCallback(() => setOpen(false), []));
    const run = (action: () => void) => () => {
        setOpen(false);
        action();
    };
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the menu from anywhere inside it
        <div
            className="menu-wrap live-menu"
            ref={ref}
            onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
            }}
        >
            <button
                type="button"
                className={`chip chip-button ${hasChanges ? "chip-draft" : "chip-live"}`}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                {hasChanges ? `Live · unpublished changes` : `Live · release ${number}`} <ChevronDown />
            </button>
            {open && (
                <div className="menu menu-left" role="menu">
                    <div className="menu-head">
                        <strong>Release {number} is live</strong>
                        <span className="mono muted">{url ? new URL(url).host : "Not served anywhere: hosting is not set up"}</span>
                    </div>
                    {url && (
                        <>
                            <a role="menuitem" href={url} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                                <ArrowUpRight /> Open the live website
                            </a>
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() =>
                                    void navigator.clipboard.writeText(url).then(() => {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 1600);
                                    })
                                }
                            >
                                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy its address"}
                            </button>
                            <button type="button" role="menuitem" onClick={run(onAddress)}>
                                <Globe /> Address and domains
                            </button>
                        </>
                    )}
                    {canPublish && url && (
                        <>
                            <div className="menu-rule" />
                            <button type="button" role="menuitem" className="menu-danger" onClick={run(onUnpublish)}>
                                <CloudOff /> Unpublish…
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
