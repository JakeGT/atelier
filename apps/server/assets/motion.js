/* Atelier kit: movement, on GSAP (gsap.min.js and ScrollTrigger.min.js, kept in the
   website beside this file). Nothing here is needed to read a page: without script,
   or for a visitor who has asked their device for less movement, everything is
   simply there. Movement is switched on by attributes:

     data-k-reveal="up|down|left|right|in|scale"   comes in as it is scrolled to
     data-k-stagger="up|…"                         its children come in one after another
     data-k-count                                  a number counts up to what is written
     data-k-parallax="20"                          drifts as the page scrolls (percent)
     data-k-delay="0.2"                            waits this many seconds first
     <html data-k-motion="auto">                   the kit's own sections move without being marked

   How fast and how far comes from the look (--motion-duration, --motion-ease,
   --motion-distance in theme.css), so a change of look changes the movement too. */
(function motion() {
    var gsap = window.gsap;
    if (!gsap || !window.matchMedia) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var ScrollTrigger = window.ScrollTrigger;
    if (ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

    var look = window.getComputedStyle(document.documentElement);
    var value = function (name, fallback) {
        var v = look.getPropertyValue(name).trim();
        return v || fallback;
    };
    var duration = parseFloat(value("--motion-duration", "0.7")) || 0.7;
    var distance = parseFloat(value("--motion-distance", "24")) || 24;
    var ease = value("--motion-ease", "power2.out");
    gsap.defaults({ duration: duration, ease: ease });

    var all = function (root, selector) {
        return Array.prototype.slice.call(root.querySelectorAll(selector));
    };
    // Something is moved once: by its own attribute, or as part of what holds it.
    var taken = function (el) {
        for (var p = el; p && p !== document.documentElement; p = p.parentElement) if (p.hasAttribute("data-k-moving")) return true;
        return false;
    };
    var take = function (el) {
        el.setAttribute("data-k-moving", "");
    };
    var when = function (el) {
        return ScrollTrigger ? { trigger: el, start: "top 88%", once: true } : undefined;
    };
    var from = function (kind) {
        var f = { opacity: 0 };
        if (kind === "down") f.y = -distance;
        else if (kind === "left") f.x = -distance * 1.5;
        else if (kind === "right") f.x = distance * 1.5;
        else if (kind === "scale") f.scale = 0.94;
        else if (kind !== "in") f.y = distance;
        return f;
    };
    var delayOf = function (el) {
        return parseFloat(el.getAttribute("data-k-delay") || "0") || 0;
    };
    // Once it has arrived, what was set to move it is taken off again, so hover styles and layout are the page's own.
    var arrive = function (el, kind, extra) {
        var vars = from(kind);
        vars.delay = delayOf(el);
        vars.scrollTrigger = when(el);
        vars.clearProps = "opacity,transform";
        for (var k in extra || {}) vars[k] = extra[k];
        gsap.from(extra && extra.targets ? extra.targets : el, vars);
    };
    var reveal = function (el, kind) {
        if (taken(el)) return;
        arrive(el, kind || "up");
        take(el);
    };
    var stagger = function (el, kind) {
        if (taken(el)) return;
        var children = Array.prototype.slice.call(el.children).filter(function (c) {
            return !c.hidden;
        });
        if (children.length === 0) return;
        var vars = from(kind || "up");
        vars.delay = delayOf(el);
        vars.scrollTrigger = when(el);
        vars.clearProps = "opacity,transform";
        // The whole row arrives in about a beat and a half, however many there are.
        vars.stagger = Math.min(0.12, (duration * 1.5) / children.length);
        gsap.from(children, vars);
        take(el);
    };

    // Something waiting to one side must not make the page scroll sideways while it waits.
    if (document.querySelector('[data-k-reveal="left"], [data-k-reveal="right"], [data-k-stagger="left"], [data-k-stagger="right"]'))
        document.documentElement.style.overflowX = "clip";

    all(document, "[data-k-stagger]").forEach(function (el) {
        stagger(el, el.getAttribute("data-k-stagger"));
    });
    all(document, "[data-k-reveal]").forEach(function (el) {
        reveal(el, el.getAttribute("data-k-reveal"));
    });

    /* ---- a number that counts up to what is written ------------------------------------ */
    all(document, "[data-k-count]").forEach(function (el) {
        var text = el.textContent;
        var m = /-?\d[\d,]*(\.\d+)?/.exec(text);
        if (!m) return;
        var end = Number(m[0].replace(/,/g, ""));
        var places = m[1] ? m[1].length - 1 : 0;
        var grouped = m[0].indexOf(",") !== -1;
        var before = text.slice(0, m.index);
        var after = text.slice(m.index + m[0].length);
        var state = { n: 0 };
        var write = function () {
            var n = state.n.toFixed(places);
            if (grouped) n = n.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
            el.textContent = before + n + after;
        };
        gsap.to(state, {
            n: end,
            duration: duration * 2,
            ease: "power1.out",
            scrollTrigger: when(el),
            onUpdate: write,
            // What was written is put back exactly, whatever the arithmetic did.
            onComplete: function () {
                el.textContent = text;
            },
        });
    });

    /* ---- drifting as the page scrolls ---------------------------------------------------- */
    if (ScrollTrigger) {
        all(document, "[data-k-parallax]").forEach(function (el) {
            var amount = parseFloat(el.getAttribute("data-k-parallax") || "15") || 15;
            gsap.fromTo(
                el,
                { yPercent: -amount / 2 },
                { yPercent: amount / 2, ease: "none", scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true } },
            );
        });
    }

    /* ---- the kit's own sections, without marking each one ------------------------------- */
    var auto = document.documentElement.getAttribute("data-k-motion") || (document.body && document.body.getAttribute("data-k-motion"));
    if (auto === "auto") {
        all(document, ".k-hero .k-wrap > .k-stack, .k-hero .k-wrap > div:not([class])").forEach(function (el) {
            stagger(el, "up");
        });
        all(document, ".k-bars, .k-grid, .k-accordion, .k-sum, .k-list, .k-track").forEach(function (el) {
            // Bars grow instead (below); their rows still arrive one after another.
            stagger(el, "up");
        });
        all(document, ".k-head, .k-quote, .k-form, .k-picture, .k-band .k-wrap, .k-section > .k-wrap > .k-stack").forEach(function (el) {
            reveal(el, el.classList.contains("k-picture") ? "scale" : "up");
        });
    }
    // A bar grows to its length wherever movement is on.
    all(document, ".k-bar-fill").forEach(function (el) {
        gsap.from(el, {
            scaleX: 0,
            transformOrigin: "left center",
            duration: duration * 1.8,
            ease: "power2.out",
            scrollTrigger: when(el),
            clearProps: "transform,transformOrigin",
        });
    });

    // Pictures that arrive late change where everything is.
    if (ScrollTrigger) window.addEventListener("load", function () {
        ScrollTrigger.refresh();
    });
})();
