import { randomUUID } from "node:crypto";
import { type ContentField, contentFieldSchema, FIELD_TYPES } from "@atelier/shared";
import type { Context } from "hono";
import { z } from "zod";
import { readTar } from "../runtime/tar.ts";
import { type AgentTokenClaims, verifyAgentToken } from "../services/agentToken.ts";
import { cleanQuestions } from "../services/asking.ts";
import { type PageCoverage, pageCoverage } from "../services/coverage.ts";
import { sanitizeRich } from "../services/fill.ts";
import { type Api, PROJECT, param } from "./kit.ts";

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// Content: drafts only. Publishing is the release workflow (ADR-0007), so there
// is no publish route here, for people or for the agent.
export function contentRoutes(api: Api): void {
    const { route, store, audit, app, declared, secretsKey } = api;

    // Rich-text fields are reduced to the allowed formatting before they are stored
    // (and again when a page is filled): nothing else ever reaches a page.
    const prepared = async (tenantId: string, projectId: string, kind: string, slug: string, draft: Record<string, unknown>) => {
        const fields = (await store.content.get(tenantId, projectId, kind, slug))?.fields ?? [];
        const byKey = new Map(fields.map((f) => [f.key, f]));
        return Object.fromEntries(
            Object.entries(draft).map(([k, v]) => {
                const field = byKey.get(k);
                if (field?.type === "rich" && typeof v === "string") return [k, sanitizeRich(v)];
                if (field?.type === "items" && Array.isArray(v)) {
                    const rich = new Set((field.itemFields ?? []).filter((f) => f.type === "rich").map((f) => f.key));
                    return [
                        k,
                        v
                            .slice(0, 500)
                            .map((entry) =>
                                isObject(entry)
                                    ? Object.fromEntries(
                                          Object.entries(entry).map(([ik, iv]) => [
                                              ik,
                                              rich.has(ik) && typeof iv === "string" ? sanitizeRich(iv) : iv,
                                          ]),
                                      )
                                    : entry,
                            ),
                    ];
                }
                return [k, v];
            }),
        );
    };

    // How many fields one document may describe: far more than a page needs, and a bound on what is stored.
    const MOST_FIELDS = 500;
    const fieldList = z.array(contentFieldSchema).max(MOST_FIELDS);
    // What is wrong with a list of fields, said so that whoever sent it can put it right.
    const fieldProblems = (sent: unknown, issues: z.core.$ZodIssue[]): string => {
        if (!Array.isArray(sent)) return "fields must be a list, each one { key, label, type, help?, required?, max?, itemFields? }";
        if (sent.length > MOST_FIELDS)
            return `a document can describe up to ${MOST_FIELDS} fields and this has ${sent.length}: put a repeated group into one field of type items`;
        const said = issues.slice(0, 8).map((issue) => {
            const [index, ...rest] = issue.path;
            const field = typeof index === "number" && isObject(sent[index]) ? sent[index] : null;
            const which = field && typeof field.key === "string" ? `field "${field.key}"` : `field ${Number(index) + 1}`;
            return `${which}${rest.length ? `, ${rest.join(".")}` : ""}: ${issue.message}`;
        });
        const more = issues.length > said.length ? ` (and ${issues.length - said.length} more)` : "";
        return `${said.join("; ")}${more}. A field is { key: letters, digits, - and _, starting with a letter; label: up to 80 characters; type: ${FIELD_TYPES.join(" | ")}; help?: up to 200 characters; required?; max?; itemFields?: for type items, 1 to 40 parts }`;
    };
    // Describes how a document's fields are shown: labels, types, help. Its content is untouched.
    // `merge`: the fields sent are added to those already described (one of the same key takes its place).
    const setFields = async (tenantId: string, projectId: string, kind: string, slug: string, body: unknown, merge = false) => {
        const sent = isObject(body) ? body.fields : body;
        const kept = merge && Array.isArray(sent) ? ((await store.content.get(tenantId, projectId, kind, slug))?.fields ?? []) : [];
        const sentKeys = new Set(Array.isArray(sent) ? sent.map((f) => (isObject(f) ? f.key : null)) : []);
        const all = Array.isArray(sent) ? [...kept.filter((f) => !sentKeys.has(f.key)), ...sent] : sent;
        const parsed = fieldList.safeParse(all);
        if (!parsed.success) return { error: fieldProblems(all, parsed.error.issues) } as const;
        const keys = new Set<string>();
        const fields: ContentField[] = parsed.data.filter((f) => !keys.has(f.key) && keys.add(f.key));
        const document = await store.content.setFields(tenantId, projectId, kind, slug, fields);
        return document
            ? ({ document } as const)
            : ({ error: "save the document's content before describing its fields", missing: true } as const);
    };

    route("get", `${PROJECT}/content`, "content.read", async (c) =>
        c.json({ documents: await store.content.list(c.get("org").id, c.get("project").id) }),
    );

    route("put", `${PROJECT}/content/:kind/:slug`, "content.write", async (c) => {
        const kind = param(c, "kind");
        const slug = param(c, "slug");
        if (!KEY_RE.test(kind) || !KEY_RE.test(slug)) return c.json({ error: "invalid kind or slug" }, 400);
        const body = await c.req.json().catch(() => null);
        if (!isObject(body)) return c.json({ error: "content draft must be a JSON object" }, 400);
        // `?rev=`: the revision the person was editing. If it has moved on since
        // (someone else, or the assistant, saved meanwhile), say so instead of
        // silently overwriting their change.
        const based = c.req.query("rev");
        if (based !== undefined) {
            const current = await store.content.get(c.get("org").id, c.get("project").id, kind, slug);
            if (current && String(current.rev) !== based) {
                const who = current.updatedBy ? ((await store.users.findById(current.updatedBy))?.name ?? "Someone") : "Your assistant";
                return c.json(
                    { error: `${who} changed this while you were editing, so your version was not saved`, document: current },
                    409,
                );
            }
        }
        const document = await store.content.upsertDraft({
            tenantId: c.get("org").id,
            projectId: c.get("project").id,
            kind,
            slug,
            draft: await prepared(c.get("org").id, c.get("project").id, kind, slug, body),
            updatedBy: c.get("user").id,
        });
        return c.json({ document });
    });

    route("put", `${PROJECT}/content/:kind/:slug/fields`, "content.write", async (c) => {
        const out = await setFields(
            c.get("org").id,
            c.get("project").id,
            param(c, "kind"),
            param(c, "slug"),
            await c.req.json().catch(() => null),
        );
        return "error" in out ? c.json({ error: out.error }, "missing" in out ? 404 : 400) : c.json(out);
    });

    route("get", `${PROJECT}/content/:kind/:slug/revisions`, "content.read", async (c) => {
        const doc = await store.content.get(c.get("org").id, c.get("project").id, param(c, "kind"), param(c, "slug"));
        if (!doc) return c.json({ error: "not found" }, 404);
        return c.json({ revisions: await store.content.revisions(c.get("org").id, doc.id) });
    });

    // Restoring a content revision writes it back as a new draft (so it is itself undoable).
    route("post", `${PROJECT}/content/:kind/:slug/revisions/:rev/restore`, "content.write", async (c) => {
        const org = c.get("org");
        const doc = await store.content.get(org.id, c.get("project").id, param(c, "kind"), param(c, "slug"));
        const rev = Number(param(c, "rev"));
        const revision = doc && Number.isInteger(rev) ? await store.content.revision(org.id, doc.id, rev) : null;
        if (!doc || !revision?.draft) return c.json({ error: "not found" }, 404);
        const document = await store.content.upsertDraft({
            tenantId: org.id,
            projectId: doc.projectId,
            kind: doc.kind,
            slug: doc.slug,
            draft: revision.draft,
            updatedBy: c.get("user").id,
        });
        await audit(c, "content.restore", `content:${doc.id}`, { rev });
        return c.json({ document });
    });

    // Where each piece of wording appears: for every page of the website, the fields
    // its elements are bound to. The Content page uses it to say "on the Home page"
    // beside a field, to show it in the preview, and to say plainly when wording is
    // not connected to any page (so changing it would change nothing). It also says
    // how much of each page a visitor can read but nobody can edit (`loose`).
    const maps = new Map<string, { head: string; pages: PageCoverage[] }>();
    route("get", `${PROJECT}/content/map`, "content.read", async (c) => {
        const project = c.get("project");
        if (project.archivedAt) return c.json({ pages: [] });
        const head = await api.runtime.head(project.id).catch(() => null);
        if (!head) return c.json({ pages: [] });
        const cached = maps.get(project.id);
        if (cached?.head === head) return c.json({ pages: cached.pages });
        try {
            const archive = Buffer.from(await api.runtime.exportTree(project.id, head));
            const pages = readTar(archive, { maxEntries: 20_000 })
                .filter((e) => e.type === "file" && /\.html?$/i.test(e.path) && !e.path.split("/").some((part) => part.startsWith(".")))
                .slice(0, 300)
                .map((e) => pageCoverage(e.path, e.body.toString("utf8")))
                .sort((x, y) => (x.path === "index.html" ? -1 : y.path === "index.html" ? 1 : x.path.localeCompare(y.path)));
            maps.set(project.id, { head, pages });
            if (maps.size > 500) maps.delete(maps.keys().next().value ?? "");
            return c.json({ pages });
        } catch (err) {
            return api.runtimeError(c, err);
        }
    });

    // One history of a website: what the assistant changed (versions of its files),
    // what was changed in its wording (and by whom), and when it was published,
    // newest first. Each kind is undone in its own way; this is the single place to
    // see them in the order they happened.
    route("get", `${PROJECT}/history`, "project.read", async (c) => {
        const org = c.get("org");
        const project = c.get("project");
        const [versions, revisions, releases, documents] = await Promise.all([
            project.archivedAt ? [] : api.runtime.listCheckpoints(project.id).catch(() => []),
            store.content.recentRevisions(org.id, project.id, 150),
            store.releases.listByProject(org.id, project.id).catch(() => []),
            store.content.list(org.id, project.id),
        ]);
        const names = new Map<string, string>();
        for (const id of new Set(revisions.map((r) => r.updatedBy).filter((x): x is string => x !== null))) {
            names.set(id, (await store.users.findById(id))?.name ?? "Someone");
        }
        const current = new Map(documents.map((d) => [d.id, d.rev]));
        const entries = [
            ...versions.map((v, i) => ({ type: "version" as const, at: v.date, title: v.message, sha: v.sha, current: i === 0 })),
            ...revisions.map((r) => ({
                type: "wording" as const,
                at: r.createdAt,
                kind: r.kind,
                slug: r.slug,
                rev: r.rev,
                // null: the assistant.
                by: r.updatedBy ? (names.get(r.updatedBy) ?? "Someone") : null,
                current: current.get(r.documentId) === r.rev,
            })),
            ...releases
                .filter((r) => r.deployedAt !== null)
                .map((r) => ({
                    type: "published" as const,
                    at: r.deployedAt ?? r.createdAt,
                    number: r.number,
                    live: r.state === "live",
                    putBack: r.rollbackOf !== null,
                })),
        ]
            .sort((x, y) => y.at.localeCompare(x.at))
            .slice(0, 200);
        return c.json({ entries });
    });

    // What the live release ships (the build input).
    route("get", `${PROJECT}/snapshot`, "content.read", async (c) =>
        c.json({ documents: await store.content.snapshot(c.get("org").id, c.get("project").id) }),
    );

    // ---- agent surface ----------------------------------------------------------------
    // Authenticated by a short-lived token scoped to one tenant + project + session.
    // There is deliberately no publish, delete, or cross-project route here. A token
    // stops working the moment its project is archived or deleted.

    const agentRoute = (method: "get" | "put", path: string, handler: (c: Context, claims: AgentTokenClaims) => Promise<Response>) => {
        declared.push({ method: method.toUpperCase(), path, permission: "agent-token" });
        app[method](path, async (c) => {
            const auth = c.req.header("authorization");
            const claims = auth?.startsWith("Bearer ") ? verifyAgentToken(auth.slice(7), secretsKey) : null;
            if (!claims) return c.json({ error: "unauthorized" }, 401);
            const project = await store.projects.findById(claims.tenantId, claims.projectId);
            if (!project || project.archivedAt) return c.json({ error: "unauthorized" }, 401);
            return handler(c, claims);
        });
    };

    // The assistant asks the person something and stops; the answer comes as the next message.
    agentRoute("put", "/api/agent/questions", async (c, claims) => {
        const project = await store.projects.findById(claims.tenantId, claims.projectId);
        if (project?.askLevel === 0) return c.json({ asked: false, reason: "decide" });
        const questions = cleanQuestions(((await c.req.json().catch(() => null)) as { questions?: unknown } | null)?.questions);
        if (!questions) return c.json({ error: "give at least one question" }, 400);
        const made = await store.questions.ask({
            id: randomUUID(),
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            sessionId: claims.sessionId,
            questions,
        });
        return c.json({ asked: true, id: made.id, questions: made.questions.length });
    });

    agentRoute("get", "/api/agent/content", async (c, claims) =>
        c.json({ documents: await store.content.list(claims.tenantId, claims.projectId) }),
    );
    agentRoute("get", "/api/agent/content/:kind/:slug", async (c, claims) =>
        c.json({ document: await store.content.get(claims.tenantId, claims.projectId, param(c, "kind"), param(c, "slug")) }),
    );
    agentRoute("put", "/api/agent/content/:kind/:slug/fields", async (c, claims) => {
        const out = await setFields(
            claims.tenantId,
            claims.projectId,
            param(c, "kind"),
            param(c, "slug"),
            await c.req.json().catch(() => null),
            c.req.query("replace") !== "1",
        );
        return "error" in out ? c.json({ error: out.error }, "missing" in out ? 404 : 400) : c.json(out);
    });
    // What the assistant sends is added to what is saved, so sending a few values never loses the rest.
    // `?replace=1` makes what is sent the whole of it; `?remove=a,b` takes those values (and their fields) away.
    agentRoute("put", "/api/agent/content/:kind/:slug", async (c, claims) => {
        const kind = param(c, "kind");
        const slug = param(c, "slug");
        if (!KEY_RE.test(kind) || !KEY_RE.test(slug)) return c.json({ error: "invalid kind or slug" }, 400);
        const body = await c.req.json().catch(() => null);
        if (!isObject(body)) return c.json({ error: "draft must be a JSON object" }, 400);
        const remove = new Set((c.req.query("remove") ?? "").split(",").filter(Boolean));
        const saved = await store.content.get(claims.tenantId, claims.projectId, kind, slug);
        const draft = c.req.query("replace") === "1" ? body : { ...(saved?.draft ?? {}), ...body };
        for (const key of remove) delete draft[key];
        if (remove.size && saved?.fields?.some((f) => remove.has(f.key))) {
            await store.content.setFields(
                claims.tenantId,
                claims.projectId,
                kind,
                slug,
                saved.fields.filter((f) => !remove.has(f.key)),
            );
        }
        const doc = await store.content.upsertDraft({
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            kind,
            slug,
            draft: await prepared(claims.tenantId, claims.projectId, kind, slug, draft),
            updatedBy: null,
        });
        return c.json({ document: doc });
    });
}
