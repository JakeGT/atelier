// Applied before first paint so the page never flashes the wrong theme. That only holds while
// index.html loads this in <head> as an ordinary script (not defer, async or a module).
// It must choose as initialTheme() in src/lib/hooks.ts does, from the same key ("atelier.theme").
(() => {
    let stored = null;
    try {
        stored = localStorage.getItem("atelier.theme");
    } catch {
        // The browser keeps nothing for this page: go by what the device asks for.
    }
    let night = false;
    try {
        night = stored === "night" || (stored !== "paper" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch {
        // Nothing to go by: daylight.
    }
    document.documentElement.dataset.theme = night ? "night" : "paper";
})();
