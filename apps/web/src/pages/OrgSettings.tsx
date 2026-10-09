import { LogOut, Mail, Trash2, X } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEntry, Invitation, Member, Org, Project, Role, Session, Usage } from "../lib/api";
import { can, orgApi, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, timeAgo } from "../lib/hooks";
import { Dots, useToast } from "../ui/kit";
import { StudioNav } from "../ui/StudioNav";

export type SettingsTab = "general" | "members" | "usage" | "activity";

interface Props {
    session: Session;
    org: Org;
    orgs: Org[];
    tab: SettingsTab;
    onOrgsChanged: () => Promise<Org[]>;
    theme: Theme;
    onToggleTheme: () => void;
}

const TAB_LABEL: Record<SettingsTab, string> = { general: "General", members: "Members", usage: "Usage", activity: "Activity" };

export function OrgSettings({ session, org, orgs, tab, onOrgsChanged, theme, onToggleTheme }: Props) {
    const mayManage = can.manage(org.role);
    // General and Activity are for owners and admins; everyone sees Members and Usage.
    const tabs: SettingsTab[] = mayManage ? ["general", "members", "usage", "activity"] : ["members", "usage"];
    const current = tabs.includes(tab) ? tab : "members";

    return (
        <div className="studio">
            <StudioNav
                session={session}
                org={org}
                orgs={orgs}
                onOrgsChanged={onOrgsChanged}
                theme={theme}
                onToggleTheme={onToggleTheme}
                section="settings"
            />
            <main className="studio-main settings">
                <p className="eyebrow">{org.name}</p>
                <h1 className="display">
                    The <em>studio.</em>
                </h1>
                <div className="tabs settings-tabs" role="tablist">
                    {tabs.map((t) => (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={current === t}
                            className={current === t ? "on" : ""}
                            onClick={() => navigate(`/o/${org.slug}/settings/${t}`)}
                        >
                            {TAB_LABEL[t]}
                        </button>
                    ))}
                </div>
                {current === "general" && <General org={org} onOrgsChanged={onOrgsChanged} />}
                {current === "members" && <Members org={org} session={session} onOrgsChanged={onOrgsChanged} />}
                {current === "usage" && <UsagePanel org={org} />}
                {current === "activity" && <Activity org={org} />}
            </main>
        </div>
    );
}

// Privileged changes may ask for a fresh sign-in; say why, then go.
function useReauth() {
    const toast = useToast();
    return useCallback(
        (err: unknown) => {
            if (err instanceof ReauthRequired) {
                toast("Please confirm your sign-in, then try that again.", "error");
                setTimeout(reauthenticate, 1400);
            } else toast((err as Error).message, "error");
        },
        [toast],
    );
}

// ---- general -------------------------------------------------------------------------

function General({ org, onOrgsChanged }: { org: Org; onOrgsChanged: () => Promise<Org[]> }) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [name, setName] = useState(org.name);
    const [model, setModel] = useState(org.defaultModel ?? "");
    const [saving, setSaving] = useState(false);
    const dirty = name.trim() !== org.name || model.trim() !== (org.defaultModel ?? "");

    async function save(e: FormEvent) {
        e.preventDefault();
        setSaving(true);
        try {
            await a.update({ name: name.trim(), defaultModel: model.trim() || null });
            await onOrgsChanged();
            toast("Saved.");
        } catch (err) {
            toast((err as Error).message, "error");
        } finally {
            setSaving(false);
        }
    }

    return (
        <form className="panel" onSubmit={save}>
            <label className="field-line">
                <span className="eyebrow">Studio name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <div className="field-line">
                <span className="eyebrow">Address</span>
                <p className="mono field-static">/o/{org.slug}</p>
                <p className="field-help">The address stays the same when you rename the studio, so links keep working.</p>
            </div>
            <label className="field-line">
                <span className="eyebrow">Assistant model</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Automatic" maxLength={120} className="mono" />
                <span className="field-help">
                    Leave empty to use the assistant's default. A website can choose its own in its settings. Written as provider/model.
                </span>
            </label>
            <div className="panel-foot">
                <button type="submit" className="btn btn-primary" disabled={!dirty || saving || !name.trim()}>
                    {saving ? <Dots /> : "Save changes"}
                </button>
            </div>
        </form>
    );
}

