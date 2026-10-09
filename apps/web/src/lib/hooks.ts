import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// ---- routing: a tiny History-API router ("/", "/login", "/studio", "/p/:slug") ------

const listeners = new Set<() => void>();
const notify = () => {
    for (const l of listeners) l();
};
window.addEventListener("popstate", notify);

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
    if (path === window.location.pathname + window.location.search) return;
    if (opts.replace) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
    window.scrollTo(0, 0);
    notify();
}

export function usePath(): string {
    return useSyncExternalStore(
        (cb) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        () => window.location.pathname,
    );
}

// ---- theme ------------------------------------------------------------------------

export type Theme = "paper" | "night";

const THEME_KEY = "atelier.theme";

function initialTheme(): Theme {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "paper" || stored === "night") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper";
}

export function useTheme(): [Theme, () => void] {
    const [theme, setTheme] = useState<Theme>(initialTheme);
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
    }, [theme]);
    const toggle = useCallback(() => {
        setTheme((t) => {
            const next = t === "paper" ? "night" : "paper";
            localStorage.setItem(THEME_KEY, next);
            return next;
        });
    }, []);
    return [theme, toggle];
}

// ---- persisted state ----------------------------------------------------------------

export function useStored<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
    const [value, setValue] = useState<T>(() => {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? initial : (JSON.parse(raw) as T);
        } catch {
            return initial;
        }
    });
    const keyRef = useRef(key);
    keyRef.current = key;
    const set = useCallback((next: T | ((prev: T) => T)) => {
        setValue((prev) => {
            const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
            try {
                localStorage.setItem(keyRef.current, JSON.stringify(resolved));
            } catch {
                // storage full or unavailable: the state still works for this visit
            }
            return resolved;
        });
    }, []);
    return [value, set];
}

// ---- small helpers ------------------------------------------------------------------

export function useClickOutside(onOutside: () => void) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [onOutside]);
    return ref;
}

export function useElapsed(since: string | null): string {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!since) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [since]);
    if (!since) return "";
    const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(iso: string): string {
    const diff = (new Date(iso).getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 45) return "just now";
    if (abs < 3600) return RELATIVE.format(Math.round(diff / 60), "minute");
    if (abs < 86400) return RELATIVE.format(Math.round(diff / 3600), "hour");
    if (abs < 86400 * 14) return RELATIVE.format(Math.round(diff / 86400), "day");
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
