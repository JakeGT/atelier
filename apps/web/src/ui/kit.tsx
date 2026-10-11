import { ArrowRight, Bell, Check, LogOut, MessageSquareWarning, Moon, RefreshCw, Sun, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Inbox, Session } from "../lib/api";
import { api, isStale, UPDATE_EVENT } from "../lib/api";
import { navigate, type Theme, timeAgo, useClickOutside } from "../lib/hooks";

export function Wordmark({ to = "/" }: { to?: string }) {
    return (
        <a
            className="wordmark"
            href={to}
            onClick={(e) => {
                e.preventDefault();
                navigate(to);
            }}
        >
            Atelier
        </a>
    );
}

export function Dots() {
    return (
        <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
        </span>
    );
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
    return (
        <button type="button" className="btn btn-ghost" onClick={onToggle} title="Switch between light and dark colours">
            {theme === "paper" ? <Moon /> : <Sun />} {theme === "paper" ? "Night" : "Day"}
        </button>
    );
}

// `theme` + `onToggleTheme`: where the page has no room for a separate theme
// button, the switch lives here, in words.
// `items`: the page's own actions, repeated here in words so they can always be found
// (on a narrow screen there is no room for them in the bar).
export interface MenuItem {
    label: string;
    icon: ReactNode;
    onClick: () => void;
}

export function UserMenu({
    session,
    theme,
    onToggleTheme,
    items = [],
}: {
    session: Session;
    theme?: Theme;
    onToggleTheme?: () => void;
    items?: MenuItem[];
}) {
    const [open, setOpen] = useState(false);
    const ref = useClickOutside(useCallback(() => setOpen(false), []));
    const initial = (session.name || session.email).trim().charAt(0).toUpperCase();
    const { inbox, showing, show, hide, setEmail } = useInbox();
    const unread = inbox?.unread ?? 0;
    return (
        <div className="menu-wrap" ref={ref}>
            {/* Something new: said in words, beside the account button, until it has been looked at. */}
            {unread > 0 && (
                <button type="button" className="btn btn-sm notice-new" onClick={show}>
                    <Bell /> {unread} new {unread === 1 ? "notification" : "notifications"}
                </button>
            )}
            {showing && inbox && <NoticeList inbox={inbox} onClose={hide} onEmail={setEmail} />}
            <button type="button" className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account" aria-expanded={open}>
                {initial}
            </button>
            {open && (
                <div className="menu" role="menu">
                    <div className="menu-head">
                        <strong>{session.name}</strong>
                        <span className="mono muted">{session.email}</span>
                    </div>
                    {items.map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                                setOpen(false);
                                item.onClick();
                            }}
                        >
                            {item.icon} {item.label}
                        </button>
                    ))}
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            show();
                        }}
                    >
                        <Bell /> Notifications{unread > 0 ? ` (${unread} new)` : ""}
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            window.dispatchEvent(new CustomEvent("atelier:report", { detail: "" }));
                        }}
                    >
                        <MessageSquareWarning /> Report a problem or suggest an idea
                    </button>
                    {items.length > 0 && <div className="menu-rule" />}
                    {theme && onToggleTheme && (
                        <button type="button" role="menuitem" onClick={onToggleTheme}>
                            {theme === "paper" ? <Moon /> : <Sun />}{" "}
                            {theme === "paper" ? "Switch to night colours" : "Switch to daylight colours"}
                        </button>
                    )}
                    <button type="button" role="menuitem" onClick={() => void api.logout()}>
                        <LogOut /> Sign out
                    </button>
                </div>
            )}
        </div>
    );
}

// ---- notifications ---------------------------------------------------------------------

