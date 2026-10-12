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

// Lets a row that scrolls sideways be dragged along with the mouse, and carries on
// a little when let go, as a finger's swipe does. A press that moves is a drag and
// chooses nothing; a press that stays put is still a click. Touch and trackpads
// already scroll it themselves.
// `ref` goes on the row (which may appear later than the page); `more` says which
// way there is more to see; `step` moves a screenful that way.
export function useDragScroll<T extends HTMLElement>(): {
    ref: (node: T | null) => void;
    more: { before: boolean; after: boolean };
    step: (direction: -1 | 1) => void;
} {
    const [row, setRow] = useState<T | null>(null);
    const [more, setMore] = useState({ before: false, after: false });
    const calm = useRef(false);
    useEffect(() => {
        if (!row) return;
        calm.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let start: { x: number; left: number } | null = null;
        let dragged = false;
        // Where the mouse was a moment ago, to know how fast it was going when it let go.
        let trail: { x: number; t: number }[] = [];
        let coasting = 0;
        const stop = () => {
            cancelAnimationFrame(coasting);
            coasting = 0;
        };
        const down = (e: PointerEvent) => {
            if (e.pointerType !== "mouse" || e.button !== 0 || row.scrollWidth <= row.clientWidth) return;
            stop();
            start = { x: e.clientX, left: row.scrollLeft };
            trail = [{ x: e.clientX, t: performance.now() }];
            dragged = false;
        };
        const move = (e: PointerEvent) => {
            if (!start) return;
            const dx = e.clientX - start.x;
            if (!dragged && Math.abs(dx) < 6) return;
            if (!dragged) {
                dragged = true;
                row.classList.add("dragging");
            }
            row.scrollLeft = start.left - dx;
            const now = performance.now();
            trail.push({ x: e.clientX, t: now });
            while (trail.length > 2 && now - (trail[0]?.t ?? now) > 100) trail.shift();
        };
        const up = () => {
            if (!start) return;
            start = null;
            row.classList.remove("dragging");
            if (!dragged || calm.current) return;
            const first = trail[0];
            const last = trail.at(-1);
            // Let go after holding still: it stays where it was put.
            if (!first || !last || last.t === first.t || performance.now() - last.t > 60) return;
            // Pixels a millisecond, in the direction the row was moving.
            let speed = -(last.x - first.x) / (last.t - first.t);
            let then = performance.now();
            const coast = (now: number) => {
                const dt = Math.min(now - then, 34);
                then = now;
                const before = row.scrollLeft;
                row.scrollLeft = before + speed * dt;
                // Loses about a twentieth of its speed every sixtieth of a second.
                speed *= 0.95 ** (dt / 16.7);
                coasting = Math.abs(speed) > 0.02 && row.scrollLeft !== before ? requestAnimationFrame(coast) : 0;
            };
            coasting = requestAnimationFrame(coast);
        };
        // The click that ends a drag is swallowed, so letting go over a card does not choose it.
        const click = (e: MouseEvent) => {
            if (!dragged) return;
            dragged = false;
            e.preventDefault();
            e.stopPropagation();
        };
        const noNativeDrag = (e: DragEvent) => e.preventDefault();
        const edges = () => {
            const before = row.scrollLeft > 8;
            const after = row.scrollLeft + row.clientWidth < row.scrollWidth - 8;
            row.classList.toggle("more-before", before);
            row.classList.toggle("more-after", after);
            setMore((m) => (m.before === before && m.after === after ? m : { before, after }));
        };
        edges();
        const watch = new ResizeObserver(edges);
        watch.observe(row);
        for (const child of row.children) watch.observe(child);
        row.addEventListener("scroll", edges, { passive: true });
        row.addEventListener("pointerdown", down);
        row.addEventListener("wheel", stop, { passive: true });
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        row.addEventListener("click", click, true);
        row.addEventListener("dragstart", noNativeDrag);
        return () => {
            stop();
            row.removeEventListener("pointerdown", down);
            row.removeEventListener("wheel", stop);
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            row.removeEventListener("click", click, true);
            row.removeEventListener("dragstart", noNativeDrag);
            row.removeEventListener("scroll", edges);
            watch.disconnect();
        };
    }, [row]);
    const step = useCallback(
        (direction: -1 | 1) => row?.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: calm.current ? "auto" : "smooth" }),
        [row],
    );
    return { ref: setRow, more, step };
}
