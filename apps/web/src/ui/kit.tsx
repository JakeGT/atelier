import { Check, LogOut, Moon, RefreshCw, Sun, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "../lib/api";
import { api, isStale, UPDATE_EVENT } from "../lib/api";
import { navigate, type Theme, useClickOutside } from "../lib/hooks";

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
        <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onToggle}
            title={theme === "paper" ? "Night studio" : "Daylight"}
            aria-label="Switch colour theme"
        >
            {theme === "paper" ? <Moon /> : <Sun />}
        </button>
    );
}

export function UserMenu({ session }: { session: Session }) {
    const [open, setOpen] = useState(false);
    const ref = useClickOutside(useCallback(() => setOpen(false), []));
    const initial = (session.name || session.email).trim().charAt(0).toUpperCase();
    return (
        <div className="menu-wrap" ref={ref}>
            <button type="button" className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account" aria-expanded={open}>
                {initial}
            </button>
            {open && (
                <div className="menu" role="menu">
                    <div className="menu-head">
                        <strong>{session.name}</strong>
                        <span className="mono muted">{session.email}</span>
                    </div>
                    <button type="button" role="menuitem" onClick={() => void api.logout()}>
                        <LogOut /> Sign out
                    </button>
                </div>
            )}
        </div>
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
