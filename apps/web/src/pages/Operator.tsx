import { ArrowLeft, Check, Download, PauseCircle, PlayCircle, Undo2 } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, FeedbackReport, OperatorOverview, Session, StudioSummary } from "../lib/api";
import { api, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, timeAgo } from "../lib/hooks";
import { Dialog, Dots, UserMenu, useToast, Wordmark } from "../ui/kit";

export type OperatorTab = "studios" | "activity" | "reports";

interface Props {
    session: Session;
    tab: OperatorTab;
    theme: Theme;
    onToggleTheme: () => void;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// For whoever runs this Atelier: every studio, what it is using, and the few
// things an operator may do to one (pause it, switch parts off, set its limits).
// Operators do not see inside a studio's websites from here.
export function Operator({ session, tab, theme, onToggleTheme }: Props) {
    return (
        <div className="studio">
            <header className="studio-nav">
                <div className="studio-nav-left">
                    <Wordmark />
                    <span className="nav-slash" aria-hidden="true">
                        /
                    </span>
                    <span className="org-name">Operator console</span>
                </div>
                <nav className="studio-nav-right">
                    <button type="button" className="btn btn-ghost" onClick={() => navigate("/studio")}>
                        <ArrowLeft /> Back to my studio
                    </button>
                    <UserMenu session={session} theme={theme} onToggleTheme={onToggleTheme} />
                </nav>
            </header>
            <main className="studio-main settings operator">
                <p className="eyebrow">For whoever runs Atelier</p>
                <h1 className="display">
                    Operator <em>console.</em>
                </h1>
                <div className="tabs settings-tabs" role="tablist">
                    {(["studios", "reports", "activity"] as const).map((t) => (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={tab === t}
                            className={tab === t ? "on" : ""}
                            onClick={() => navigate(t === "studios" ? "/admin" : `/admin/${t}`)}
                        >
                            {t === "studios" ? "Studios" : t === "reports" ? "Reports" : "Activity"}
                        </button>
                    ))}
                </div>
                {tab === "studios" ? <Studios /> : tab === "reports" ? <Reports /> : <Activity />}
            </main>
        </div>
    );
}

const REPORT_KINDS: Record<string, string> = {
    problem: "Something is wrong",
    idea: "An idea",
    tool: "A tool did not work as described",
    rules: "The rules were unclear",
    missing: "Something it needed was missing",
    other: "Something else",
};

// What people, and the assistant, have said about Atelier itself. Read, act on, mark as dealt with.
function Reports() {
    const toast = useToast();
    const [showing, setShowing] = useState<"open" | "done">("open");
    const [reports, setReports] = useState<FeedbackReport[] | null>(null);
    const [open, setOpen] = useState(0);
    const load = useCallback(
        () =>
            api.operatorReports(showing).then(
                (b) => {
                    setReports(b.reports);
                    setOpen(b.open);
                },
                (err: Error) => toast(err.message, "error"),
            ),
        [showing, toast],
    );
    useEffect(() => {
        setReports(null);
        void load();
    }, [load]);
    const mark = async (r: FeedbackReport, status: "open" | "done") => {
        try {
            await api.setReportStatus(r.id, status);
            await load();
        } catch (err) {
            toast((err as Error).message, "error");
        }
    };
    return (
        <section className="reports">
            <p className="muted settings-about">
                What people have reported from the account menu, and what the assistant has said got in its way while working. Reports from
                the assistant are about Atelier's tools and rules, not about anyone's website.
            </p>
            <div className="reports-bar">
                <div className="tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={showing === "open"}
                        className={showing === "open" ? "on" : ""}
                        onClick={() => setShowing("open")}
                    >
                        To look at ({open})
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={showing === "done"}
                        className={showing === "done" ? "on" : ""}
                        onClick={() => setShowing("done")}
                    >
                        Dealt with
                    </button>
                </div>
                {open > 0 && (
                    <a className="btn btn-sm" href={api.reportsDocumentUrl} download>
                        <Download /> Download everything to look at, as one document
                    </a>
                )}
            </div>
            {reports === null ? (
                <Dots />
            ) : reports.length === 0 ? (
                <p className="muted">
                    {showing === "open" ? "Nothing to look at. Reports appear here as they are sent." : "Nothing has been dealt with yet."}
                </p>
            ) : (
                <ul className="reports-list">
                    {reports.map((r) => (
                        <li key={r.id} className="report-item">
                            <div className="report-head">
                                <span className={`chip ${r.source === "assistant" ? "" : "chip-draft"}`}>
                                    {r.source === "assistant" ? "From the assistant" : "From a person"}
                                </span>
                                <strong>{REPORT_KINDS[r.kind] ?? r.kind}</strong>
                                <span className="muted" title={new Date(r.createdAt).toLocaleString()}>
                                    {timeAgo(r.createdAt)}
                                </span>
                            </div>
                            <p className="report-text">{r.text}</p>
                            <p className="muted report-context">
                                {[
                                    r.context.from,
                                    r.context.studio,
                                    r.context.website,
                                    r.context.page,
                                    r.context.model,
                                    r.context.screen,
                                    r.context.browser,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </p>
                            <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => void mark(r, r.status === "open" ? "done" : "open")}
                            >
                                {r.status === "open" ? (
                                    <>
                                        <Check /> Mark as dealt with
                                    </>
                                ) : (
                                    <>
                                        <Undo2 /> Put back to look at
                                    </>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function Studios() {
    const toast = useToast();
    const [data, setData] = useState<OperatorOverview | null>(null);
    const [managing, setManaging] = useState<StudioSummary | null>(null);
    const [query, setQuery] = useState("");

    const load = useCallback(() => api.operatorOverview().then(setData, (err: Error) => toast(err.message, "error")), [toast]);
    useEffect(() => {
        void load();
    }, [load]);

    if (!data) {
        return (
            <div className="panel panel-loading">
                <Dots />
            </div>
        );
    }
    const q = query.trim().toLowerCase();
    const studios = data.studios.filter((s) => !q || `${s.name} ${s.owners.join(" ")}`.toLowerCase().includes(q));
    const t = data.totals;

    return (
        <div className="panel">
            <dl className="figures">
                {[
                    ["Studios", t.studios],
                    ["People", t.people],
                    ["Websites", t.websites],
                    ["Published", t.liveWebsites],
                    ["Assistant tokens, 30 days", t.tokens],
                ].map(([label, n]) => (
                    <div key={label as string}>
                        <dt className="eyebrow">{label}</dt>
                        <dd className="display">{compact.format(n as number)}</dd>
                    </div>
                ))}
            </dl>

            <label className="field-line">
                <span className="eyebrow">Find a studio</span>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="By its name or its owner's e-mail address" />
            </label>

            <ul className="rows operator-rows">
                {studios.map((s) => (
                    <li key={s.id}>
                        <span className="row-main">
                            <strong>
                                {s.name}
                                {s.personalOf && <span className="muted"> · personal</span>}
                            </strong>
                            <span className="mono muted">{s.owners.join(", ") || "no owner"}</span>
                            <span className="muted operator-facts">
                                {s.members} {s.members === 1 ? "member" : "members"} · {s.websites}{" "}
                                {s.websites === 1 ? "website" : "websites"} ({s.liveWebsites} published) · {compact.format(s.tokens)} tokens
                                in 30 days · made {timeAgo(s.createdAt)}
                            </span>
                        </span>
                        <span className="row-actions">
                            {s.status === "suspended" ? (
                                <span className="chip chip-draft">Suspended</span>
                            ) : s.flags.assistant === false || s.flags.publishing === false ? (
                                <span className="chip chip-draft">Restricted</span>
                            ) : (
                                <span className="chip chip-live">Active</span>
                            )}
                            <button type="button" className="btn btn-sm" onClick={() => setManaging(s)}>
                                Manage
                            </button>
                        </span>
                    </li>
                ))}
            </ul>
            {studios.length === 0 && <p className="muted">No studio matches that.</p>}
            <p className="field-help">
                You can pause a studio, switch parts of Atelier off for it, and set its limits. You cannot see inside its websites from
                here.
            </p>

            {managing && (
                <Manage
                    studio={managing}
                    onClose={() => setManaging(null)}
                    onSaved={() => {
                        setManaging(null);
                        void load();
                    }}
                />
            )}
        </div>
    );
}

function Manage({ studio, onClose, onSaved }: { studio: StudioSummary; onClose: () => void; onSaved: () => void }) {
    const toast = useToast();
    const [assistant, setAssistant] = useState(studio.flags.assistant !== false);
    const [publishing, setPublishing] = useState(studio.flags.publishing !== false);
    const [websites, setWebsites] = useState(studio.maxProjects === null ? "" : String(studio.maxProjects));
    const [millions, setMillions] = useState(studio.dailyTokenLimit === null ? "" : String(studio.dailyTokenLimit / 1_000_000));
    const [busy, setBusy] = useState(false);
    const suspended = studio.status === "suspended";

    async function apply(changes: Parameters<typeof api.operatorUpdate>[1], done: string) {
        setBusy(true);
        try {
            await api.operatorUpdate(studio.id, changes);
            toast(done);
            onSaved();
        } catch (err) {
            if (err instanceof ReauthRequired) {
                toast("Please confirm your sign-in, then try that again.", "error");
                setTimeout(reauthenticate, 1400);
            } else toast((err as Error).message, "error");
            setBusy(false);
        }
    }

    function save(e: FormEvent) {
        e.preventDefault();
        const max = websites.trim() === "" ? null : Number(websites);
        const daily = millions.trim() === "" ? null : Math.round(Number(millions) * 1_000_000);
        if ((max !== null && (!Number.isInteger(max) || max < 1)) || (daily !== null && (!Number.isFinite(daily) || daily < 1))) {
            toast("Limits must be numbers above zero, or empty for the default.", "error");
            return;
        }
        void apply({ flags: { assistant, publishing }, maxProjects: max, dailyTokenLimit: daily }, `${studio.name} updated.`);
    }

    return (
        <Dialog onClose={onClose} wide>
            <form onSubmit={save}>
                <p className="eyebrow">Manage studio</p>
                <h2>{studio.name}</h2>
                <p className="mono muted">{studio.owners.join(", ")}</p>

                <fieldset className="switches">
                    <legend className="eyebrow">What this studio may use</legend>
                    <label>
                        <input type="checkbox" checked={assistant} onChange={(e) => setAssistant(e.target.checked)} />
                        <span>
                            <strong>The assistant</strong>
                            <span className="muted">
                                Off: its members can look and edit wording, but cannot ask the assistant for anything.
                            </span>
                        </span>
                    </label>
                    <label>
                        <input type="checkbox" checked={publishing} onChange={(e) => setPublishing(e.target.checked)} />
                        <span>
                            <strong>Publishing</strong>
                            <span className="muted">Off: nothing new can go public. Websites already published stay as they are.</span>
                        </span>
                    </label>
                </fieldset>

                <div className="limit-pair">
                    <label className="field-line">
                        <span className="eyebrow">Most websites</span>
                        <input
                            value={websites}
                            onChange={(e) => setWebsites(e.target.value.replace(/\D/g, ""))}
                            placeholder="Default"
                            inputMode="numeric"
                        />
                    </label>
                    <label className="field-line">
                        <span className="eyebrow">Assistant tokens a day, in millions</span>
                        <input
                            value={millions}
                            onChange={(e) => setMillions(e.target.value.replace(/[^0-9.]/g, ""))}
                            placeholder="No limit"
                            inputMode="decimal"
                        />
                    </label>
                </div>
                <p className="field-help">
                    Leave a limit empty to use the default. A studio's owner can also set a daily token limit of their own.
                </p>

                <div className="dialog-actions dialog-actions-split">
                    {suspended ? (
                        <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => void apply({ status: "active" }, `${studio.name} is restored.`)}
                        >
                            <PlayCircle /> Restore this studio
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="btn btn-danger"
                            disabled={busy}
                            onClick={() => void apply({ status: "suspended" }, `${studio.name} is suspended.`)}
                            title="Its members are told it is suspended and can do nothing in it until you restore it. Published websites stay up."
                        >
                            <PauseCircle /> Suspend this studio
                        </button>
                    )}
                    <span>
                        <button type="button" className="btn" onClick={onClose}>
                            Close
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={busy}>
                            {busy ? <Dots /> : "Save"}
                        </button>
                    </span>
                </div>
                <p className="field-help settings-note">
                    {suspended
                        ? "This studio is suspended: its members are told so and can do nothing in it. Its published websites are still up."
                        : "Suspending stops everything in this studio at once and tells its members why. Published websites stay up; nothing is deleted."}
                </p>
            </form>
        </Dialog>
    );
}

const ACTION: Record<string, string> = {
    "auth.sign_in": "Signed in",
    "admin.suspend": "Suspended a studio",
    "admin.restore": "Restored a studio",
    "admin.update": "Changed a studio's limits or switches",
    "org.create": "A studio was made",
    "invitation.create": "Added someone to a studio",
    "invitation.accept": "Joined a studio",
    "member.remove": "Removed a member",
    "project.create": "Made a website",
    "project.delete": "Deleted a website",
    "release.publish": "Published",
    "release.unpublish": "Took a website offline",
    "domain.add": "Added a domain",
    "provider.connect": "Connected a model provider",
};

function Activity() {
    const toast = useToast();
    const [entries, setEntries] = useState<AuditEntry[] | null>(null);
    useEffect(() => {
        api.operatorActivity().then(setEntries, (err: Error) => toast(err.message, "error"));
    }, [toast]);
    if (!entries) {
        return (
            <div className="panel panel-loading">
                <Dots />
            </div>
        );
    }
    return (
        <div className="panel">
            <p className="field-help panel-lede">
                The most recent things done across every studio. This record cannot be edited or cleared.
            </p>
            <ul className="rows">
                {entries.map((e) => (
                    <li key={e.id}>
                        <span className="row-main">
                            <strong>{ACTION[e.action] ?? e.action.replace(/[._]/g, " ")}</strong>
                            <span className="mono muted">{detail(e)}</span>
                        </span>
                        <span className="mono muted">{timeAgo(e.occurredAt)}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function detail(e: AuditEntry): string {
    const d = e.detail ?? {};
    return ["name", "slug", "email", "hostname", "status"]
        .map((k) => d[k])
        .filter((v): v is string => typeof v === "string")
        .join(" · ");
}
