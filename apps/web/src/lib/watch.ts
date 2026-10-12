import { ApiError, currentBuild, currentCsrf } from "./api";

// What the app notices about itself and tells whoever runs Atelier, without the person
// having to: a screen that stopped working, an error nothing caught, a page that froze.
// It says what happened and where (the page, the build, the last thing pressed), never
// what was typed. The same thing is sent once for each time the page is loaded.

type Kind = "crash" | "error" | "freeze";

const sent = new Set<string>();
// A page that is failing over and over says so a few times, not for ever.
let left = 12;
// The control last pressed, by its words: often what set a freeze or a failure off.
let lastPressed = "";

const where = (): { org?: string; project?: string } => {
    const [, org, , project] = window.location.pathname.match(/^\/o\/([^/]+)(\/p\/([^/]+))?/) ?? [];
    return { org, project };
};

export function reportBody(kind: Kind, text: string, detail: string): string {
    return JSON.stringify({
        kind,
        text: text.slice(0, 500),
        detail: [lastPressed && `Last pressed: ${lastPressed}`, detail].filter(Boolean).join("\n").slice(0, 6000),
        page: window.location.pathname,
        screen: `${window.innerWidth}×${window.innerHeight}`,
        build: currentBuild(),
        ...where(),
    });
}

// Returns whether it was sent (so a screen can say that it was).
export function notice(kind: Kind, text: string, detail = ""): boolean {
    const csrf = currentCsrf();
    const key = `${kind}:${text.split("\n")[0]}`;
    // Not signed in: there is nobody to say it happened to, and nowhere that would take it.
    if (!csrf || sent.has(key) || left <= 0) return false;
    sent.add(key);
    left -= 1;
    // `keepalive`: it still goes if the person reloads or leaves straight away.
    void fetch("/api/v1/feedback/noticed", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json", "x-atelier-csrf": csrf },
        body: reportBody(kind, text, detail),
    }).catch(() => {});
    return true;
}

const describe = (err: unknown): { text: string; detail: string } =>
    err instanceof Error
        ? { text: `${err.name}: ${err.message}`, detail: err.stack ?? "" }
        : { text: `Something that is not an error was thrown: ${String(err).slice(0, 200)}`, detail: "" };

// What a long stretch of the page not answering was spent on, as far as the browser says.
interface FrameScript {
    invoker?: string;
    sourceFunctionName?: string;
    sourceURL?: string;
    sourceCharPosition?: number;
    duration: number;
}
const fileOf = (url = ""): string => url.split("/").pop()?.split("?")[0] ?? "";

let started = false;
export function startWatching(): void {
    if (started) return;
    started = true;

    window.addEventListener(
        "click",
        (e) => {
            const control = (e.target as Element | null)?.closest?.(
                "button, a, [role=button], [role=menuitem], [role=tab], summary, label",
            );
            if (!control) return;
            const words = (control.getAttribute("aria-label") ?? control.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
            lastPressed = `“${words}” on ${window.location.pathname}`;
        },
        true,
    );

    window.addEventListener("error", (e) => {
        // A script from somewhere else that failed tells this page nothing; a browser's own
        // note about resize observers is not a failure.
        if (!e.error || /ResizeObserver loop/.test(e.message)) return;
        const { text, detail } = describe(e.error);
        notice("error", text, detail);
    });
    window.addEventListener("unhandledrejection", (e) => {
        // A request that failed is told to the person where it happened; it is not the app failing.
        if (e.reason instanceof ApiError || (e.reason as Error | null)?.name === "AbortError") return;
        const { text, detail } = describe(e.reason);
        notice("error", text, detail);
    });

    // A freeze the page came back from: the browser says how long it was and what was running.
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                if (entry.duration < 2000) continue;
                const scripts = [...((entry as PerformanceEntry & { scripts?: FrameScript[] }).scripts ?? [])].sort(
                    (a, b) => b.duration - a.duration,
                );
                const worst = scripts[0];
                const doing = worst
                    ? `${worst.sourceFunctionName || worst.invoker || "a script"} (${fileOf(worst.sourceURL) || "this page"})`
                    : "the page's own drawing";
                notice(
                    "freeze",
                    `The page froze while running ${doing}`,
                    [
                        `Not answering for ${(entry.duration / 1000).toFixed(1)} seconds.`,
                        ...scripts
                            .slice(0, 8)
                            .map(
                                (s) =>
                                    `${Math.round(s.duration)} ms  ${s.sourceFunctionName || "(no name)"}  ${s.invoker ?? ""}  ${fileOf(s.sourceURL)}:${s.sourceCharPosition ?? "?"}`,
                            ),
                    ].join("\n"),
                );
            }
        }).observe({ type: "long-animation-frame", buffered: true });
    } catch {
        // A browser that cannot say: the watcher below still notices a page that stays frozen.
    }

    // A freeze the page does not come back from cannot be reported by the page. Something
    // beside it is told every second that the page is alive, and speaks up when that stops.
    try {
        const beside = new Worker(new URL("./watchdog.ts", import.meta.url), { type: "module" });
        const beat = () => {
            const csrf = currentCsrf();
            if (document.visibilityState !== "visible" || !csrf) beside.postMessage({ rest: true });
            else beside.postMessage({ csrf, body: reportBody("freeze", "The page froze and had not come back after 15 seconds", "") });
        };
        // A page that is not being looked at is slowed down by the browser, which is not a freeze.
        document.addEventListener("visibilitychange", beat);
        setInterval(beat, 1000);
        beat();
    } catch {
        // No watcher, then: everything else still works.
    }
}
