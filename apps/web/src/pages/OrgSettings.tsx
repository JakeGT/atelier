import { ArrowLeft, Download, ExternalLink, LogOut, Mail, Trash2, X } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEntry, Invitation, Member, MonthUsage, Org, Project, ProviderInfo, Role, Session, Usage } from "../lib/api";
import { can, orgApi, ReauthRequired, reauthenticate } from "../lib/api";
import { navigate, type Theme, timeAgo } from "../lib/hooks";
import { Dialog, Dots, useToast } from "../ui/kit";
import { ModelPicker } from "../ui/ModelPicker";
import { StudioNav } from "../ui/StudioNav";

export type SettingsTab = "general" | "models" | "members" | "usage" | "activity";

interface Props {
    session: Session;
    org: Org;
    orgs: Org[];
    tab: SettingsTab;
    onOrgsChanged: () => Promise<Org[]>;
    theme: Theme;
    onToggleTheme: () => void;
}

const TAB_LABEL: Record<SettingsTab, string> = {
    general: "General",
    models: "Models",
    members: "Members",
    usage: "Usage",
    activity: "Activity",
};

export function OrgSettings({ session, org, orgs, tab, onOrgsChanged, theme, onToggleTheme }: Props) {
    const mayManage = can.manage(org.role);
    // General, Models and Activity are for owners and admins; everyone sees Members and Usage.
    const tabs: SettingsTab[] = mayManage ? ["general", "models", "members", "usage", "activity"] : ["members", "usage"];
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
                <button type="button" className="btn btn-ghost btn-sm settings-back" onClick={() => navigate(`/o/${org.slug}`)}>
                    <ArrowLeft /> Back to the studio
                </button>
                <p className="eyebrow">{org.name}</p>
                <h1 className="display">
                    Studio <em>settings.</em>
                </h1>
                <div className="tabs settings-tabs" role="tablist">
                    {tabs.map((t) => (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={current === t}
                            className={current === t ? "on" : ""}
                            onClick={() => navigate(`/o/${org.slug}/settings/${t}`, { quiet: true })}
                        >
                            {TAB_LABEL[t]}
                        </button>
                    ))}
                </div>
                {current === "general" && <General org={org} session={session} onOrgsChanged={onOrgsChanged} />}
                {current === "general" && org.role === "owner" && <Everything org={org} session={session} onOrgsChanged={onOrgsChanged} />}
                {current === "models" && <Models org={org} onOrgsChanged={onOrgsChanged} />}
                {current === "members" && <Members org={org} session={session} onOrgsChanged={onOrgsChanged} />}
                {current === "usage" && <UsagePanel org={org} />}
                {current === "usage" && <MonthByMonth org={org} />}
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

function General({ org, session, onOrgsChanged }: { org: Org; session: Session; onOrgsChanged: () => Promise<Org[]> }) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [name, setName] = useState(org.name);
    const [saving, setSaving] = useState(false);
    const dirty = name.trim() !== org.name;

    async function save(e: FormEvent) {
        e.preventDefault();
        setSaving(true);
        try {
            await a.update({ name: name.trim() });
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
                {org.personalOf === session.id && (
                    <p className="field-help">This is your personal studio. Everyone has one, and it is always theirs.</p>
                )}
                <span className="eyebrow">Link to this studio</span>
                <p className="mono field-static">
                    {window.location.origin}/o/{org.slug}
                </p>
                <p className="field-help">
                    Only members can open it. The link stays the same when you rename the studio, so bookmarks keep working.
                </p>
            </div>
            <div className="panel-foot">
                <button type="submit" className="btn btn-primary" disabled={!dirty || saving || !name.trim()}>
                    {saving ? <Dots /> : "Save changes"}
                </button>
            </div>
        </form>
    );
}

// The whole studio at once: take a copy of everything in it, or delete it. Its owner only.
function Everything({ org, session, onOrgsChanged }: { org: Org; session: Session; onOrgsChanged: () => Promise<Org[]> }) {
    const toast = useToast();
    const reauth = useReauth();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [busy, setBusy] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [typed, setTyped] = useState("");
    const personal = org.personalOf === session.id;

    async function download() {
        setBusy(true);
        try {
            // A link that works for five minutes; the browser saves the file.
            window.location.assign(await a.exportStudio());
            toast("Your download is starting. It may take a while for a studio with many pictures.");
        } catch (err) {
            reauth(err);
        } finally {
            setBusy(false);
        }
    }
    async function remove() {
        setBusy(true);
        try {
            await a.deleteStudio(typed.trim());
            await onOrgsChanged();
            toast(`${org.name} was deleted.`);
            navigate("/studio");
        } catch (err) {
            reauth(err);
            setBusy(false);
        }
    }

    return (
        <>
            <div className="panel">
                <h2 className="panel-title">A copy of everything</h2>
                <p className="muted">
                    Download every website in this studio as files: their pages, wording, pictures, conversations with the assistant and
                    publishing record, in one archive (a .tar file, which any computer can open). Nothing is changed or removed.
                </p>
                <div className="panel-foot">
                    <button type="button" className="btn" onClick={() => void download()} disabled={busy}>
                        <Download /> Download everything in this studio
                    </button>
                </div>
            </div>
            <div className="panel panel-danger">
                <h2 className="panel-title">Delete this studio</h2>
                {personal ? (
                    <p className="muted">
                        This is your personal studio. Everyone keeps theirs, so it cannot be deleted. You can delete the websites in it one
                        at a time.
                    </p>
                ) : (
                    <>
                        <p className="muted">
                            This removes the studio and every website in it for good: their pages and versions, wording, pictures, published
                            websites (which go offline at once) and the keys connected here. Its members lose access and are told. It cannot
                            be undone; download a copy first if you might want any of it.
                        </p>
                        <div className="panel-foot">
                            <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
                                <Trash2 /> Delete this studio…
                            </button>
                        </div>
                    </>
                )}
            </div>
            {deleting && (
                <Dialog onClose={() => setDeleting(false)}>
                    <p className="eyebrow">This cannot be undone</p>
                    <h2>Delete {org.name}?</h2>
                    <p>
                        Every website in this studio will be deleted, and any that are published will go offline now. Everyone in the studio
                        loses access.
                    </p>
                    <label className="field-line">
                        <span className="eyebrow">Type the studio's name to confirm: {org.name}</span>
                        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
                    </label>
                    <div className="dialog-actions">
                        <button type="button" className="btn btn-primary" onClick={() => setDeleting(false)} disabled={busy}>
                            Keep the studio
                        </button>
                        <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => void remove()}
                            disabled={busy || typed.trim() !== org.name}
                        >
                            {busy ? <Dots /> : "Delete it for good"}
                        </button>
                    </div>
                </Dialog>
            )}
        </>
    );
}

