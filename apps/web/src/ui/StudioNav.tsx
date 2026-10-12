import { Check, ChevronsUpDown, LayoutGrid, Plus, Settings, Wrench } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useState } from "react";
import type { Org, Session } from "../lib/api";
import { api, can } from "../lib/api";
import { navigate, type Theme, useClickOutside } from "../lib/hooks";
import { Dialog, Dots, menuKeys, UserMenu, useToast, Wordmark } from "./kit";

interface StudioNavProps {
    session: Session;
    org: Org;
    orgs: Org[];
    onOrgsChanged: () => Promise<Org[]>;
    theme: Theme;
    onToggleTheme: () => void;
    // Which section is showing, for the nav highlight.
    section: "websites" | "settings";
}

const ROLE_LABEL: Record<Org["role"], string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };

// The header for everything inside an organisation: which studio you are in (and a
// way to change it), its sections, and your account.
export function StudioNav({ session, org, orgs, onOrgsChanged, theme, onToggleTheme, section }: StudioNavProps) {
    const [open, setOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const ref = useClickOutside(useCallback(() => setOpen(false), []));

    return (
        <header className="studio-nav">
            <div className="studio-nav-left">
                <Wordmark />
                <span className="nav-slash" aria-hidden="true">
                    /
                </span>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: the keys are for the button and the menu inside it */}
                <div className="menu-wrap" ref={ref} onKeyDown={(e) => open && menuKeys(e, () => setOpen(false))}>
                    <button
                        type="button"
                        className="org-switch"
                        onClick={() => setOpen((o) => !o)}
                        aria-expanded={open}
                        aria-haspopup="menu"
                    >
                        <span className="org-label">Studio</span>
                        <span className="org-name">{org.name}</span>
                        <ChevronsUpDown />
                    </button>
                    {open && (
                        <div className="menu menu-left" role="menu">
                            <p className="menu-label eyebrow">Switch studio</p>
                            {orgs.map((o) => (
                                <button
                                    key={o.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setOpen(false);
                                        navigate(`/o/${o.slug}`);
                                    }}
                                >
                                    <span className="menu-main">
                                        {o.name}
                                        <span className="mono muted">
                                            {o.personalOf === session.id
                                                ? "Your personal studio"
                                                : `Shared · you are ${ROLE_LABEL[o.role]?.toLowerCase() ?? "a member"}`}
                                        </span>
                                    </span>
                                    {o.id === org.id && <Check />}
                                </button>
                            ))}
                            <div className="menu-rule" />
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setOpen(false);
                                    setCreating(true);
                                }}
                            >
                                <Plus /> New shared studio
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <nav className="studio-nav-right">
                <button
                    type="button"
                    className={`btn btn-ghost ${section === "websites" ? "on" : ""}`}
                    onClick={() => navigate(`/o/${org.slug}`)}
                >
                    Websites
                </button>
                <button
                    type="button"
                    className={`btn btn-ghost ${section === "settings" ? "on" : ""}`}
                    onClick={() => navigate(`/o/${org.slug}/settings/${can.manage(org.role) ? "general" : "members"}`)}
                >
                    <Settings /> Studio settings
                </button>
                <UserMenu
                    session={session}
                    theme={theme}
                    onToggleTheme={onToggleTheme}
                    // The two sections are in the menu as well: on a phone there is no room for them in the bar.
                    items={[
                        { label: "Websites", icon: <LayoutGrid />, onClick: () => navigate(`/o/${org.slug}`) },
                        {
                            label: "Studio settings",
                            icon: <Settings />,
                            onClick: () => navigate(`/o/${org.slug}/settings/${can.manage(org.role) ? "general" : "members"}`),
                        },
                        ...(session.admin ? [{ label: "Operator console", icon: <Wrench />, onClick: () => navigate("/admin") }] : []),
                    ]}
                />
            </nav>

            {creating && <NewStudio onClose={() => setCreating(false)} onOrgsChanged={onOrgsChanged} />}
        </header>
    );
}

function NewStudio({ onClose, onOrgsChanged }: { onClose: () => void; onOrgsChanged: () => Promise<Org[]> }) {
    const toast = useToast();
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);

    async function create(e: FormEvent) {
        e.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        try {
            const org = await api.createOrg(name.trim());
            await onOrgsChanged();
            onClose();
            navigate(`/o/${org.slug}`);
        } catch (err) {
            toast((err as Error).message, "error");
            setBusy(false);
        }
    }
    // Once the studio is being made it will be made and gone to: backing out is not offered half-way.
    const close = () => {
        if (!busy) onClose();
    };

    return (
        <Dialog onClose={close}>
            <form onSubmit={create}>
                <p className="eyebrow">New shared studio</p>
                <h2>A separate room.</h2>
                <p>
                    A studio has its own websites, members and usage. Make one for a client, a team or a business, then add the people who
                    should work in it. Your personal studio stays as it is.
                </p>
                <label className="field-line">
                    <span className="eyebrow">Name</span>
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Northlight Studio"
                        maxLength={80}
                        autoFocus
                    />
                </label>
                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={close} disabled={busy}>
                        Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                        {busy ? <Dots /> : "Create studio"}
                    </button>
                </div>
            </form>
        </Dialog>
    );
}
