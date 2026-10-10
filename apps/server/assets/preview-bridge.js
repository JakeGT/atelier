// A few lines added to pages shown in the editor's preview frame (and only
// there). The frame is sandboxed with an opaque origin, so the editor cannot
// look inside it or act on it; the page has to cooperate. The bridge:
//
//   - says which page is showing (for Back, Forward and Reload);
//   - moves through the frame's own history when asked;
//   - in "edit text" mode, outlines the elements bound to content, lets plain
//     text be typed in place, and tells the editor what changed or what was
//     clicked. It saves nothing itself and holds no credentials: the editor
//     decides what to do with what it is told, and treats it as untrusted.
// This file is sent to the browser as it is: plain script, old-fashioned on purpose.

(function bridge() {
    var editing = false;
    var style = null;
    var BOUND = "[data-content],[data-content-rich],[data-content-list],[data-content-image]";
    var say = (message) => {
        message.atelierPreview = 1;
        parent.postMessage(message, "*");
    };
    var path = () => location.pathname.replace(/^\/preview\/[^/]+\//, "") || "index.html";
    var refOf = (el) =>
        el.getAttribute("data-content") ||
            el.getAttribute("data-content-rich") ||
            el.getAttribute("data-content-list") ||
            el.getAttribute("data-content-image") ||
            "";
    var apply = () => {
        var nodes = document.querySelectorAll(BOUND);
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.hasAttribute("data-content")) {
                if (editing) {
                    el.setAttribute("contenteditable", "plaintext-only");
                    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
                    el.setAttribute("spellcheck", "true");
                    if (el.__atelierWas === undefined) el.__atelierWas = el.innerText;
                } else {
                    el.removeAttribute("contenteditable");
                }
            }
        }
        if (editing && !style) {
            style = document.createElement("style");
            style.textContent =
                BOUND +
                "{outline:2px dashed rgba(220,67,38,.6)!important;outline-offset:3px!important;border-radius:2px;cursor:text!important}" +
                "[data-content-rich],[data-content-list],[data-content-image]{cursor:pointer!important}" +
                BOUND.split(",").join(":hover,") +
                ":hover,[data-content]:focus{outline-style:solid!important;background:rgba(220,67,38,.07)!important}";
            document.head.appendChild(style);
        } else if (!editing && style) {
            style.remove();
            style = null;
        }
    };
    var bound = (target) => (target && target.closest ? target.closest(BOUND) : null);
    addEventListener("pageshow", () => {
        say({ path: path() });
    });
    addEventListener("message", (e) => {
        if (e.source !== parent || !e.data || e.data.atelierPreview !== 1) return;
        if (e.data.go === "back") history.back();
        else if (e.data.go === "forward") history.forward();
        if (typeof e.data.edit === "boolean") {
            editing = e.data.edit;
            apply();
        }
    });
    // Typed text is reported when the person leaves the element, not on every key.
    addEventListener(
        "blur",
        (e) => {
            var el = e.target;
            if (!editing || !el || !el.hasAttribute || !el.hasAttribute("data-content")) return;
            var now = el.innerText.replace(/\s+/g, " ").trim();
            if (
                now ===
                String(el.__atelierWas || "")
                    .replace(/\s+/g, " ")
                    .trim()
            )
                return;
            el.__atelierWas = now;
            say({ change: { ref: refOf(el), value: now } });
        },
        true,
    );
    addEventListener(
        "keydown",
        (e) => {
            var el = e.target;
            if (!editing || !el || !el.hasAttribute || !el.hasAttribute("data-content")) return;
            if (e.key === "Enter") {
                e.preventDefault();
                el.blur();
            } else if (e.key === "Escape") {
                el.innerText = el.__atelierWas || "";
                el.blur();
            }
        },
        true,
    );
    // While editing, a click edits; it does not follow links or press the page's buttons.
    addEventListener(
        "click",
        (e) => {
            if (!editing) return;
            var el = bound(e.target);
            if (!el) return;
            e.preventDefault();
            e.stopPropagation();
            if (!el.hasAttribute("data-content")) say({ open: refOf(el) });
        },
        true,
    );
})();
