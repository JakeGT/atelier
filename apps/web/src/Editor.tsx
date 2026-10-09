import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { AgentSession, Checkpoint, Project } from "./api";
import { api } from "./api";

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
    const [previewKey, setPreviewKey] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const ensureSession = useCallback(async () => {
        const sessions = await api.listSessions(project.id);
        if (sessions.length > 0) return sessions[0];
        return api.createSession(project.id);
    }, [project.id]);

    const loadCheckpoints = useCallback(async () => {
        if (!session) return;
        setCheckpoints(await api.listCheckpoints(project.id, session.id));
    }, [project.id, session]);

    useEffect(() => {
        void ensureSession()
            .then(setSession)
            .catch((err) => setError((err as Error).message));
    }, [ensureSession]);

    useEffect(() => {
        if (session) void loadCheckpoints();
    }, [session, loadCheckpoints]);

    async function send(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!session || !input.trim() || busy) return;
        const prompt = input.trim();
        setInput("");
        setBusy(true);
        setError(null);
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text: prompt }]);
        try {
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
            await loadCheckpoints();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function restore(sha: string) {
        if (!session) return;
        try {
            await api.resetCheckpoint(project.id, session.id, sha);
            setPreviewKey((k) => k + 1);
            await loadCheckpoints();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    return (
        <main className="editor">
            <header className="topbar">
                <button type="button" onClick={onBack}>
                    ← Projects
                </button>
                <h1>{project.name}</h1>
                <span className="muted">{session?.status ?? "…"}</span>
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
                                <div className="bubble">Thinking…</div>
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
                    <iframe key={previewKey} src={`/api/v1/projects/${project.id}/preview/index.html`} title="preview" />
                </section>

                <section className="pane timeline">
                    <div className="pane-head">Versions</div>
                    <div className="checkpoints">
                        {checkpoints.length === 0 ? (
                            <p className="muted">No versions yet.</p>
                        ) : (
                            checkpoints.map((c) => (
                                <div key={c.sha} className="checkpoint">
                                    <div className="cp-msg">{c.message}</div>
                                    <div className="cp-meta">
                                        {c.sha.slice(0, 7)} · {new Date(c.date).toLocaleString()}
                                    </div>
                                    <button type="button" onClick={() => restore(c.sha)}>
                                        Restore
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>

            {error && <p className="error banner">{error}</p>}
        </main>
    );
}
