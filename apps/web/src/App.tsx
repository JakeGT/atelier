import { useEffect, useState } from "react";
import type { Project, PublicConfig, Session } from "./lib/api";
import { api } from "./lib/api";
import { navigate, usePath, useTheme } from "./lib/hooks";
import { Editor } from "./pages/Editor";
import { Landing } from "./pages/Landing";
import { Login, safeNext } from "./pages/Login";
import { Studio } from "./pages/Studio";
import { Dots, ToastProvider, UpdateNotice, Wordmark } from "./ui/kit";

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
    const route = path === "/" ? "landing" : path === "/login" ? "login" : path === "/studio" ? "studio" : slug ? "editor" : "missing";
    const needsSession = route === "studio" || route === "editor";

    // Private pages send signed-out visitors to the login page (and back afterwards);
    // the login page sends signed-in visitors on to where they were going.
    useEffect(() => {
        if (session === undefined) return;
        if (session === null && needsSession) navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
        if (session && route === "login") navigate(safeNext(new URLSearchParams(window.location.search).get("next")), { replace: true });
    }, [session, needsSession, route, path]);

    const boot = (
        <div className="boot">
            <Dots />
        </div>
    );

    let page: React.ReactNode;
    if (route === "landing") {
        // The front page is public: it renders at once and adapts when the session arrives.
        page = <Landing session={session} config={config} theme={theme} onToggleTheme={toggleTheme} />;
    } else if (route === "missing") {
        page = <Missing title="There's nothing" body="The link may be out of date." />;
    } else if (session === undefined) {
        page = boot;
    } else if (route === "login") {
        page = session ? boot : <Login config={config} theme={theme} onToggleTheme={toggleTheme} />;
    } else if (session === null) {
        page = boot;
    } else if (route === "editor" && slug) {
        page = <ProjectRoute slug={slug} session={session} canPublish={canPublish} theme={theme} onToggleTheme={toggleTheme} />;
    } else {
        page = <Studio session={session} theme={theme} onToggleTheme={toggleTheme} />;
    }

    return (
        <ToastProvider>
            {page}
            <UpdateNotice />
        </ToastProvider>
    );
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
    if (project === null) return <Missing title="That website isn't" body="It may have been removed, or the link is wrong." />;
    // Keyed by project so switching projects resets all editor state.
    return <Editor key={project.id} project={project} {...props} />;
}

function Missing({ title, body }: { title: string; body: string }) {
    return (
        <div className="boot">
            <div style={{ textAlign: "center" }}>
                <Wordmark />
                <h1 className="display" style={{ fontSize: 56, marginTop: 24 }}>
                    {title} <em>here.</em>
                </h1>
                <p className="muted" style={{ marginTop: 12 }}>
                    {body}
                </p>
                <button type="button" className="btn btn-primary" style={{ marginTop: 28 }} onClick={() => navigate("/")}>
                    Back to the front page
                </button>
            </div>
        </div>
    );
}