// ---- models --------------------------------------------------------------------------

// Bring your own key: connect the providers you have accounts with, then choose
// the model your assistant uses.
function Models({ org, onOrgsChanged }: { org: Org; onOrgsChanged: () => Promise<Org[]> }) {
    const toast = useToast();
    const fail = useReauth();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
    const [connecting, setConnecting] = useState<ProviderInfo | null>(null);
    const [changes, setChanges] = useState(0);

    const load = useCallback(async () => {
        try {
            setProviders(await a.providers());
            setChanges((n) => n + 1);
        } catch (err) {
            setProviders([]);
            toast((err as Error).message, "error");
        }
    }, [a, toast]);
    useEffect(() => {
        void load();
    }, [load]);

    async function setDefault(model: string | null) {
        try {
            await a.update({ defaultModel: model });
            await onOrgsChanged();
            toast(model ? "Your assistant will use that model." : "Back to the assistant's own default.");
        } catch (err) {
            toast((err as Error).message, "error");
        }
    }

    async function disconnect(p: ProviderInfo) {
        try {
            await a.disconnectProvider(p.id);
            toast(`${p.name} is disconnected. Its key has been deleted.`);
            await load();
        } catch (err) {
            fail(err);
        }
    }

    const usesDisconnected =
        org.defaultModel !== null && providers?.find((p) => org.defaultModel?.startsWith(`${p.id}/`))?.connected === false;

    return (
        <div className="panel">
            <div className="field-line">
                <span className="eyebrow">Assistant model</span>
                <ModelPicker
                    api={a}
                    orgSlug={org.slug}
                    value={org.defaultModel}
                    onChange={(m) => void setDefault(m)}
                    automatic="The built-in model"
                    automaticHint="The assistant's built-in model. No key needed. It cannot look at pictures of your pages; it checks its layouts by measurement instead."
                    mayManage
                    refresh={changes}
                />
                <span className="field-help">
                    {usesDisconnected
                        ? "This model's provider isn't connected, so your assistant can't run. Connect it below or choose another model."
                        : "What your assistant uses to build, for every website in this studio. A website can choose its own in its settings."}
                </span>
            </div>

            <h2 className="panel-title">Providers</h2>
            <p className="field-help panel-lede">
                A provider is a company whose AI your assistant can use, such as Anthropic or OpenAI. Connect one by pasting an API key from
                your account with them: you pay them directly, at their prices. Atelier stores the key encrypted and never shows it again.
            </p>
            {providers === null ? (
                <div className="panel-loading">
                    <Dots />
                </div>
            ) : (
                <ul className="rows">
                    {providers.map((p) => (
                        <li key={p.id}>
                            <span className={`provider-mark ${p.connected ? "on" : ""}`} aria-hidden="true">
                                {p.name.charAt(0)}
                            </span>
                            <span className="row-main">
                                <strong>{p.name}</strong>
                                <span className="mono muted">
                                    {p.connected
                                        ? `Key ending ${p.hint}${p.updatedAt ? ` · added ${timeAgo(p.updatedAt)}` : ""}`
                                        : "Not connected"}
                                </span>
                            </span>
                            <span className="row-actions">
                                {p.connected && <span className="chip chip-live">Connected</span>}
                                <button type="button" className="btn btn-sm" onClick={() => setConnecting(p)}>
                                    {p.connected ? "Replace key" : "Connect"}
                                </button>
                                {p.connected && (
                                    <button
                                        type="button"
                                        className="btn btn-sm btn-danger"
                                        title={`Disconnect ${p.name} and delete its key`}
                                        onClick={() => void disconnect(p)}
                                    >
                                        <Trash2 /> Disconnect
                                    </button>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {connecting && (
                <ConnectProvider
                    provider={connecting}
                    onClose={() => setConnecting(null)}
                    onConnect={async (key) => {
                        try {
                            const { verified } = await a.connectProvider(connecting.id, key);
                            toast(
                                verified
                                    ? `${connecting.name} is connected.`
                                    : `Saved. ${connecting.name} couldn't be reached to check the key, so it will be tried on the next request.`,
                            );
                            setConnecting(null);
                            await load();
                        } catch (err) {
                            if (err instanceof ReauthRequired) setConnecting(null);
                            fail(err);
                        }
                    }}
                />
            )}
        </div>
    );
}

function ConnectProvider({
    provider,
    onClose,
    onConnect,
}: {
    provider: ProviderInfo;
    onClose: () => void;
    onConnect: (key: string) => Promise<void>;
}) {
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!key.trim() || busy) return;
        setBusy(true);
        await onConnect(key.trim());
        setBusy(false);
    }
    return (
        <Dialog onClose={onClose} wide>
            <form onSubmit={submit}>
                <p className="eyebrow">{provider.connected ? "Replace key" : "Connect a provider"}</p>
                <h2>{provider.name}</h2>
                <p>
                    Paste an API key from your {provider.name} account. Atelier checks it works, then stores it encrypted.{" "}
                    <a href={provider.keysUrl} target="_blank" rel="noreferrer" className="link">
                        Get a key <ExternalLink size={12} />
                    </a>
                </p>
                <div className="key-form">
                    <input
                        autoFocus
                        type="password"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                        placeholder={provider.keyHint || "API key"}
                        aria-label={`${provider.name} API key`}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>
                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={onClose}>
                        Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={!key.trim() || busy}>
                        {busy ? <Dots /> : provider.connected ? "Replace key" : "Connect"}
                    </button>
                </div>
            </form>
        </Dialog>
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
            toast("Added. This studio appears for them the next time they open Atelier.");
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
            <p className="field-help panel-lede">
                Everyone who can open this studio, and what each may do.
                {org.personalOf === session.id &&
                    " This is your personal studio: it is always yours, so you can't leave it or hand it over."}
            </p>
            {members === null ? (
                <div className="panel-loading">
                    <Dots />
                </div>
            ) : (
                <ul className="rows">
                    {members.map((m) => {
                        const self = m.userId === session.id;
                        // A personal studio's own person always stays its owner.
                        const personal = org.personalOf === m.userId;
                        const lastOwner = m.role === "owner" && owners === 1;
                        // Admins manage everyone but owners; owners manage everyone.
                        const editable = mayManage && !lastOwner && !personal && (org.role === "owner" || m.role !== "owner");
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
                                        <span className="chip chip-plain">{m.role}</span>
                                    )}
                                    {self ? (
                                        // A control that cannot be used says why, in place, instead of sitting there greyed out.
                                        personal ? (
                                            <span className="row-note">Your personal studio</span>
                                        ) : lastOwner ? (
                                            <span className="row-note">
                                                You're the only owner, so you can't leave. Make someone else an owner first.
                                            </span>
                                        ) : (
                                            <button type="button" className="btn btn-sm" onClick={() => void remove(m)}>
                                                <LogOut /> Leave this studio
                                            </button>
                                        )
                                    ) : (
                                        editable && (
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-danger"
                                                title="Remove from the studio"
                                                onClick={() => void remove(m)}
                                            >
                                                <X /> Remove
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
                    <dl className="roles">
                        {(["owner", "admin", "editor", "viewer"] as const).map((r) => (
                            <div key={r}>
                                <dt>{r.charAt(0).toUpperCase() + r.slice(1)}</dt>
                                <dd>{ROLE_HELP[r]}</dd>
                            </div>
                        ))}
                    </dl>

                    <h2 className="panel-title">Add someone to this studio</h2>
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
                            <Mail /> Add
                        </button>
                    </form>
                    <p className="field-help">
                        {ROLE_HELP[role]}. They need to have access to Atelier already (whoever runs it for you gives that); enter the
                        e-mail address they sign in with. This studio then appears for them the next time they open Atelier. No e-mail is
                        sent, so let them know.
                    </p>

                    {invitations.length > 0 && (
                        <ul className="rows rows-quiet">
                            {invitations.map((i) => (
                                <li key={i.id}>
                                    <span className="row-main">
                                        <strong>{i.email}</strong>
                                        <span className="mono muted">
                                            added as {i.role}; waiting for them to open Atelier · expires {timeAgo(i.expiresAt)}
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

// A plain figure, for usage that is measured but not capped.
function Figure({ label, value, unit }: { label: string; value: number; unit: string }) {
    return (
        <div className="meter">
            <div className="meter-head">
                <span className="eyebrow">{label}</span>
                <span className="mono">
                    {compact.format(value)} <span className="muted">{unit}</span>
                </span>
            </div>
        </div>
    );
}

// The studio's own daily limit on assistant tokens: off unless an owner or admin sets one.
function DailyLimit({ limit, onSave }: { limit: number | null; onSave: (limit: number | null) => Promise<void> }) {
    const [editing, setEditing] = useState(false);
    const [millions, setMillions] = useState("");
    const [busy, setBusy] = useState(false);
    const tokens = Math.round(Number(millions) * 1_000_000);
    const valid = millions.trim() !== "" && Number.isFinite(tokens) && tokens >= 1000;

    async function save(next: number | null) {
        setBusy(true);
        await onSave(next);
        setBusy(false);
        setEditing(false);
    }

    if (!editing) {
        return (
            <p className="field-help limit-line">
                {limit === null
                    ? "No daily limit. Your assistant runs on your own provider keys, so usage is measured here but not capped."
                    : "When the daily limit is reached, the assistant pauses until midnight UTC."}{" "}
                <button
                    type="button"
                    className="link"
                    onClick={() => {
                        setMillions(limit === null ? "" : String(limit / 1_000_000));
                        setEditing(true);
                    }}
                >
                    {limit === null ? "Set a daily limit" : "Change"}
                </button>
                {limit !== null && (
                    <>
                        {" · "}
                        <button type="button" className="link" disabled={busy} onClick={() => void save(null)}>
                            Remove the limit
                        </button>
                    </>
                )}
            </p>
        );
    }
    return (
        <form
            className="limit-form"
            onSubmit={(e) => {
                e.preventDefault();
                if (valid && !busy) void save(tokens);
            }}
        >
            <label>
                <span className="eyebrow">Daily limit</span>
                <span className="limit-input">
                    <input
                        // biome-ignore lint/a11y/noAutofocus: shown only after asking to set the limit
                        autoFocus
                        inputMode="decimal"
                        value={millions}
                        onChange={(e) => setMillions(e.target.value.replace(/[^0-9.]/g, ""))}
                        placeholder="5"
                        aria-label="Daily limit, in millions of tokens"
                    />
                    <span className="muted">million tokens a day</span>
                </span>
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
                Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!valid || busy}>
                {busy ? <Dots /> : "Save limit"}
            </button>
        </form>
    );
}

function UsagePanel({ org }: { org: Org }) {
    const toast = useToast();
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [usage, setUsage] = useState<Usage | null>(null);
    const [projects, setProjects] = useState<Project[]>([]);

    const load = useCallback(
        () =>
            Promise.all([a.usage(), a.listProjects(), a.listProjects(true)])
                .then(([u, live, archived]) => {
                    setUsage(u);
                    setProjects([...live, ...archived]);
                })
                .catch((err: Error) => toast(err.message, "error")),
        [a, toast],
    );
    useEffect(() => {
        void load();
    }, [load]);

    async function setLimit(limit: number | null) {
        try {
            await a.update({ dailyTokenLimit: limit });
            await load();
            toast(limit === null ? "The daily limit is removed." : "Daily limit saved.");
        } catch (err) {
            toast((err as Error).message, "error");
        }
    }

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
            {usage.limits.dailyTokenLimit === null ? (
                <Figure label="Assistant today" value={usage.today.tokens} unit="tokens" />
            ) : (
                <Meter label="Assistant today" used={usage.today.tokens} limit={usage.limits.dailyTokenLimit} unit="tokens" />
            )}
            {can.manage(org.role) ? (
                <DailyLimit limit={usage.limits.dailyTokenLimit} onSave={setLimit} />
            ) : (
                usage.limits.dailyTokenLimit !== null && (
                    <p className="field-help limit-line">When the daily limit is reached, the assistant pauses until midnight UTC.</p>
                )
            )}
            <p className="field-help limit-line">
                A token is how AI use is counted: about three-quarters of a word. Your provider bills you for them.
            </p>
            <Meter label="Websites in this studio" used={usage.projects} limit={usage.limits.maxProjects} unit="" />

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

function MonthByMonth({ org }: { org: Org }) {
    const a = useMemo(() => orgApi(org.slug), [org.slug]);
    const [months, setMonths] = useState<MonthUsage[] | null>(null);
    useEffect(() => {
        a.monthlyUsage().then(setMonths, () => setMonths([]));
    }, [a]);
    const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
    const name = (month: string) =>
        new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
    if (!months || months.length === 0) return null;
    return (
        <div className="panel">
            <h2 className="panel-title">Month by month</h2>
            <p className="muted">
                The last twelve months. Tokens are what your model provider bills you for. The cost is an estimate from each model's list
                price at the time; your provider's bill is what counts. Requests made with the built-in model have no price.
            </p>
            <table className="table">
                <thead>
                    <tr>
                        <th>Month</th>
                        <th>Requests</th>
                        <th>Working time</th>
                        <th>Tokens read</th>
                        <th>Tokens written</th>
                        <th>Estimated cost</th>
                    </tr>
                </thead>
                <tbody>
                    {months.map((m) => (
                        <tr key={m.month}>
                            <td>{name(m.month)}</td>
                            <td className="mono">{m.requests}</td>
                            <td className="mono">{m.minutes >= 60 ? `${(m.minutes / 60).toFixed(1)} h` : `${m.minutes} min`}</td>
                            <td className="mono">{compact.format(m.tokensIn)}</td>
                            <td className="mono">{compact.format(m.tokensOut)}</td>
                            <td className="mono">
                                {m.cost === null ? <span className="muted">not known</span> : `about $${m.cost.toFixed(2)}`}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ---- activity ------------------------------------------------------------------------

const ACTION: Record<string, string> = {
    "org.create": "Created the studio",
    "org.update": "Changed studio settings",
    "org.export": "Downloaded a copy of everything",
    "project.look": "Changed a website's look",
    "template.save": "Saved a website as a template",
    "template.remove": "Removed a template",
    "release.share": "Made a link to show someone a website",
    "project.member": "Changed someone's role on a website",
    "media.upload": "Uploaded a file",
    "media.remove": "Removed a file",
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
    "release.create": "Started publishing",
    "release.publish.failed": "A publish did not go through",
    "release.rollback.failed": "Putting an earlier release back did not go through",
    "release.unpublish": "Took a website offline",
    "domain.add": "Added a domain",
    "domain.remove": "Removed a domain",
    "provider.connect": "Connected a model provider",
    "provider.disconnect": "Disconnected a model provider",
    "release.publish": "Published",
    "release.rollback": "Put an earlier release back",
    "workspace.restore": "Restored an earlier version",
    "content.restore": "Restored earlier content",
};

function describe(e: AuditEntry): string {
    const d = e.detail ?? {};
    const bits: string[] = [];
    if (typeof d.email === "string") bits.push(d.email);
    if (typeof d.hostname === "string") bits.push(d.hostname);
    if (typeof d.reason === "string") bits.push(d.reason);
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
