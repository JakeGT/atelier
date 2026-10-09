// Applied before first paint so the page never flashes the wrong theme.
(() => {
    try {
        const stored = localStorage.getItem("atelier.theme");
        const night = stored ? stored === "night" : window.matchMedia("(prefers-color-scheme: dark)").matches;
        document.documentElement.dataset.theme = night ? "night" : "paper";
    } catch {
        document.documentElement.dataset.theme = "paper";
    }
})();
