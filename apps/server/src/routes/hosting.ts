import { randomUUID } from "node:crypto";
import { HostingError, normalizeHostname } from "../services/hosting.ts";
import { DomainTakenError } from "../store/types.ts";
import { type Api, type Ctx, PROJECT, param } from "./kit.ts";

// Where a website is live, and its custom domains (P3, docs/10 §3).
export function hostingRoutes(api: Api): void {
    const { route, store, stepUp, audit, hosting, releases } = api;
    // How many domains one website can have.
    const MOST_DOMAINS = 10;

    const failed = (c: Ctx, err: unknown) => {
        if (err instanceof DomainTakenError) return c.json({ error: err.message }, 409);
        if (err instanceof HostingError) {
            // Cloudflare's own wording for a refused domain is the useful part; other failures are ours to word.
            if (err.status === 409 || err.kind === "site") return c.json({ error: err.message }, 409);
            console.error(`hosting: ${err.message}`);
            return c.json({ error: "the hosting service could not do that just now; try again in a moment" }, 502);
        }
        throw err;
    };

    route("get", `${PROJECT}/hosting`, "release.read", async (c) => {
        const org = c.get("org");
        const project = c.get("project");
        const [mine, deployments] = await Promise.all([
            store.domains.list(org.id, project.id),
            store.deployments.listByProject(org.id, project.id),
        ]);
        // The provider says whether each domain is verified; if it cannot be asked, say "unknown" rather than fail the page.
        const status = new Map<string, { status: string; error: string | null }>();
        if (hosting && project.hostingRef && mine.length > 0) {
            const live = await hosting.listDomains(project.hostingRef).catch((err: Error) => {
                console.error(`hosting: could not ask about the domains of ${project.hostingRef}: ${err.message}`);
                return null;
            });
            for (const d of live ?? []) status.set(d.name, { status: d.status, error: d.error });
        }
        const last = deployments.at(-1);
        return c.json({
            enabled: hosting !== null,
            url: project.productionRef,
            // What a DNS record for a custom domain must point at.
            target: project.productionRef && URL.canParse(project.productionRef) ? new URL(project.productionRef).host : null,
            domains: mine.map((d) => ({
                hostname: d.hostname,
                status: status.get(d.hostname)?.status ?? "unknown",
                error: status.get(d.hostname)?.error ?? null,
                createdAt: d.createdAt,
            })),
            lastDeployment: last ? { state: last.state, error: last.error, createdAt: last.createdAt } : null,
        });
    });

    const requireHosting = (c: Ctx) => {
        if (!hosting) return c.json({ error: "hosting is not set up on this server" }, 409);
        if (c.get("project").archivedAt) return c.json({ error: "this website is archived; restore it first" }, 409);
        return null;
    };

    route("post", `${PROJECT}/domains`, "domain.manage", stepUp, async (c) => {
        const refused = requireHosting(c);
        if (refused || !hosting) return refused ?? c.json({ error: "not found" }, 404);
        const org = c.get("org");
        const project = c.get("project");
        const body = await c.req.json().catch(() => null);
        const hostname = typeof body?.hostname === "string" ? normalizeHostname(body.hostname) : null;
        if (!hostname) return c.json({ error: "enter a domain name, such as www.example.com" }, 400);
        if (!project.productionRef) return c.json({ error: "publish the website once before adding a domain" }, 409);
        if ((await store.domains.list(org.id, project.id)).length >= MOST_DOMAINS)
            return c.json({ error: `a website can have up to ${MOST_DOMAINS} domains` }, 409);
        try {
            // Claim the name here first, so two websites cannot race for it at the provider.
            await store.domains.add({ id: randomUUID(), tenantId: org.id, projectId: project.id, hostname, createdBy: c.get("user").id });
            let target: string;
            try {
                ({ target } = await hosting.addDomain(await releases.site(org.id, project), hostname));
            } catch (err) {
                // Give the name back. If that fails too, the provider's refusal is still what is answered.
                await store.domains
                    .remove(org.id, project.id, hostname)
                    .catch((gone: Error) => console.error(`hosting: could not give back the claim on ${hostname}: ${gone.message}`));
                throw err;
            }
            // Recorded once the provider has the domain: a failure from here on must not undo the claim.
            await audit(c, "domain.add", `project:${project.id}`, { hostname });
            return c.json({ hostname, target }, 201);
        } catch (err) {
            return failed(c, err);
        }
    });

    // Asks the provider to look at the DNS record again.
    route("post", `${PROJECT}/domains/:hostname/check`, "domain.manage", async (c) => {
        const refused = requireHosting(c);
        if (refused || !hosting) return refused ?? c.json({ error: "not found" }, 404);
        const org = c.get("org");
        const project = c.get("project");
        const hostname = normalizeHostname(param(c, "hostname"));
        if (!hostname || !project.hostingRef || !(await store.domains.list(org.id, project.id)).some((d) => d.hostname === hostname)) {
            return c.json({ error: "not found" }, 404);
        }
        try {
            await hosting.addDomain(project.hostingRef, hostname, true);
            return c.json({ ok: true });
        } catch (err) {
            return failed(c, err);
        }
    });

    // Allowed on an archived website too: taking a domain away is how its name is freed for another.
    route("delete", `${PROJECT}/domains/:hostname`, "domain.manage", stepUp, async (c) => {
        const org = c.get("org");
        const project = c.get("project");
        const hostname = normalizeHostname(param(c, "hostname"));
        if (!hostname || !(await store.domains.list(org.id, project.id)).some((d) => d.hostname === hostname)) {
            return c.json({ error: "not found" }, 404);
        }
        try {
            // (A domain the provider no longer has counts as removed there: the deployer answers that as done.)
            if (hosting && project.hostingRef) await hosting.removeDomain(project.hostingRef, hostname);
            await store.domains.remove(org.id, project.id, hostname).catch((err: Error) => {
                console.error(`hosting: ${hostname} was removed at the provider but its claim was not: ${err.message}`);
                throw err;
            });
            await audit(c, "domain.remove", `project:${project.id}`, { hostname });
            return c.json({ ok: true });
        } catch (err) {
            return failed(c, err);
        }
    });
}
