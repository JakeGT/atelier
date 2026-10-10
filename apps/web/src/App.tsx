import { useCallback, useEffect, useState } from "react";
import type { Org, Project, PublicConfig, Session } from "./lib/api";
import { api, orgApi } from "./lib/api";
import { navigate, usePath, useTheme } from "./lib/hooks";
import { Editor } from "./pages/Editor";
import { Landing } from "./pages/Landing";
import { Login, safeNext } from "./pages/Login";
import { OrgSettings, type SettingsTab } from "./pages/OrgSettings";
import { Studio } from "./pages/Studio";
import { Dots, ToastProvider, UpdateNotice, Wordmark } from "./ui/kit";

// Routes:
//   /                      landing (public; adapts when signed in)
//   /login                 sign in
//   /studio                -> the organisation last used
//   /o/:org                that organisation's websites
//   /o/:org/settings/:tab  organisation settings (general, members, usage, activity)
//   /o/:org/p/:project     the editor
type Route =
    | { name: "landing" | "login" | "studio" | "missing" }
    | { name: "org"; org: string }
    | { name: "settings"; org: string; tab: SettingsTab }
    | { name: "editor"; org: string; project: string }
    | { name: "legacy-editor"; project: string };

const SLUG = "([a-z0-9-]+)";
const TABS: SettingsTab[] = ["general", "members", "usage", "activity"];

function match(path: string): Route {
    if (path === "/") return { name: "landing" };
    if (path === "/login") return { name: "login" };
    if (path === "/studio") return { name: "studio" };
    let m = path.match(new RegExp(`^/o/${SLUG}/?$`));
    if (m?.[1]) return { name: "org", org: m[1] };
    m = path.match(new RegExp(`^/o/${SLUG}/settings(?:/([a-z]+))?/?$`));
    if (m?.[1]) return { name: "settings", org: m[1], tab: TABS.includes(m[2] as SettingsTab) ? (m[2] as SettingsTab) : "general" };
    m = path.match(new RegExp(`^/o/${SLUG}/p/${SLUG}/?$`));
    if (m?.[1] && m[2]) return { name: "editor", org: m[1], project: m[2] };
    // Links from before organisations were in the URL.
    m = path.match(new RegExp(`^/p/${SLUG}/?$`));
    if (m?.[1]) return { name: "legacy-editor", project: m[1] };
    return { name: "missing" };
}

const LAST_ORG = "atelier.org";

export function App() {
    const [theme, toggleTheme] = useTheme();
    const path = usePath();
    // undefined = still loading; null = signed out.
    const [session, setSession] = useState<Session | null | undefined>(undefined);
    const [config, setConfig] = useState<PublicConfig | null>(null);
    const [orgs, setOrgs] = useState<Org[] | null>(null);

    useEffect(() => {
        api.session()
            .then(setSession)
            .catch(() => setSession(null));
        api.config()
            .then(setConfig)
            .catch(() => {});
    }, []);

    const reloadOrgs = useCallback(
        () =>
            api
                .listOrgs()
                .then((list) => {
                    setOrgs(list);
                    return list;
                })
                .catch(() => {
                    setOrgs([]);
                    return [] as Org[];
                }),
        [],
    );
    useEffect(() => {
        if (session) void reloadOrgs();
    }, [session, reloadOrgs]);

    const route = match(path);
    const isPrivate = route.name !== "landing" && route.name !== "login" && route.name !== "missing";

    // Private pages send signed-out visitors to the login page (and back afterwards);
    // the login page sends signed-in visitors on to where they were going.
    useEffect(() => {
        if (session === undefined) return;
        if (session === null && isPrivate) navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
        if (session && route.name === "login")
            navigate(safeNext(new URLSearchParams(window.location.search).get("next")), { replace: true });
    }, [session, isPrivate, route.name, path]);

    // /studio (and old /p/... links) resolve to an organisation: the one last used, else the first.
    const legacyProject = route.name === "legacy-editor" ? route.project : null;
    useEffect(() => {
        if (!session || !orgs?.length) return;
        if (route.name !== "studio" && route.name !== "legacy-editor") return;
        const last = localStorage.getItem(LAST_ORG);
        const org = orgs.find((o) => o.slug === last) ?? orgs[0];
        if (!org) return;
        navigate(legacyProject ? `/o/${org.slug}/p/${legacyProject}` : `/o/${org.slug}`, { replace: true });
    }, [session, orgs, route.name, legacyProject]);

    const orgSlug = "org" in route ? route.org : null;
    const org = orgSlug ? orgs?.find((o) => o.slug === orgSlug) : undefined;
    useEffect(() => {
        if (org) localStorage.setItem(LAST_ORG, org.slug);
    }, [org]);

    const boot = (
        <div className="boot">
            <Dots />
        </div>
    );
    const common = { theme, onToggleTheme: toggleTheme };

    let page: React.ReactNode;
    if (route.name === "landing") {
        // The front page is public: it renders at once and adapts when the session arrives.
        page = <Landing session={session} config={config} {...common} />;
    } else if (route.name === "missing") {
        page = <Missing title="There's nothing" body="The link may be out of date." />;
    } else if (session === undefined) {
        page = boot;
    } else if (route.name === "login") {
        page = session ? boot : <Login config={config} {...common} />;
    } else if (session === null || orgs === null || route.name === "studio" || route.name === "legacy-editor") {
        page = boot;
    } else if (!org) {
        // Not a member, or no such organisation: the same answer either way.
        page = <Missing title="That studio isn't" body="It may have been removed, or you may not be a member." />;
    } else if (route.name === "org") {
        page = <Studio key={org.id} session={session} org={org} orgs={orgs} onOrgsChanged={reloadOrgs} {...common} />;
    } else if (route.name === "settings") {
        page = <OrgSettings key={org.id} session={session} org={org} orgs={orgs} tab={route.tab} onOrgsChanged={reloadOrgs} {...common} />;
    } else if (route.name === "editor") {
        page = <ProjectRoute slug={route.project} session={session} org={org} {...common} />;
    } else {
        page = boot;
    }

    return (
        <ToastProvider>
            {page}
            <UpdateNotice />
        </ToastProvider>
    );
}

function ProjectRoute(props: { slug: string; session: Session; org: Org; theme: "paper" | "night"; onToggleTheme: () => void }) {
    const [project, setProject] = useState<Project | null | undefined>(undefined);
    const orgSlug = props.org.slug;

    useEffect(() => {
        setProject(undefined);
        const a = orgApi(orgSlug);
        // An archived website still opens (read-only), so look there too.
        Promise.all([a.listProjects(), a.listProjects(true).catch(() => [] as Project[])])
            .then(([live, archived]) => setProject([...live, ...archived].find((p) => p.slug === props.slug) ?? null))
            .catch(() => setProject(null));
    }, [props.slug, orgSlug]);

    if (project === undefined) {
        return (
            <div className="boot">
                <Dots />
            </div>
        );
    }
    if (project === null) return <Missing title="That website isn't" body="It may have been removed, or the link is wrong." />;
    // Keyed by project so switching projects resets all editor state.
    return <Editor key={project.id} project={project} onProjectChanged={setProject} {...props} />;
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
                <button type="button" className="btn btn-primary" style={{ marginTop: 28 }} onClick={() => navigate("/studio")}>
                    Back to your studio
                </button>
            </div>
        </div>
    );
}
