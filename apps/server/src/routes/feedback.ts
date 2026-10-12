import { createHash, randomUUID } from "node:crypto";
import { RateLimiter } from "../security.ts";
import { verifyAgentToken } from "../services/agentToken.ts";
import type { Notifier } from "../services/notifier.ts";
import type { FeedbackReport, Store } from "../store/types.ts";
import { type Api, param } from "./kit.ts";

const PERSON_KINDS = ["problem", "idea"] as const;
const ASSISTANT_KINDS = ["tool", "rules", "missing", "other"] as const;
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

const KIND_NAMES: Record<string, string> = {
    problem: "Something is wrong",
    idea: "An idea",
    tool: "A tool did not work as described",
    rules: "The rules were unclear or contradicted each other",
    missing: "Something it needed was missing",
    other: "Something else",
    crash: "A screen stopped working",
    error: "An error nothing caught",
    freeze: "The page froze",
    "large-save": "An unusually large save",
};
const NOTICED_KINDS = ["crash", "error", "freeze"] as const;
const NOTICED_TITLES: Record<(typeof NOTICED_KINDS)[number], string> = {
    crash: "A screen stopped working for someone",
    error: "An error in the app that nothing caught",
    freeze: "The app froze for someone",
};
// What happened, apart from who it happened to and when: the kind and the first line of it,
// with the parts that differ from one build or one visit to the next taken out.
const signatureOf = (kind: string, what: string): string =>
    createHash("sha256")
        .update(
            `${kind}\n${(what.split("\n")[0] ?? "")
                .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
                .replace(/-[A-Za-z0-9_-]{8}\.js/g, ".js")
                .replace(/\d+(\.\d+)?/g, "<n>")}`,
        )
        .digest("hex")
        .slice(0, 32);

// Saves are not limited in size (the owner's decision, 2026-10-12): they are watched instead.
// One at or past a megabyte is noted here, one report for each website and size, counting.
const LARGE_SAVE = 1_000_000;
export async function noteLargeSave(
    store: Store,
    save: { bytes: number; tenantId: string; projectId: string; kind: string; slug: string; by: "a person" | "the assistant" },
): Promise<void> {
    if (!(save.bytes >= LARGE_SAVE)) return;
    const size = [50, 20, 10, 5, 2, 1].find((mb) => save.bytes >= mb * 1_000_000) ?? 1;
    const [org, project] = await Promise.all([
        store.organizations.findById(save.tenantId),
        store.projects.findById(save.tenantId, save.projectId),
    ]);
    await store.feedback.noticed(
        {
            id: randomUUID(),
            source: "app",
            kind: "large-save",
            text: `Wording of ${size} MB or more was saved to one piece of a website. Nothing was refused: saves have no size limit, and this is here so that a limit can be decided on if they become a problem.`,
            context: {
                ...(org ? { studio: org.name } : {}),
                ...(project ? { website: project.name } : {}),
                page: `${save.kind}/${save.slug}`,
                from: save.by,
                size: `${(save.bytes / 1_000_000).toFixed(1)} MB (the latest)`,
            },
            tenantId: save.tenantId,
            projectId: save.projectId,
            userId: null,
        },
        signatureOf("large-save", `${save.projectId} ${size}MB`),
    );
}