// What happened while the person was not looking (a request that did not finish,
// a website that could not be published). Checked every minute and whenever the
// window is returned to.
function useInbox() {
    const [inbox, setInbox] = useState<Inbox | null>(null);
    const [showing, setShowing] = useState(false);
    const load = useCallback(() => api.notifications().then(setInbox, () => {}), []);
    useEffect(() => {
        void load();
        const timer = setInterval(() => !document.hidden && void load(), 60_000);
        const onFocus = () => void load();
        window.addEventListener("focus", onFocus);
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", onFocus);
        };
    }, [load]);
    return {
        inbox,
        showing,
        show: () => {
            setShowing(true);
            void load();
        },
        // Closing the list is what marks them as seen, so they stay marked "new" while it is open.
        hide: () => {
            setShowing(false);
            void api.readNotifications().then(load, () => {});
        },
        setEmail: (on: boolean) => {
            setInbox((i) => (i ? { ...i, email: on } : i));
            void api.emailNotifications(on).then(load, load);
        },
    };
}

function NoticeList({ inbox, onClose, onEmail }: { inbox: Inbox; onClose: () => void; onEmail: (on: boolean) => void }) {
    return (
        <Dialog onClose={onClose} wide>
            <h2 className="display">Notifications</h2>
            {inbox.notifications.length === 0 ? (
                <p className="muted">
                    Nothing yet. You are told here when a request to your assistant does not finish, or a website cannot be published.
                </p>
            ) : (
                <ol className="notices">
                    {inbox.notifications.map((n) => (
                        <li key={n.id} className={n.readAt ? "" : "notice-unread"}>
                            <div>
                                <strong>{n.title}</strong>
                                {!n.readAt && <span className="chip chip-seal">New</span>}
                            </div>
                            <p>{n.body}</p>
                            <div className="notice-foot">
                                <span className="mono muted">{timeAgo(n.createdAt)}</span>
                                {n.link && (
                                    <button
                                        type="button"
                                        className="btn btn-sm"
                                        onClick={() => {
                                            onClose();
                                            navigate(n.link ?? "/");
                                        }}
                                    >
                                        Go and look <ArrowRight />
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ol>
            )}
            <label className="check notice-email">
                <input
                    type="checkbox"
                    checked={inbox.email && inbox.emailAvailable}
                    disabled={!inbox.emailAvailable}
                    onChange={(e) => onEmail(e.target.checked)}
                />
                <span>
                    E-mail me about these too
                    {!inbox.emailAvailable && <span className="muted"> (e-mail is not set up on this Atelier yet)</span>}
                </span>
            </label>
            <div className="dialog-actions">
                <button type="button" className="btn btn-primary" onClick={onClose}>
                    Close
                </button>
            </div>
        </Dialog>
    );
}

// ---- dialog -------------------------------------------------------------------------

export function Dialog({ onClose, children, wide }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only dismisses; Escape does the same for keyboards
        <div
            className="scrim"
            role="presentation"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className={`dialog ${wide ? "dialog-wide" : ""}`} role="dialog" aria-modal="true">
                {children}
            </div>
        </div>
    );
}

// ---- toasts -------------------------------------------------------------------------

interface Toast {
    id: number;
    text: string;
    kind: "ok" | "error";
}

const ToastContext = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t.slice(-2), { id, text, kind }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6500 : 3800);
    }, []);
    const value = useMemo(() => push, [push]);
    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="toasts" aria-live="polite">
                {toasts.map((t) => (
                    <div key={t.id} className={`toast ${t.kind === "error" ? "toast-error" : ""}`}>
                        {t.kind === "error" ? <TriangleAlert /> : <Check />}
                        {t.text}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

// Shown when the server has been updated since this tab loaded. Reloading is the
// person's choice (they may be mid-thought), but old code and a new server can
// disagree, so the notice stays until they do.
export function UpdateNotice() {
    const [show, setShow] = useState(isStale);
    useEffect(() => {
        const on = () => setShow(true);
        window.addEventListener(UPDATE_EVENT, on);
        return () => window.removeEventListener(UPDATE_EVENT, on);
    }, []);
    if (!show) return null;
    return (
        <div className="update-notice" role="status">
            <span>Atelier has been updated.</span>
            <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
                <RefreshCw /> Reload
            </button>
        </div>
    );
}
