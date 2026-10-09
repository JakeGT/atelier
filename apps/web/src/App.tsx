import { useEffect, useState } from "react";
import type { Project, PublicConfig, Session } from "./lib/api";
import { api } from "./lib/api";
import { navigate, usePath, useTheme } from "./lib/hooks";
import { Editor } from "./pages/Editor";
import { Landing } from "./pages/Landing";
import { Studio } from "./pages/Studio";
import { Dots, ToastProvider, Wordmark } from "./ui/kit";

export function App() {
    const [theme, toggleTheme] = useTheme();
    const path = usePath();
    // undefined = still loading; null = signed out.
    const [session, setSession] = useState<Session | null | undefined>(undefined);
    const [config, setConfig] = useState<PublicConfig | null>(null);
    const [canPublish, setCanPublish] = useState(false);

    useEffect(() => {
        api.session()
            .then(setSession)
            .catch(() => setSession(null));
        api.config()
            .then(setConfig)
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (!session) return;
        fetch("/api/v1/orgs")
            .then((r) => r.json())
            .then((b: { role?: string }) => setCanPublish(b.role === "owner" || b.role === "admin"))
            .catch(() => {});
    }, [session]);

    const slug = path.match(/^\/p\/([a-z0-9-]+)\/?$/)?.[1];

    let page: React.ReactNode;
    if (session === undefined) {
        page = (
            <div className="boot">
                <Dots />
            </div>
        );
    } else if (session === null) {
        page = <Landing config={config} theme={theme} onToggleTheme={toggleTheme} />;
    } else if (slug) {
        page = <ProjectRoute slug={slug} session={session} canPublish={canPublish} theme={theme} onToggleTheme={toggleTheme} />;
    } else {
        page = <Studio session={session} theme={theme} onToggleTheme={toggleTheme} />;
    }

    return <ToastProvider>{page}</ToastProvider>;
}

function ProjectRoute(props: { slug: string; session: Session; canPublish: boolean; theme: "paper" | "night"; onToggleTheme: () => void }) {
    const [project, setProject] = useState<Project | null | undefined>(undefined);

    useEffect(() => {
        setProject(undefined);
        api.listProjects()
            .then((list) => setProject(list.find((p) => p.slug === props.slug) ?? null))
            .catch(() => setProject(null));
    }, [props.slug]);

    if (project === undefined) {
        return (
            <div className="boot">
                <Dots />
            </div>
        );
    }
    if (project === null) {
        return (
            <div className="boot">
                <div style={{ textAlign: "center" }}>
                    <Wordmark />
                    <h1 className="display" style={{ fontSize: 56, marginTop: 24 }}>
                        That website isn't <em>here.</em>
                    </h1>
                    <p className="muted" style={{ marginTop: 12 }}>
                        It may have been removed, or the link is wrong.
                    </p>
                    <button type="button" className="btn btn-primary" style={{ marginTop: 28 }} onClick={() => navigate("/")}>
                        Back to the studio
                    </button>
                </div>
            </div>
        );
    }
    // Keyed by project so switching projects resets all editor state.
    return <Editor key={project.id} project={project} {...props} />;
}