// ---- members -------------------------------------------------------------------------

const ROLE_HELP: Record<Role, string> = {
    owner: "Everything, including who the owners are",
    admin: "Websites, publishing, members",
    editor: "Edit websites with the assistant",
    viewer: "Look, but not change",
};

function Members({ org, session, onOrgsChanged }: { org: Org; session: Session; onOrgsChanged: () => Promise<Org[]> }) {
    const toast = useToast();
    const fail = useReauth();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const mayManage = can.manage(org.role);
    const [members, setMembers] = useState<Member[] | null>(null);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<Invitation["role"]>("editor");
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            setMembers(await a.listMembers());
            if (mayManage) setInvitations(await a.listInvitations());
        } catch (err) {
            setMembers([]);
            toast((err as Error).message, "error");
        }
    }, [a, mayManage, toast]);
    useEffect(() => {
        void load();
    }, [load]);

    async function invite(e: FormEvent) {
        e.preventDefault();
        if (!email.trim() || busy) return;
        setBusy(true);
        try {
            await a.invite(email.trim(), role);
            setEmail("");
            toast("Invitation ready. They join the next time they sign in with that address.");
            await load();
        } catch (err) {
            toast((err as Error).message, "error");
        } finally {
            setBusy(false);
        }
    }

    const change = (m: Member, next: Role) => a.setRole(m.userId, next).then(load, fail);

    async function remove(m: Member) {
        const self = m.userId === session.id;
        try {
            await a.removeMember(m.userId);
            if (self) {
                await onOrgsChanged();
                navigate("/studio");
            } else {
                toast(`${m.name || m.email} no longer has access.`);
                await load();
            }
        } catch (err) {
            fail(err);
        }
    }

    const owners = members?.filter((m) => m.role === "owner").length ?? 0;

    return (
        <div className="panel">
            {members === null ? (
                <div className="panel-loading">
                    <Dots />
                </div>
            ) : (
                <ul className="rows">
                    {members.map((m) => {
                        const self = m.userId === session.id;
                        const lastOwner = m.role === "owner" && owners === 1;
                        // Admins manage everyone but owners; owners manage everyone.
                        const editable = mayManage && !lastOwner && (org.role === "owner" || m.role !== "owner");
                        return (
                            <li key={m.userId}>
                                <span className="avatar avatar-static" aria-hidden="true">
                                    {(m.name || m.email).charAt(0).toUpperCase()}
                                </span>
                                <span className="row-main">
                                    <strong>
                                        {m.name || m.email}
                                        {self && <span className="muted"> · you</span>}
                                    </strong>
                                    <span className="mono muted">{m.email}</span>
                                </span>
                                <span className="row-actions">
                                    {editable ? (
                                        <select
                                            className="select"
                                            value={m.role}
                                            onChange={(e) => void change(m, e.target.value as Role)}
                                            aria-label={`Role for ${m.name || m.email}`}
                                        >
                                            {(org.role === "owner"
                                                ? (["owner", "admin", "editor", "viewer"] as const)
                                                : (["admin", "editor", "viewer"] as const)
                                            ).map((r) => (
                                                <option key={r} value={r}>
                                                    {r.charAt(0).toUpperCase() + r.slice(1)}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <span className="chip chip-plain" title={ROLE_HELP[m.role]}>
                                            {m.role}
                                        </span>
                                    )}
                                    {self ? (
                                        <button
                                            type="button"
                                            className="btn btn-sm"
                                            disabled={lastOwner}
                                            title={
                                                lastOwner
                                                    ? "A studio needs an owner. Make someone else an owner first."
                                                    : "Leave this studio"
                                            }
                                            onClick={() => void remove(m)}
                                        >
                                            <LogOut /> Leave
                                        </button>
                                    ) : (
                                        editable && (
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-icon"
                                                title="Remove from the studio"
                                                onClick={() => void remove(m)}
                                            >
                                                <X />
                                            </button>
                                        )
                                    )}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}

            {mayManage && (
                <>
                    <h2 className="panel-title">Invite someone</h2>
                    <form className="invite" onSubmit={invite}>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="name@example.com"
                            aria-label="E-mail address"
                        />
                        <select
                            className="select"
                            value={role}
                            onChange={(e) => setRole(e.target.value as Invitation["role"])}
                            aria-label="Role"
                        >
                            <option value="admin">Admin</option>
                            <option value="editor">Editor</option>
                            <option value="viewer">Viewer</option>
                        </select>
                        <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
                            <Mail /> Invite
                        </button>
                    </form>
                    <p className="field-help">
                        {ROLE_HELP[role]}. Atelier doesn't send e-mail: tell them yourself. They join this studio the next time they sign in
                        with that address.
                    </p>

                    {invitations.length > 0 && (
                        <ul className="rows rows-quiet">
                            {invitations.map((i) => (
                                <li key={i.id}>
                                    <span className="row-main">
                                        <strong>{i.email}</strong>
                                        <span className="mono muted">
                                            invited as {i.role} · expires {timeAgo(i.expiresAt)}
                                        </span>
                                    </span>
                                    <span className="row-actions">
                                        <button
                                            type="button"
                                            className="btn btn-sm"
                                            onClick={() =>
                                                a.revokeInvitation(i.id).then(load, (err) => toast((err as Error).message, "error"))
                                            }
                                        >
                                            <Trash2 /> Withdraw
                                        </button>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}

// ---- usage ---------------------------------------------------------------------------

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function Meter({ label, used, limit, unit }: { label: string; used: number; limit: number; unit: string }) {
    const ratio = Math.min(1, limit > 0 ? used / limit : 0);
    return (
        <div className="meter">
            <div className="meter-head">
                <span className="eyebrow">{label}</span>
                <span className="mono">
                    {compact.format(used)}{" "}
                    <span className="muted">
                        of {compact.format(limit)} {unit}
                    </span>
                </span>
            </div>
            <div className={`meter-track ${ratio >= 1 ? "full" : ratio >= 0.8 ? "near" : ""}`}>
                <i style={{ width: `${Math.max(ratio * 100, used > 0 ? 1.5 : 0)}%` }} />
            </div>
        </div>
    );
}

function UsagePanel({ org }: { org: Org }) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [usage, setUsage] = useState<Usage | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);

    useEffect(() => {
        Promise.all([a.usage(), a.listProjects(), a.listProjects(true)])
            .then(([u, live, archived]) => {
                setUsage(u);
                setProjects([...live, ...archived]);
            })
            .catch((err: Error) => toast(err.message, "error"));
    }, [a, toast]);

    if (!usage) {
        return (
            <div className="panel panel-loading">
                <Dots />
            </div>
        );
    }

    const names = new Map(projects.map((p) => [p.id, p.name]));
    const rows = new Map<string, { runs: number; tokens: number; seconds: number }>();
    for (const u of usage.last30Days) {
        const key = u.projectId ?? "";
        const row = rows.get(key) ?? { runs: 0, tokens: 0, seconds: 0 };
        if (u.kind === "agent.runs") row.runs += u.units;
        else if (u.kind === "agent.seconds") row.seconds += u.units;
        else if (u.kind.endsWith("_tokens")) row.tokens += u.units;
        rows.set(key, row);
    }
    const table = [...rows.entries()].sort((x, y) => y[1].tokens - x[1].tokens);

    return (
        <div className="panel">
            <Meter label="Assistant today" used={usage.today.tokens} limit={usage.limits.dailyTokenLimit} unit="tokens" />
            <Meter label="Websites" used={usage.projects} limit={usage.limits.maxProjects} unit="" />
            <p className="field-help">
                These are safety ceilings, not charges. The daily one resets at midnight UTC; when it is reached, the assistant pauses until
                then.
            </p>

            <h2 className="panel-title">Last 30 days</h2>
            {table.length === 0 ? (
                <p className="muted">Nothing yet. Usage appears here after the assistant's first request.</p>
            ) : (
                <table className="table">
                    <thead>
                        <tr>
                            <th>Website</th>
                            <th>Requests</th>
                            <th>Tokens</th>
                            <th>Working time</th>
                        </tr>
                    </thead>
                    <tbody>
                        {table.map(([id, r]) => (
                            <tr key={id}>
                                <td>{names.get(id) ?? <span className="muted">Deleted website</span>}</td>
                                <td className="mono">{r.runs}</td>
                                <td className="mono">{compact.format(r.tokens)}</td>
                                <td className="mono">{r.seconds >= 60 ? `${Math.round(r.seconds / 60)} min` : `${r.seconds} s`}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

// ---- activity ------------------------------------------------------------------------

const ACTION: Record<string, string> = {
    "org.create": "Created the studio",
    "org.update": "Changed studio settings",
    "member.role": "Changed a member's role",
    "member.remove": "Removed a member",
    "member.leave": "Left the studio",
    "invitation.create": "Invited someone",
    "invitation.revoke": "Withdrew an invitation",
    "invitation.accept": "Joined by invitation",
    "project.create": "Created a website",
    "project.update": "Changed a website's settings",
    "project.archive": "Archived a website",
    "project.restore": "Restored a website",
    "project.delete": "Deleted a website",
    "release.create": "Prepared a release",
    "release.publish": "Published",
    "release.rollback": "Rolled back",
    "workspace.restore": "Restored an earlier version",
    "content.restore": "Restored earlier content",
};

function describe(e: AuditEntry): string {
    const d = e.detail ?? {};
    const bits: string[] = [];
    if (typeof d.email === "string") bits.push(d.email);
    if (typeof d.slug === "string") bits.push(d.slug);
    if (typeof d.name === "string" && typeof d.slug !== "string") bits.push(d.name);
    if (typeof d.number === "number") bits.push(`release ${d.number}`);
    if (typeof d.from === "string" && typeof d.to === "string") bits.push(`${d.from} → ${d.to}`);
    if (typeof d.role === "string" && typeof d.to !== "string") bits.push(d.role);
    return bits.join(" · ");
}

function Activity({ org }: { org: Org }) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [entries, setEntries] = useState<AuditEntry[] | null>(null);
    const [people, setPeople] = useState<Map<string, string>>(new Map());

    useEffect(() => {
        Promise.all([a.audit(), a.listMembers()])
            .then(([log, members]) => {
                setEntries(log);
                setPeople(new Map(members.map((m) => [m.userId, m.name || m.email])));
            })
            .catch((err: Error) => {
                setEntries([]);
                toast(err.message, "error");
            });
    }, [a, toast]);

    if (entries === null) {
        return (
            <div className="panel panel-loading">
                <Dots />
            </div>
        );
    }
    return (
        <div className="panel">
            {entries.length === 0 ? (
                <p className="muted">Nothing has happened here yet.</p>
            ) : (
                <ul className="rows rows-quiet">
                    {entries.map((e) => (
                        <li key={e.id}>
                            <span className="row-main">
                                <strong>{ACTION[e.action] ?? e.action}</strong>
                                <span className="mono muted">
                                    {[e.actorId ? (people.get(e.actorId) ?? "a former member") : "system", describe(e)]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </span>
                            </span>
                            <span className="mono muted">{timeAgo(e.occurredAt)}</span>
                        </li>
                    ))}
                </ul>
            )}
            <p className="field-help">The record of who did what. It cannot be edited or cleared.</p>
        </div>
    );
}
