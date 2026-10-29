// Runs beside the page (lib/watch.ts starts it). The page says it is alive every second
// while it is being looked at; when it has said nothing for fifteen seconds it is frozen,
// and this says so to whoever runs Atelier, since the page itself cannot. Once for each freeze.

const FROZEN_AFTER = 15_000;
let lastBeat = Date.now();
let lastTick = Date.now();
let resting = true;
let told = false;
let csrf = "";
let body = "";

self.addEventListener("message", (e: MessageEvent<{ rest?: boolean; csrf?: string; body?: string }>) => {
    lastBeat = Date.now();
    told = false;
    resting = e.data.rest === true;
    if (e.data.csrf && e.data.body) {
        csrf = e.data.csrf;
        body = e.data.body;
    }
});

setInterval(() => {
    const now = Date.now();
    // This was held up as well: the computer slept, or the browser put the whole tab aside. Not a freeze.
    const held = now - lastTick > 5000;
    lastTick = now;
    if (held) {
        lastBeat = now;
        return;
    }
    if (resting || told || !csrf || now - lastBeat < FROZEN_AFTER) return;
    told = true;
    void fetch("/api/v1/feedback/noticed", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-atelier-csrf": csrf },
        body,
    }).catch(() => {});
}, 2000);