// Open reports as a document: for reading in one go, and for handing to whoever improves Atelier next.
export function reportsDocument(reports: FeedbackReport[], now = new Date()): string {
    const section = (title: string, list: FeedbackReport[]) =>
        list.length === 0
            ? ""
            : `## ${title} (${list.length})\n\n${list
                  .map((r) => {
                      const where = [r.context.studio, r.context.website, r.context.page].filter(Boolean).join(" · ");
                      const times = r.seen > 1 ? `, ${r.seen} times, last ${(r.lastSeenAt ?? r.createdAt).slice(0, 10)}` : "";
                      const detail = r.context.detail ? `\n\`\`\`\n${r.context.detail}\n\`\`\`\n` : "";
                      return `### ${KIND_NAMES[r.kind] ?? r.kind}, ${r.createdAt.slice(0, 10)}${times}\n${where ? `_${where}_\n` : ""}\n${r.text}\n${detail}`;
                  })
                  .join("\n")}`;
    return `# Atelier: open reports, ${now.toISOString().slice(0, 10)}\n\n${
        [
            section(
                "From people",
                reports.filter((r) => r.source === "person"),
            ),
            section(
                "From the assistant",
                reports.filter((r) => r.source === "assistant"),
            ),
            section(
                "Noticed by Atelier itself",
                reports.filter((r) => r.source === "app"),
            ),
        ]
            .filter(Boolean)
            .join("\n") || "Nothing is open.\n"
    }`;
}

// "2026-W41": the ISO week a day falls in.
export function isoWeek(day: Date): string {
    const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    // Thursday of this week decides the year.
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Once a week, what is still open, to whoever runs this Atelier. Nothing open: nothing sent.
// Called daily; it sends on the first call of each week from Monday on. Returns whether it sent.
export async function weeklyDigest(store: Store, notifier: Notifier, now = new Date()): Promise<boolean> {
    const open = await store.feedback.list({ status: "open", limit: 1000 });
    if (open.length === 0) return false;
    const people = open.filter((r) => r.source === "person").length;
    const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const fresh = open.filter((r) => r.createdAt >= week).length;
    const title = `${open.length} open ${open.length === 1 ? "report" : "reports"} this week`;
    const summary = `${people} from people, ${open.length - people} from the assistant; ${fresh} new in the last seven days.`;
    return notifier.tellOperatorOnce("feedback.digest", isoWeek(now), title, `${summary}\n\n${reportsDocument(open, now)}`);
}

// Reports about Atelier itself (ADR-0020): from a person, from the assistant, and for the operator to read.
export function feedbackRoutes(api: Api): void {
    const { route, store, app, declared, secretsKey, notifier } = api;
    const perPerson = new RateLimiter(10, 60 * 60_000);
    // The assistant may say a few things a day about one website, not a running commentary.
    const perWebsite = new RateLimiter(5, 24 * 60 * 60_000);

    route("post", "/api/v1/feedback", "signed-in", async (c) => {
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        const said = text(body?.text, 4000);
        const kind = PERSON_KINDS.find((k) => k === body?.kind) ?? "problem";
        if (said.length < 3) return c.json({ error: "say what happened, or what you would like" }, 400);
        const user = c.get("user");
        if (!perPerson.allow(user.id)) return c.json({ error: "that is a lot of reports in an hour; try again later" }, 429);
        // The studio and website are named only if this person really is in them.
        const orgs = await store.organizations.listForUser(user.id);
        const org = orgs.find((o) => o.slug === text(body?.org, 80)) ?? null;
        const project = org ? await store.projects.findBySlug(org.id, text(body?.project, 80)).catch(() => null) : null;
        const report = await store.feedback.add({
            id: randomUUID(),
            source: "person",
            kind,
            text: said,
            context: {
                from: `${user.name} <${user.email}>`,
                ...(org ? { studio: org.name } : {}),
                ...(project ? { website: project.name } : {}),
                page: text(body?.page, 300),
                browser: text(c.req.header("user-agent"), 300),
                screen: text(body?.screen, 40),
                build: text(c.req.header("x-atelier-build"), 80) || text(body?.build, 80),
            },
            tenantId: org?.id ?? null,
            projectId: project?.id ?? null,
            userId: user.id,
        });
        void notifier.tellOperator(
            "feedback.person",
            kind === "idea" ? `${user.name} has an idea` : `${user.name} reported a problem`,
            `${said.slice(0, 600)}\n\n${[report.context.studio, report.context.website, report.context.page].filter(Boolean).join(" · ")}`,
        );
        return c.json({ ok: true }, 201);
    });

    // What the app noticed about itself in someone's browser: a screen that stopped working, an
    // error nothing caught, a page that froze. Sent without the person doing anything (they are
    // told on the screen where there is one), so it carries what happened and where, and nothing
    // they typed. The same thing again counts on the report already open.
    const perPersonNoticed = new RateLimiter(30, 60 * 60_000);
    route("post", "/api/v1/feedback/noticed", "signed-in", async (c) => {
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        const kind = NOTICED_KINDS.find((k) => k === body?.kind);
        const what = text(body?.text, 500);
        if (!kind || what.length < 3) return c.json({ error: "say what happened" }, 400);
        const user = c.get("user");
        if (!perPersonNoticed.allow(user.id)) return c.json({ ok: true, kept: false }, 202);
        const orgs = await store.organizations.listForUser(user.id);
        const org = orgs.find((o) => o.slug === text(body?.org, 80)) ?? null;
        const project = org ? await store.projects.findBySlug(org.id, text(body?.project, 80)).catch(() => null) : null;
        const signature = signatureOf(kind, what);
        const report = await store.feedback.noticed(
            {
                id: randomUUID(),
                source: "app",
                kind,
                text: what,
                context: {
                    from: `${user.name} <${user.email}>`,
                    ...(org ? { studio: org.name } : {}),
                    ...(project ? { website: project.name } : {}),
                    page: text(body?.page, 300),
                    browser: text(c.req.header("user-agent"), 300),
                    screen: text(body?.screen, 40),
                    build: text(c.req.header("x-atelier-build"), 80) || text(body?.build, 80),
                    detail: text(body?.detail, 6000),
                },
                tenantId: org?.id ?? null,
                projectId: project?.id ?? null,
                userId: user.id,
            },
            signature,
        );
        // Whoever runs Atelier is told the first time each thing is seen, not every time.
        if (report.seen === 1)
            void notifier.tellOperatorOnce(
                "feedback.app",
                signature,
                NOTICED_TITLES[kind],
                `${what}\n\n${[report.context.studio, report.context.website, report.context.page].filter(Boolean).join(" · ")}\n\n${report.context.detail ?? ""}`,
            );
        return c.json({ ok: true, kept: true }, 201);
    });

    // The assistant, about the system it works in: never about the person or their website's content.
    declared.push({ method: "PUT", path: "/api/agent/feedback", permission: "agent-token" });
    app.put("/api/agent/feedback", async (c) => {
        const auth = c.req.header("authorization");
        const claims = auth?.startsWith("Bearer ") ? verifyAgentToken(auth.slice(7), secretsKey) : null;
        const project = claims ? await store.projects.findById(claims.tenantId, claims.projectId) : null;
        if (!claims || !project || project.archivedAt) return c.json({ error: "unauthorized" }, 401);
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        const said = text(body?.text, 1200);
        if (said.length < 10) return c.json({ error: "say what got in the way, in a sentence or two" }, 400);
        if (!perWebsite.allow(project.id)) return c.json({ recorded: false, reason: "enough has been reported from this website today" });
        const org = await store.organizations.findById(claims.tenantId);
        await store.feedback.add({
            id: randomUUID(),
            source: "assistant",
            kind: ASSISTANT_KINDS.find((k) => k === body?.kind) ?? "other",
            text: said,
            context: { studio: org?.name ?? "", website: project.name, model: project.agentModel ?? org?.defaultModel ?? "built-in" },
            tenantId: claims.tenantId,
            projectId: project.id,
            userId: null,
        });
        void notifier.tellOperator("feedback.assistant", "The assistant reported something about Atelier", said.slice(0, 600));
        return c.json({ recorded: true });
    });

    route("get", "/api/v1/admin/feedback", "admin.audit", async (c) => {
        const status = c.req.query("status");
        const reports = await store.feedback.list({ status: status === "open" || status === "done" ? status : undefined });
        return c.json({ reports, open: (await store.feedback.list({ status: "open", limit: 1000 })).length });
    });

    // Everything open, as one document.
    route("get", "/api/v1/admin/feedback.md", "admin.audit", async (c) =>
        c.body(reportsDocument(await store.feedback.list({ status: "open", limit: 1000 })), 200, {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="atelier-reports-${new Date().toISOString().slice(0, 10)}.md"`,
            "cache-control": "no-store",
        }),
    );

    route("patch", "/api/v1/admin/feedback/:id", "admin.audit", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
        if (body?.status !== "open" && body?.status !== "done") return c.json({ error: "status must be open or done" }, 400);
        const report = await store.feedback.setStatus(param(c, "id"), body.status);
        return report ? c.json({ report }) : c.json({ error: "not found" }, 404);
    });
}
