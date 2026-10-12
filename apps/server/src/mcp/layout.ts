// What a browser can measure about a page's layout that a picture of the whole page may not
// show: things that almost line up, are almost centred, are spaced unevenly, or are of unequal
// height side by side. These are near-misses, which is how a slip looks; a difference that is
// clearly a decision (a wide margin on one side, a tall card among short ones by design) is not
// reported at all, and what is reported is offered as worth a look, never as a fault.
//
// Runs inside the page. Returns { y, bottom, line } for each, in page pixels, top to bottom.
export const LAYOUT_NOTICES = `(() => {
    const out = [];
    const seen = new Set();
    const px = (n) => Math.round(n) + "px";
    const say = (el) => (el.tagName === "IMG" ? "picture '" + (el.alt || el.getAttribute("src") || "").slice(0, 30) + "'" : el.tagName.toLowerCase() + (el.id ? "#" + el.id : typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/)[0] : "") + (el.textContent.trim() ? " '" + el.textContent.replace(/\\s+/g, " ").trim().slice(0, 30) + "'" : ""));
    const add = (a, b, line) => { if (seen.has(line) || out.length >= 60) return; seen.add(line); out.push({ y: Math.round(a), bottom: Math.round(b), line }); };
    const shown = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0.05; };
    const flows = (el) => { const s = getComputedStyle(el); return s.position !== "absolute" && s.position !== "fixed" && s.display !== "inline" && s.display !== "contents"; };
    const box = (el) => { const r = el.getBoundingClientRect(); return { el, l: r.left, r: r.right, t: r.top + scrollY, b: r.bottom + scrollY, w: r.width, h: r.height }; };
    const painted = (el) => { const s = getComputedStyle(el); return (s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent") || s.backgroundImage !== "none" || parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) > 0 || s.boxShadow !== "none"; };
    const kind = (el) => el.tagName + "." + (typeof el.className === "string" ? el.className.trim() : "");
    const spread = (ns) => Math.max(...ns) - Math.min(...ns);
    // A near-miss: more than a browser's rounding, less than anyone would choose.
    const near = (n, most) => n >= 1.5 && n <= most;

    for (const parent of [document.body, ...document.body.querySelectorAll("*")]) {
        if (parent instanceof SVGElement || /^(P|H[1-6]|SPAN|A|LABEL|SCRIPT|STYLE|SELECT|TABLE|THEAD|TBODY|TR)$/.test(parent.tagName)) continue;
        if (parent.closest("[data-k-track]") || !shown(parent)) continue;
        const kids = [...parent.children].filter((el) => !(el instanceof SVGElement && el.tagName !== "svg") && shown(el) && flows(el)).map(box);
        if (!kids.length) continue;
        const ps = getComputedStyle(parent), pr = parent.getBoundingClientRect();
        const inner = { l: pr.left + parseFloat(ps.borderLeftWidth) + parseFloat(ps.paddingLeft), r: pr.right - parseFloat(ps.borderRightWidth) - parseFloat(ps.paddingRight) };
        const where = "In " + say(parent).replace(/ '.*$/, "") + ": ";
        // The children as they are laid out: one line of them after another.
        const lines = [];
        for (const k of kids) {
            const line = lines.at(-1);
            if (line && k.l >= line.at(-1).r - 1 && k.t < line[0].b && k.b > line[0].t) line.push(k);
            else lines.push([k]);
        }
        const laidOut = /flex|grid/.test(ps.display);

        for (const line of lines) {
            const top = Math.min(...line.map((k) => k.t)), bottom = Math.max(...line.map((k) => k.b));
            if (line.length > 1 && laidOut && !/baseline/.test(ps.alignItems)) {
                // Side by side: lined up by their tops, their middles or their bottoms, or nearly by one of them.
                const by = [["tops", line.map((k) => k.t)], ["middles", line.map((k) => (k.t + k.b) / 2)], ["bottoms", line.map((k) => k.b)]].map(([what, ns]) => ({ what, ns, off: spread(ns) })).sort((a, b) => a.off - b.off)[0];
                if (near(by.off, 8)) {
                    const low = line[by.ns.indexOf(Math.max(...by.ns))], high = line[by.ns.indexOf(Math.min(...by.ns))];
                    add(top, bottom, where + "side by side but not quite level: " + say(low.el) + " sits " + px(by.off) + " lower than " + say(high.el) + " (measured by their " + by.what + ")");
                }
                const alike = line.every((k) => kind(k.el) === kind(line[0].el));
                if (alike && line.some((k) => painted(k.el)) && spread(line.map((k) => k.h)) > 2)
                    add(top, bottom, where + line.length + " " + say(line[0].el).replace(/ '.*$/, "") + " side by side are of different heights (" + line.map((k) => px(k.h)).join(", ") + ")");
                if (alike && line.length > 2) {
                    const gaps = line.slice(1).map((k, i) => k.l - line[i].r);
                    if (spread(gaps) >= 2 && spread(gaps) <= 24) add(top, bottom, where + "the gaps between " + line.length + " " + say(line[0].el).replace(/ '.*$/, "") + " side by side are uneven (" + gaps.map(px).join(", ") + ")");
                }
            }
            // The line as a whole within its container: centred, or nearly.
            const left = line[0].l - inner.l, right = inner.r - line.at(-1).r;
            if (left > 8 && right > 8 && near(Math.abs(left - right), 16))
                add(top, bottom, where + (line.length > 1 ? "the row starting " : "") + say(line[0].el) + " is almost centred but not quite: " + px(left) + " of space on its left and " + px(right) + " on its right");
        }

        if (lines.length > 2 && lines.every((l) => l.length === 1)) {
            // One under another. Left edges that nearly agree:
            const edges = kids.filter((k) => !/center|right|end/.test(getComputedStyle(k.el).textAlign) || k.el.tagName === "IMG");
            const counts = new Map();
            for (const k of edges) counts.set(Math.round(k.l), (counts.get(Math.round(k.l)) ?? 0) + 1);
            const usual = [...counts].sort((a, b) => b[1] - a[1])[0];
            if (usual && usual[1] > 1)
                for (const k of edges) if (near(Math.abs(k.l - usual[0]), 6)) add(k.t, k.b, where + say(k.el) + " starts " + px(Math.abs(k.l - usual[0])) + " to the " + (k.l > usual[0] ? "right" : "left") + " of the things above and below it (" + px(k.l) + " against " + px(usual[0]) + ")");
            // The same kind of thing repeated, with gaps that nearly agree:
            if (kids.every((k) => kind(k.el) === kind(kids[0].el))) {
                const gaps = kids.slice(1).map((k, i) => k.t - kids[i].b);
                if (spread(gaps) >= 2 && spread(gaps) <= 24) add(kids[0].t, kids.at(-1).b, where + "the gaps between " + kids.length + " " + say(kids[0].el).replace(/ '.*$/, "") + " one under another are uneven (" + gaps.map(px).join(", ") + ")");
            }
        }

        // A bar, button or badge with what is in it not quite in its middle, top to bottom.
        if (lines.length === 1 && painted(parent) && pr.height < 200) {
            const above = Math.min(...kids.map((k) => k.t)) - (pr.top + scrollY), below = pr.bottom + scrollY - Math.max(...kids.map((k) => k.b));
            if (above > 2 && below > 2 && near(Math.abs(above - below), 10) && Math.abs(above - below) >= 4)
                add(pr.top + scrollY, pr.bottom + scrollY, where + "what is inside sits " + px(Math.abs(above - below) / 2) + " " + (above > below ? "below" : "above") + " the middle (" + px(above) + " of space above it, " + px(below) + " below)");
        }
    }

    // Words in a button or badge: where the words themselves are, not their box.
    for (const el of document.body.querySelectorAll("button, a, [class*=badge], [class*=chip], [class*=tag], [class*=pill]")) {
        if (el.children.length || !el.textContent.trim() || !shown(el) || !painted(el)) continue;
        const range = document.createRange();
        range.selectNodeContents(el);
        if (range.getClientRects().length !== 1) continue;
        const t = range.getBoundingClientRect(), r = el.getBoundingClientRect();
        const left = t.left - r.left, right = r.right - t.right;
        if (left > 2 && right > 2 && near(Math.abs(left - right), 12) && Math.abs(left - right) >= 3)
            add(r.top + scrollY, r.bottom + scrollY, say(el) + ": its words are " + px(Math.abs(left - right) / 2) + " " + (left > right ? "right" : "left") + " of its middle (" + px(left) + " of space before them, " + px(right) + " after)");
        const above = t.top - r.top, below = r.bottom - t.bottom;
        if (near(Math.abs(above - below), 12) && Math.abs(above - below) >= 4)
            add(r.top + scrollY, r.bottom + scrollY, say(el) + ": its words are " + px(Math.abs(above - below) / 2) + " " + (above > below ? "below" : "above") + " its middle (" + px(above) + " of space above them, " + px(below) + " below)");
    }
    return out.sort((a, b) => a.y - b.y);
})()`;
