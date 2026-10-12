/* Atelier kit: the behaviour of a website's interactive sections. Plain script, no
   library and no build. Every section works as ordinary HTML without it (all the
   words are in the page, a form still sends); this adds the moving parts. Behaviour
   is switched on by data-k-… attributes, so the page's words stay where the
   Content page and search engines can read them. */
(function kit() {
    var all = function (root, selector) {
        return Array.prototype.slice.call(root.querySelectorAll(selector));
    };

    /* ---- a menu that folds away on a small screen ------------------------------------- */
    all(document, "[data-k-menu]").forEach(function (nav) {
        var button = nav.querySelector("[data-k-menu-toggle]");
        if (!button) return;
        button.hidden = false;
        button.setAttribute("aria-expanded", "false");
        nav.classList.add("k-menu-ready");
        button.addEventListener("click", function () {
            var open = nav.classList.toggle("k-open");
            button.setAttribute("aria-expanded", String(open));
        });
    });

    /* ---- tabs: one panel at a time ----------------------------------------------------- */
    all(document, "[data-k-tabs]").forEach(function (tabs, n) {
        var items = all(tabs, "[data-k-tab]");
        if (items.length < 2) return;
        var bar = document.createElement("div");
        bar.className = "k-tabbar";
        bar.setAttribute("role", "tablist");
        var show = function (index) {
            items.forEach(function (item, i) {
                var on = i === index;
                item.hidden = !on;
                bar.children[i].setAttribute("aria-selected", String(on));
                bar.children[i].tabIndex = on ? 0 : -1;
            });
        };
        items.forEach(function (item, i) {
            var title = item.querySelector("[data-k-tab-title]");
            var button = document.createElement("button");
            button.type = "button";
            button.className = "k-tab";
            button.setAttribute("role", "tab");
            button.id = "k-tab-" + n + "-" + i;
            button.textContent = title ? title.textContent : "Tab " + (i + 1);
            if (title) title.hidden = true;
            item.setAttribute("role", "tabpanel");
            item.setAttribute("aria-labelledby", button.id);
            button.addEventListener("click", function () {
                show(i);
            });
            button.addEventListener("keydown", function (e) {
                var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                var next = (i + step + items.length) % items.length;
                show(next);
                bar.children[next].focus();
            });
            bar.appendChild(button);
        });
        tabs.insertBefore(bar, tabs.firstChild);
        tabs.classList.add("k-tabs-ready");
        show(0);
    });

    /* ---- a row of things to move through ---------------------------------------------- */
    all(document, "[data-k-carousel]").forEach(function (carousel) {
        var track = carousel.querySelector("[data-k-track]");
        if (!track) return;
        var move = function (direction) {
            var item = track.firstElementChild;
            var step = item ? item.getBoundingClientRect().width + 16 : track.clientWidth;
            track.scrollBy({ left: direction * step, behavior: "smooth" });
        };
        all(carousel, "[data-k-prev], [data-k-next]").forEach(function (button) {
            button.hidden = false;
            button.addEventListener("click", function () {
                move(button.hasAttribute("data-k-next") ? 1 : -1);
            });
        });
    });

    /* ---- a list that can be narrowed to one kind -------------------------------------- */
    all(document, "[data-k-filter]").forEach(function (filter) {
        var bar = filter.querySelector("[data-k-filter-bar]");
        var items = all(filter, "[data-k-filter-item]");
        if (!bar || items.length === 0) return;
        var kindOf = function (item) {
            var el = item.querySelector("[data-k-kind]");
            return el ? el.textContent.trim() : "";
        };
        var kinds = [];
        items.forEach(function (item) {
            var kind = kindOf(item);
            if (kind && kinds.indexOf(kind) === -1) kinds.push(kind);
        });
        if (kinds.length < 2) return;
        var everything = bar.getAttribute("data-k-all") || "All";
        var choose = function (kind, pressed) {
            items.forEach(function (item) {
                item.hidden = kind !== null && kindOf(item) !== kind;
            });
            all(bar, "button").forEach(function (b) {
                b.setAttribute("aria-pressed", String(b === pressed));
            });
        };
        [null].concat(kinds).forEach(function (kind) {
            var button = document.createElement("button");
            button.type = "button";
            button.className = "k-chip";
            button.textContent = kind === null ? everything : kind;
            button.setAttribute("aria-pressed", String(kind === null));
            button.addEventListener("click", function () {
                choose(kind, button);
            });
            bar.appendChild(button);
        });
        bar.hidden = false;
    });

    /* ---- adding up what is ticked ------------------------------------------------------ */
    var amount = function (text) {
        var m = /-?\d[\d,]*(\.\d+)?/.exec(text || "");
        return m ? Number(m[0].replace(/,/g, "")) : 0;
    };
    all(document, "[data-k-sum]").forEach(function (sum) {
        var total = sum.querySelector("[data-k-total]");
        if (!total) return;
        var first = sum.querySelector("[data-k-price]");
        // The words around the number ("£", " a month") are kept as the first price has them.
        var around = first ? first.textContent.trim().split(/-?\d[\d,]*(?:\.\d+)?/) : ["", ""];
        var add = function () {
            var value = 0;
            all(sum, "[data-k-row]").forEach(function (row) {
                var pick = row.querySelector("input[type=checkbox], input[type=radio]");
                var count = row.querySelector("input[type=number]");
                var price = amount((row.querySelector("[data-k-price]") || {}).textContent);
                if (pick && !pick.checked) return;
                value += price * (count ? Math.max(0, Number(count.value) || 0) : 1);
            });
            total.textContent = (around[0] || "") + value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + (around[1] || "");
        };
        sum.addEventListener("input", add);
        sum.addEventListener("change", add);
        add();
    });

    /* ---- a form that answers on the page ------------------------------------------------ */
    all(document, "form[data-k-form]").forEach(function (form) {
        var done = form.parentNode.querySelector("[data-k-form-done]");
        var failed = form.parentNode.querySelector("[data-k-form-failed]");
        form.addEventListener("submit", function (e) {
            if (!form.action || !window.fetch || !window.FormData) return;
            e.preventDefault();
            var button = form.querySelector("button[type=submit], button:not([type])");
            if (button) button.disabled = true;
            if (failed) failed.hidden = true;
            fetch(form.action, { method: "POST", body: new FormData(form), headers: { accept: "application/json" } })
                .then(function (res) {
                    if (!res.ok) throw new Error("not sent");
                    form.hidden = true;
                    if (done) {
                        done.hidden = false;
                        done.setAttribute("tabindex", "-1");
                        done.focus();
                    }
                })
                .catch(function () {
                    if (failed) failed.hidden = false;
                    if (button) button.disabled = false;
                });
        });
    });
})();
