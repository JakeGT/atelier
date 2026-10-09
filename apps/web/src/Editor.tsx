import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { AgentSession, Checkpoint, Project, Release } from "./api";
import { api, ReauthRequired, reauthenticate } from "./api";

interface Message {
    id: string;
    role: "user" | "assistant";
    text: string;
    tools?: { id: string; name: string; state: string }[];
}

export function Editor({ project, onBack }: { project: Project; onBack: () => void }) {
    const [session, setSession] = useState<AgentSession | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
    const [releases, setReleases] = useState<Release[]>([]);
    const [previewKey, setPreviewKey] = useState(0);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [needsReauth, setNeedsReauth] = useState(false);

    const ensureSession = useCallback(async () => {
        const sessions = await api.listSessions(project.id);
        const ready = sessions.find((s) => s.status === "ready");
        return ready ?? api.createSession(project.id);
    }, [project.id]);

    const loadTimeline = useCallback(async () => {
        const [cps, rels] = await Promise.all([
            api.listCheckpoints(project.id).catch(() => []),
            api.listReleases(project.id).catch(() => []),
        ]);
        setCheckpoints(cps);
        setReleases([...rels].reverse());
    }, [project.id]);

    useEffect(() => {
        void ensureSession()
            .then(setSession)
            .catch((err) => setError((err as Error).message));
    }, [ensureSession]);

    useEffect(() => {
        if (session) void loadTimeline();
    }, [session, loadTimeline]);

    // A fresh signed preview link on every reload (they expire after two hours).
    // biome-ignore lint/correctness/useExhaustiveDependencies: previewKey is the reload trigger
    useEffect(() => {
        void api
            .previewUrl(project.id)
            .then(setPreviewUrl)
            .catch(() => setPreviewUrl(null));
    }, [project.id, previewKey]);

    // Runs an action, turning "please sign in again" into a prompt rather than an error.
    async function guarded(fn: () => Promise<unknown>) {
        setError(null);
        try {
            await fn();
        } catch (err) {
            if (err instanceof ReauthRequired) setNeedsReauth(true);
            else setError((err as Error).message);
        }
    }

    async function send(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!session || !input.trim() || busy) return;
        const prompt = input.trim();
        setInput("");
        setBusy(true);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text: prompt }]);
        await guarded(async () => {
            const result = await api.sendMessage(project.id, session.id, prompt);
            setMessages((m) => [
                ...m,
                {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    text: result.text,
                    tools: result.toolEvents.map((t) => ({ id: crypto.randomUUID(), name: t.name, state: t.state })),
                },
            ]);
            setPreviewKey((k) => k + 1);
            await loadTimeline();
        });
        setBusy(false);
    }

    const restore = (sha: string) =>
        guarded(async () => {
            await api.restoreCheckpoint(project.id, sha);
            setPreviewKey((k) => k + 1);
            await loadTimeline();
        });

    const publish = () =>
        guarded(async () => {
            setBusy(true);
            try {
                await api.publish(project.id);
                await loadTimeline();
            } finally {
                setBusy(false);
            }
        });

    const rollback = (number: number) =>
        guarded(async () => {
            await api.rollback(project.id, number);
            await loadTimeline();
        });

    return (
        <main className="editor">
            <header className="topbar">
                <button type="button" onClick={onBack}>
                    ← Projects
                </button>
                <h1>{project.name}</h1>
                <span className="muted">{session?.status ?? "…"}</span>
                <button type="button" className="primary" onClick={publish} disabled={busy || !session}>
                    Publish website
                </button>
            </header>

            <div className="panes">
                <section className="pane chat">
                    <div className="messages">
                        {messages.map((m) => (
                            <div key={m.id} className={`msg ${m.role}`}>
                                <div className="bubble">{m.text}</div>
                                {m.tools && m.tools.length > 0 && (
                                    <div className="tools">
                                        {m.tools.map((t) => (
                                            <span key={t.id} className="tool" title={t.name}>
                                                {t.name}: {t.state}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                        {busy && (
                            <div className="msg assistant">
                                <div className="bubble">Working…</div>
                            </div>
                        )}
                    </div>
                    <form className="composer" onSubmit={send}>
                        <textarea
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Describe a change…"
                            disabled={!session || busy}
                        />
                        <button type="submit" disabled={!session || busy || !input.trim()}>
                            Send
                        </button>
                    </form>
                </section>

                <section className="pane preview">
                    <div className="pane-head">
                        <span>Preview</span>
                        <button type="button" onClick={() => setPreviewKey((k) => k + 1)}>
                            ↻
                        </button>
                    </div>
                    {/* Agent-written pages: sandboxed (no same-origin), so they can't act as the signed-in user. */}
                    <iframe
                        key={previewKey}
                        src={previewUrl ?? "about:blank"}
                        title="preview"
                        sandbox="allow-scripts allow-forms allow-popups allow-modals"
                    />
                </section>

                <section className="pane timeline">
                    <div className="pane-head">Versions</div>
                    <div className="checkpoints">
                        {checkpoints.length === 0 ? (
                            <p className="muted">No versions yet.</p>
                        ) : (
                            checkpoints.map((c, i) => (
                                <div key={c.sha} className="checkpoint">
                                    <div className="cp-msg">{c.message}</div>
                                    <div className="cp-meta">
                                        {c.sha.slice(0, 7)} · {new Date(c.date).toLocaleString()}
                                    </div>
                                    {i > 0 && (
                                        <button type="button" onClick={() => restore(c.sha)} disabled={busy}>
                                            Restore
                                        </button>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                    <div className="pane-head">Releases</div>
                    <div className="checkpoints">
                        {releases.length === 0 ? (
                            <p className="muted">Not published yet.</p>
                        ) : (
                            releases.map((r) => (
                                <div key={r.id} className="checkpoint">
                                    <div className="cp-msg">
                                        Release {r.number} · {r.state}
                                    </div>
                                    <div className="cp-meta">{new Date(r.deployedAt ?? r.createdAt).toLocaleString()}</div>
                                    {(r.state === "superseded" || r.state === "rolled_back") && (
                                        <button type="button" onClick={() => rollback(r.number)} disabled={busy}>
                                            Roll back to this
                                        </button>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>

            {needsReauth && (
                <p className="error banner">
                    Publishing needs you to confirm it's you.{" "}
                    <button type="button" onClick={reauthenticate}>
                        Sign in again
                    </button>
                </p>
            )}
            {error && <p className="error banner">{error}</p>}
        </main>
    );
}
