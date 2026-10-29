import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { clientIp } from "../security.ts";
import { checkMark, cleanSubmission, FormLimiter, readFormToken } from "../services/forms.ts";
import { type Api, PROJECT, param } from "./kit.ts";

// What a visitor may send in one go: words, not files.
const MAX_BYTES = 64 * 1024;
// A website's forms are on another address (its own domain), so any page may send here;
// nothing is read back and no cookie is used, so there is nothing to protect by origin.
const OPEN = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "accept, content-type",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
};

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The page a visitor sees when the website's own script did not answer for the form.
const answerPage = (heading: string, text: string, back: string | null): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(heading)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:1.05rem/1.6 system-ui,sans-serif;background:#f6f4ef;color:#1c1b19}
main{max-width:32rem;padding:2rem}h1{font-size:1.6rem;margin:0 0 .5rem}a{color:inherit}</style></head>
<body><main><h1>${esc(heading)}</h1><p>${esc(text)}</p>${back ? `<p><a href="${esc(back)}">Go back to the website</a></p>` : ""}</main></body></html>`;

// The first few words of a submission, for a notification.
const summary = (data: Record<string, string>): string =>
    Object.entries(data)
        .map(([k, v]) => `${k}: ${v.replace(/\s+/g, " ").slice(0, 160)}`)
        .join("\n")
        .slice(0, 900);

// Forms on websites: where they send to (public), and reading what was sent (the studio's people).
export function formRoutes(api: Api): void {
    const { route, store, audit, app, secretsKey, notifier } = api;
    const key = `${secretsKey}:form`;
    const perSender = new FormLimiter(5, 60);
    // One website cannot be made to fill someone's inbox, whoever is sending.
    const perWebsite = new FormLimiter(30, 300);

    const backOf = (c: Context): string | null => {
        try {
            const url = new URL(c.req.header("referer") ?? "");
            return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
        } catch {
            return null;
        }
    };
    const answer = (c: Context, status: 200 | 400 | 404 | 413 | 429, heading: string, text: string) =>
        (c.req.header("accept") ?? "").includes("application/json")
            ? c.json(status === 200 ? { ok: true } : { error: text }, status, OPEN)
            : c.html(answerPage(heading, text, backOf(c)), status, {
                  ...OPEN,
                  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
              });

    app.options("/f/:token", (c) => c.body(null, 204, OPEN));
    app.get("/f/:token", (c) => answer(c, 404, "Nothing to see here", "This address only receives what a form sends."));
    app.post("/f/:token", async (c) => {
        const target = readFormToken(param(c, "token"), key);
        if (!target) return answer(c, 404, "This form is not connected", "The website needs publishing again before this form can send.");
        if (Number(c.req.header("content-length") ?? 0) > MAX_BYTES)
            return answer(c, 413, "That is too long to send", "Please shorten it and try again.");
        const type = c.req.header("content-type") ?? "";
        if (!type.startsWith("multipart/form-data") && !type.startsWith("application/x-www-form-urlencoded"))
            return answer(c, 400, "That could not be read", "Please try again from the website.");
        const raw = await c.req.arrayBuffer().catch(() => null);
        if (!raw || raw.byteLength > MAX_BYTES) return answer(c, 413, "That is too long to send", "Please shorten it and try again.");
        let entries: [string, unknown][];
        try {
            const form = await new Response(raw, { headers: { "content-type": type } }).formData();
            entries = [...form.entries()];
        } catch {
            return answer(c, 400, "That could not be read", "Please try again from the website.");
        }
        // Atelier checking a live form of its own: it got here, which is what was being asked. Nothing is kept.
        const mark = entries.find(([k]) => k === "_atelier_check")?.[1];
        if (typeof mark === "string" && mark === checkMark(param(c, "token"), key)) return c.json({ ok: true, check: true }, 200, OPEN);
        const data = cleanSubmission(entries);
        const thanks = () => answer(c, 200, "Thank you", "Your message has been sent.");
        // A robot filled the hidden field: it is told all is well and nothing is kept.
        if (data === null) return thanks();
        if (Object.keys(data).length === 0) return answer(c, 400, "There was nothing to send", "Please fill in the form and try again.");
        if (!perSender.allow(`${clientIp(c)}:${target.projectId}`) || !perWebsite.allow(target.projectId))
            return answer(c, 429, "Too many messages just now", "Please try again in a few minutes.");
        const project = await store.projects.findById(target.tenantId, target.projectId).catch(() => null);
        if (!project) return answer(c, 404, "This form is not connected", "This website is no longer here.");
        await store.forms.add({
            id: randomUUID(),
            tenantId: target.tenantId,
            projectId: project.id,
            form: target.form,
            data,
            preview: target.preview,
        });
        // Trying a form out in the preview is not news; a visitor writing is.
        if (!target.preview) {
            const org = await store.organizations.findById(target.tenantId).catch(() => null);
            void notifier.tellStudio(target.tenantId, {
                kind: "form.submission",
                title: `${project.name}: someone sent the ${target.form} form`,
                body: summary(data),
                link: org ? `/o/${org.slug}/p/${project.slug}/messages` : null,
                dedupe: null,
            });
        }
        return thanks();
    });

    // ---- what was sent, for the studio's people -----------------------------------------------

    route("get", `${PROJECT}/submissions`, "content.read", async (c) => {
        const project = c.get("project");
        const [messages, unread] = await Promise.all([
            store.forms.list(project.tenantId, project.id),
            store.forms.unread(project.tenantId, project.id),
        ]);
        return c.json({ messages, unread });
    });

    // Everything that was sent, as a spreadsheet: one row each, one column per box in the forms.
    route("get", `${PROJECT}/submissions.csv`, "content.read", async (c) => {
        const project = c.get("project");
        const messages = (await store.forms.list(project.tenantId, project.id, 5000)).filter((m) => !m.preview);
        const columns = [...new Set(messages.flatMap((m) => Object.keys(m.data)))];
        // A cell a spreadsheet would run as a formula is made plain text.
        const cell = (v: string): string => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
        const rows = [
            ["Sent", "Form", ...columns].map(cell).join(","),
            ...messages.map((m) => [m.createdAt, m.form, ...columns.map((k) => m.data[k] ?? "")].map(cell).join(",")),
        ];
        return c.body(`\uFEFF${rows.join("\r\n")}\r\n`, 200, {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${project.slug}-messages.csv"`,
            "cache-control": "no-store",
        });
    });

    route("post", `${PROJECT}/submissions/read`, "content.write", async (c) => {
        const project = c.get("project");
        await store.forms.markRead(project.tenantId, project.id);
        return c.json({ ok: true });
    });

    route("delete", `${PROJECT}/submissions/:id`, "content.write", async (c) => {
        const project = c.get("project");
        await store.forms.remove(project.tenantId, project.id, param(c, "id"));
        await audit(c, "form.message.delete", `project:${project.id}`);
        return c.json({ ok: true });
    });
}
