import { useCallback, useEffect, useMemo, useState } from "react";
import { MediaProvider } from "./editor/Media";
import type { Org, Project, PublicConfig, Session } from "./lib/api";
import { api, can, orgApi } from "./lib/api";
import { navigate, usePath, useTheme } from "./lib/hooks";
import { Content } from "./pages/Content";
import { Editor } from "./pages/Editor";
import { Landing } from "./pages/Landing";
import { Login, safeNext } from "./pages/Login";
import { Operator, type OperatorTab } from "./pages/Operator";
import { OrgSettings, type SettingsTab } from "./pages/OrgSettings";
import { Studio } from "./pages/Studio";
import { Welcome } from "./pages/Welcome";
import { Dots, ToastProvider, UpdateNotice, Wordmark } from "./ui/kit";
import { ReportHost } from "./ui/Report";

// Routes:
//   /                      landing (public; adapts when signed in)
//   /login                 sign in
//   /studio                -> the organisation last used
//   /welcome               the introduction, shown once to someone new
//   /admin                 the operator console (operators only)
//   /o/:org                that organisation's websites
//   /o/:org/settings/:tab  organisation settings (general, models, members, usage, activity)
//   /o/:org/p/:project     the editor
//   /o/:org/p/:project/content   everything the website says, to manage
type Route =
    | { name: "landing" | "login" | "studio" | "welcome" | "missing" }
    | { name: "operator"; tab: OperatorTab }
    | { name: "org"; org: string }
    | { name: "settings"; org: string; tab: SettingsTab }
    | { name: "editor" | "content"; org: string; project: string; messages?: boolean }
    | { name: "legacy-editor"; project: string };

const SLUG = "([a-z0-9-]+)";
const TABS: SettingsTab[] = ["general", "models", "members", "usage", "activity"];

