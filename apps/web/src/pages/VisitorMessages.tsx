import { ArrowLeft, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Messages } from "../editor/Messages";
import type { LiveStatus, Org, Project, Session } from "../lib/api";
import { can, orgApi } from "../lib/api";
import { navigate, type Theme } from "../lib/hooks";
import { Dots, UserMenu, Wordmark } from "../ui/kit";
import { pageName } from "./Content";

interface Props {
    project: Project;
    org: Org;
    session: Session;
    theme: Theme;
    onToggleTheme: () => void;
}

const formName = (form: string): string => {
    const words = form.replace(/[-_]+/g, " ").trim();
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} form`;
};

// What visitors have sent through the website's forms, on a page of its own, with whether
// each form on the live website is working.
export function VisitorMessages({ project, org, session, theme, onToggleTheme }: Props) {
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const canEdit = can.edit(project.myRole ?? org.role) && project.archivedAt === null;
    const editor = `/o/${org.slug}/p/${project.slug}`;
    const seen = useCallback(() => undefined, []);
    return (
        <div className="content-page">
            <header className="studio-nav">
                <div className="studio-nav-left">
                    <Wordmark />
                    <span className="nav-slash" aria-hidden="true">
                        /
                    </span>
                    <span className="org-name">{project.name}</span>
                </div>
                <nav className="studio-nav-right">
                    <button type="button" className="btn btn-ghost" onClick={() => navigate(editor)}>
                        <ArrowLeft /> Back to the editor
                    </button>
                    <UserMenu session={session} theme={theme} onToggleTheme={onToggleTheme} />
                </nav>
            </header>
            <div className="content-head">
                <button type="button" className="link content-back" onClick={() => navigate(editor)}>
                    <ArrowLeft /> Back to the editor
                </button>
                <p className="eyebrow">{project.name}</p>
                <h1 className="display">
                    Messages from <em>visitors.</em>
                </h1>
                <p className="muted">
                    What people send through the forms on this website arrives here. You are also told in Atelier and by e-mail each time
                    someone writes.
                </p>
            </div>
            <div className="content-files">
                <FormsCheck a={a} projectId={project.id} editor={editor} />
                <Messages org={org.slug} projectId={project.id} canEdit={canEdit} onSeen={seen} />
            </div>
        </div>
    );
}

// The forms on the live website, each tried: does the published page send it to Atelier, and does it arrive.
function FormsCheck({ a, projectId, editor }: { a: ReturnType<typeof orgApi>; projectId: string; editor: string }) {
    const [status, setStatus] = useState<LiveStatus | null>(null);
    const [checking, setChecking] = useState(true);
    const check = useCallback(async () => {
        setChecking(true);
        setStatus(await a.live(projectId).catch(() => null));
        setChecking(false);
    }, [a, projectId]);
    useEffect(() => {
        void check();
    }, [check]);

    if (!status && checking) return null;
    // Not published, or nothing on it to check and nothing wrong: say nothing.
    if (!status?.url || (status.ready && status.forms.length === 0 && status.unconnected.length === 0)) return null;
    return (
        <section className="forms-check" aria-live="polite">
            <div className="forms-check-head">
                <h2>The forms on your live website</h2>
                <button type="button" className="btn btn-sm" onClick={() => void check()} disabled={checking}>
                    {checking ? <Dots /> : <RefreshCw />} Check them again
                </button>
            </div>
            {!status.ready ? (
                <p className="muted">
                    Your website was published a moment ago and its address is not answering with the new version yet. The forms can be
                    checked once it is.
                </p>
            ) : (
                <ul>
                    {status.forms.map((f) => (
                        <li key={`${f.page}#${f.form}`} className={f.working ? "ok" : "bad"}>
                            {f.working ? <CircleCheck /> : <CircleAlert />}
                            <div>
                                <strong>
                                    {formName(f.form)}, on the {pageName(f.page).toLowerCase()}
                                </strong>
                                <span>{f.working ? "Working: a test message sent just now arrived. It was not kept." : f.problem}</span>
                            </div>
                        </li>
                    ))}
                    {status.unconnected.map((page) => (
                        <li key={page} className="bad">
                            <CircleAlert />
                            <div>
                                <strong>A form on the {pageName(page).toLowerCase()} sends nowhere</strong>
                                <span>
                                    What a visitor types into it is lost.{" "}
                                    <button
                                        type="button"
                                        className="link"
                                        onClick={() =>
                                            navigate(
                                                `${editor}?ask=${encodeURIComponent(`A form on ${page} is not connected, so what visitors send through it is lost. Connect it so its messages arrive in Atelier.`)}`,
                                            )
                                        }
                                    >
                                        Ask my assistant to connect it
                                    </button>
                                </span>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
