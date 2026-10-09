import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { Project, Session } from "./api";
import { api } from "./api";
import { Editor } from "./Editor";

export function App() {
    const [session, setSession] = useState<Session | null | undefined>(undefined);
    const [projects, setProjects] = useState<Project[]>([]);
    const [selected, setSelected] = useState<Project | null>(null);
    const [slug, setSlug] = useState("");
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadProjects = useCallback(async () => {
        try {
            setProjects(await api.listProjects());
        } catch {
            // ignore; the editor will surface errors on mutation
        }
    }, []);

    useEffect(() => {
        api.session()
            .then(setSession)
            .catch(() => setSession(null));
    }, []);

    useEffect(() => {
        if (session) void loadProjects();
    }, [session, loadProjects]);

    async function createProject(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!slug || !name) return;
        setBusy(true);
        setError(null);
        try {
            await api.createProject(slug, name);
            setSlug("");
            setName("");
            await loadProjects();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    if (session === undefined) {
        return (
            <main className="shell">
                <p className="muted">Loading…</p>
            </main>
        );
    }

    if (session === null) {
        return (
            <main className="shell">
                <h1>Atelier</h1>
                <p className="muted">Multi-tenant, multi-project AI website builder.</p>
                <a className="btn" href="/auth/login">
                    Sign in
                </a>
            </main>
        );
    }

    if (selected) {
        return <Editor project={selected} onBack={() => setSelected(null)} />;
    }

    return (
        <main className="shell">
            <header className="topbar">
                <h1>Atelier</h1>
                <span className="user">{session.email}</span>
            </header>

            <section className="create">
                <form onSubmit={createProject}>
                    <input placeholder="slug (my-site)" value={slug} onChange={(e) => setSlug(e.target.value)} />
                    <input placeholder="name (My Site)" value={name} onChange={(e) => setName(e.target.value)} />
                    <button type="submit" disabled={busy}>
                        Create project
                    </button>
                </form>
                {error && <p className="error">{error}</p>}
            </section>

            <section className="projects">
                {projects.length === 0 ? (
                    <p className="muted">No projects yet — create one above.</p>
                ) : (
                    projects.map((p) => (
                        <button key={p.id} type="button" className="project" onClick={() => setSelected(p)}>
                            <strong>{p.name}</strong>
                            <span className="muted">{p.slug}</span>
                        </button>
                    ))
                )}
            </section>
        </main>
    );
}
