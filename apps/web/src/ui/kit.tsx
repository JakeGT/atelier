import { ArrowRight, Bell, Check, LogOut, MessageSquareWarning, Moon, RefreshCw, Sun, TriangleAlert } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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

// The keys a menu answers to: Escape closes it (and goes back to the button that opened it),
// the arrows, Home and End move through what it offers. Goes on the element that holds both
// the button and the menu.
export function menuKeys(e: ReactKeyboardEvent<HTMLElement>, close: () => void): void {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (!items.length) return;
    if (e.key === "Escape") {
        e.stopPropagation();
        close();
        e.currentTarget.querySelector<HTMLElement>("[aria-expanded]")?.focus();
        return;
    }
    const at = items.indexOf(document.activeElement as HTMLElement);
    let to: number;
    if (e.key === "ArrowDown") to = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === "ArrowUp") to = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = items.length - 1;
    else return;
    e.preventDefault();
    items[to]?.focus();
}

// Tab stays inside `box` (a dialog) while focus is in it. Focus that is in another dialog,
// such as a picker opened on top of this one, is left to that one.
export function keepTabInside(e: { key: string; shiftKey: boolean; preventDefault: () => void }, box: HTMLElement | null): void {
    if (e.key !== "Tab" || !box) return;
    const holder = document.activeElement?.closest('[role="dialog"]') ?? null;
    // Focus on nothing at all belongs to whichever dialog was opened last.
    if (holder ? holder !== box : [...document.querySelectorAll('[role="dialog"]')].at(-1) !== box) return;
    const stops = [
        ...box.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ].filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
    const first = stops[0];
    const last = stops.at(-1);
    const now = document.activeElement;
    if (!first || !last) {
        e.preventDefault();
        return;
    }
    if (e.shiftKey && (now === first || !holder || now === box)) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && (now === last || !holder)) {
        e.preventDefault();
        first.focus();
    }
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
    const toast = useToast();
    const ref = useClickOutside(useCallback(() => setOpen(false), []));
    // The first whole character of their name; of their address if they have given no name.
    const initial = (Array.from(session.name.trim())[0] ?? Array.from(session.email.trim())[0] ?? "").toUpperCase();
    const { inbox, showing, show, hide, setEmail } = useInbox();
    const unread = inbox?.unread ?? 0;
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: the keys are for the button and the menu inside it
        <div className="menu-wrap" ref={ref} onKeyDown={(e) => open && menuKeys(e, () => setOpen(false))}>
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
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setOpen(false);
                            // Signing out that did not happen is said, so nobody walks away thinking they are signed out.
                            api.logout().catch((err: Error) => toast(`You are still signed in. ${err.message}`, "error"));
                        }}
                    >
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
    const toast = useToast();
    const [inbox, setInbox] = useState<Inbox | null>(null);
    const [showing, setShowing] = useState(false);
    // A check in the background that fails is left for the next one: what is shown stays as it was.
    // Says whether there is now something to show.
    const load = useCallback(
        () =>
            api.notifications().then(
                (i) => {
                    setInbox(i);
                    return true;
                },
                () => false,
            ),
        [],
    );
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
            // Asked for by the person: if there is nothing to show them, they are told why.
            void load().then((ok) => {
                if (ok || inbox) return;
                setShowing(false);
                toast("Your notifications couldn't be loaded. Please try again.", "error");
            });
        },
        // Closing the list is what marks them as seen, so they stay marked "new" while it is open.
        // If that fails they simply stay "new", which is true.
        hide: () => {
            setShowing(false);
            if (inbox?.unread) void api.readNotifications().then(load, () => {});
        },
        setEmail: (on: boolean) => {
            setInbox((i) => (i ? { ...i, email: on } : i));
            // If it was not saved, the box goes back to what is true and the person is told.
            void api.emailNotifications(on).then(load, (err: Error) => {
                toast(`That wasn't saved. ${err.message}`, "error");
                void load();
            });
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
                    {inbox.notifications.map((n) => {
                        // Only a place inside Atelier is gone to, whatever the notification says.
                        const link = n.link?.startsWith("/") && !n.link.startsWith("//") ? n.link : null;
                        return (
                            <li key={n.id} className={n.readAt ? "" : "notice-unread"}>
                                <div>
                                    <strong>{n.title}</strong>
                                    {!n.readAt && <span className="chip chip-seal">New</span>}
                                </div>
                                <p>{n.body}</p>
                                <div className="notice-foot">
                                    <span className="mono muted">{timeAgo(n.createdAt)}</span>
                                    {link && (
                                        <button
                                            type="button"
                                            className="btn btn-sm"
                                            onClick={() => {
                                                onClose();
                                                navigate(link);
                                            }}
                                        >
                                            Go and look <ArrowRight />
                                        </button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
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

// `large`: as big as the window allows, for looking at something closely.
// While it is open the keyboard stays inside it: focus moves into it, Tab goes round within it,
// and closing it puts focus back where it was.
export function Dialog({ onClose, children, wide, large }: { onClose: () => void; children: ReactNode; wide?: boolean; large?: boolean }) {
    const box = useRef<HTMLDivElement>(null);
    // Kept in a ref: callers pass a new function on every render, and the listener need not follow each one.
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        // Something inside may have taken focus already (a field marked to).
        if (box.current && !box.current.contains(document.activeElement)) box.current.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close.current();
            else keepTabInside(e, box.current);
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            if (before?.isConnected) before.focus();
        };
    }, []);
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only dismisses; Escape does the same for keyboards
        <div
            className="scrim"
            role="presentation"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className={`dialog ${large ? "dialog-large" : wide ? "dialog-wide" : ""}`}
                role="dialog"
                aria-modal="true"
                tabIndex={-1}
                ref={box}
            >
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