function match(path: string): Route {
    if (path === "/") return { name: "landing" };
    if (path === "/login") return { name: "login" };
    if (path === "/studio") return { name: "studio" };
    if (path === "/welcome") return { name: "welcome" };
    // "/operator" is where notifications sent before 2026-10-11 point; it is the same place.
    if (path === "/admin" || path === "/admin/" || path === "/operator" || path === "/operator/")
        return { name: "operator", tab: "studios" };
    if (path === "/admin/activity") return { name: "operator", tab: "activity" };
    if (path === "/admin/reports") return { name: "operator", tab: "reports" };
    let m = path.match(new RegExp(`^/o/${SLUG}/?$`));
    if (m?.[1]) return { name: "org", org: m[1] };
    m = path.match(new RegExp(`^/o/${SLUG}/settings(?:/([a-z]+))?/?$`));
    if (m?.[1]) return { name: "settings", org: m[1], tab: TABS.includes(m[2] as SettingsTab) ? (m[2] as SettingsTab) : "general" };
    m = path.match(new RegExp(`^/o/${SLUG}/p/${SLUG}/content(/messages)?/?$`));
    if (m?.[1] && m[2]) return { name: "content", org: m[1], project: m[2], messages: Boolean(m[3]) };
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

    // Someone new is taken through the introduction first, once.
    useEffect(() => {
        if (session && !session.onboarded && isPrivate && route.name !== "welcome") navigate("/welcome", { replace: true });
    }, [session, isPrivate, route.name]);

    // /studio (and old /p/... links) resolve to an organisation: the one last used, else the first.
    const legacyProject = route.name === "legacy-editor" ? route.project : null;
    useEffect(() => {
        if (!session || !orgs?.length) return;
        if (route.name !== "studio" && route.name !== "legacy-editor") return;
        if (!session.onboarded) return;
        // The studio last used, else their own.
        const last = localStorage.getItem(LAST_ORG);
        // (A suspended studio is not somewhere to land.)
        const open = orgs.filter((o) => o.status !== "suspended");
        const org = open.find((o) => o.slug === last) ?? open.find((o) => o.personalOf === session.id) ?? open[0] ?? orgs[0];
        if (!org) return;
        navigate(legacyProject ? `/o/${org.slug}/p/${legacyProject}` : `/o/${org.slug}`, { replace: true });
    }, [session, orgs, route.name, legacyProject]);

    const orgSlug = "org" in route ? route.org : null;
    const org = orgSlug ? orgs?.find((o) => o.slug === orgSlug) : undefined;
    useEffect(() => {
        // A studio being visited is not "where this person was last": their own is.
        if (org && !org.visiting) localStorage.setItem(LAST_ORG, org.slug);
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
    } else if (session === null || orgs === null) {
        page = boot;
    } else if (route.name === "welcome") {
        page = (
            <Welcome
                session={session}
                orgs={orgs}
                onOrgsChanged={reloadOrgs}
                onDone={() => setSession({ ...session, onboarded: true })}
                {...common}
            />
        );
    } else if (route.name === "operator") {
        // Not an operator: there is nothing here, the same as any address that does not exist.
        page = session.admin ? (
            <Operator session={session} tab={route.tab} {...common} />
        ) : (
            <Missing title="There's nothing" body="The link may be out of date." />
        );
    } else if (route.name === "studio" || route.name === "legacy-editor") {
        page = boot;
    } else if (!org) {
        // Not a member, or no such organisation: the same answer either way.
        page = <Missing title="That studio isn't" body="It may have been removed, or you may not be a member." />;
    } else if (org.status === "suspended") {
        page = (
            <Missing
                whole
                title={`${org.name} is suspended.`}
                body="Whoever runs Atelier for you has paused this studio. Nothing in it can be changed until they restore it; published websites are still up. Get in touch with them to find out more."
            />
        );
    } else if (route.name === "org") {
        page = <Studio key={org.id} session={session} org={org} orgs={orgs} onOrgsChanged={reloadOrgs} {...common} />;
    } else if (route.name === "settings") {
        page = <OrgSettings key={org.id} session={session} org={org} orgs={orgs} tab={route.tab} onOrgsChanged={reloadOrgs} {...common} />;
    } else if (route.name === "editor" || route.name === "content") {
        page = <ProjectRoute slug={route.project} view={route.name} messages={route.messages} session={session} org={org} {...common} />;
    } else {
        page = boot;
    }

    return (
        <ToastProvider>
            {org?.visiting && session && <VisitNotice org={org} />}
            {page}
            <ReportHost />
            <UpdateNotice />
        </ToastProvider>
    );
}

function ProjectRoute(props: {
    slug: string;
    view: "editor" | "content";
    // Open the Content page on what visitors sent.
    messages?: boolean;
    session: Session;
    org: Org;
    theme: "paper" | "night";
    onToggleTheme: () => void;
}) {
    const [project, setProject] = useState<Project | null | undefined>(undefined);
    const orgSlug = props.org.slug;
    const mediaApi = useMemo(() => orgApi(orgSlug), [orgSlug]);

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
    if (props.view === "content")
        return <Content key={project.id} project={project} {...props} startOn={props.messages ? "messages" : "wording"} />;
    return (
        <MediaProvider
            a={mediaApi}
            projectId={project.id}
            canEdit={can.edit(project.myRole ?? props.org.role) && project.archivedAt === null}
        >
            <Editor key={project.id} project={project} onProjectChanged={setProject} {...props} />
        </MediaProvider>
    );
}

function Missing({ title, body, whole }: { title: string; body: string; whole?: boolean }) {
    return (
        <div className="boot">
            <div style={{ textAlign: "center" }}>
                <Wordmark />
                <h1 className="display" style={{ fontSize: 56, marginTop: 24 }}>
                    {title}
                    {!whole && (
                        <>
                            {" "}
                            <em>here.</em>
                        </>
                    )}
                </h1>
                <p className="muted" style={{ marginTop: 12, maxWidth: 520, marginInline: "auto" }}>
                    {body}
                </p>
                <button type="button" className="btn btn-primary" style={{ marginTop: 28 }} onClick={() => navigate("/studio")}>
                    Back to your studio
                </button>
            </div>
        </div>
    );
}

// An operator is inside a studio they do not belong to. Said plainly for as long as they
// are, with when it ends and the way out, so it is never mistaken for a studio of their own.
function VisitNotice({ org }: { org: Org }) {
    const [leaving, setLeaving] = useState(false);
    const until = org.visiting ? new Date(org.visiting).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const leave = async () => {
        setLeaving(true);
        await api.operatorLeave(org.id).catch(() => {});
        window.location.assign("/admin");
    };
    return (
        <div className="visit-notice" role="status">
            <span>
                <strong>
                    <span className="visit-more">You are inside </span>
                    {org.name}
                    <span className="visit-more"> as an operator</span>
                    <span className="visit-less">: operator visit</span>
                </strong>
                , until {until}.<span className="visit-more"> Its owners have been told, and what you do here is in its activity.</span>
            </span>
            <button type="button" className="btn btn-sm" disabled={leaving} onClick={() => void leave()}>
                Leave this studio
            </button>
        </div>
    );
}
