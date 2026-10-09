import { randomBytes, randomUUID } from "node:crypto";
import type { Store } from "../store/types.ts";

const slugify = (s: string): string =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

// Creates the user's first organization + owner membership if they have none.
// Called on sign-in so a fresh account immediately owns a tenant (P1 single-tenant
// slice). Multi-tenant org creation/joining arrives with P2.
export async function ensureUserOrg(store: Store, userId: string, email: string, name: string): Promise<void> {
    const orgs = await store.organizations.listForUser(userId);
    if (orgs.length > 0) return;
    const base = slugify(name || email).slice(0, 24) || "org";
    const slug = `${base}-${randomBytes(6).toString("hex")}`;
    const org = await store.organizations.create({ id: randomUUID(), slug, name: name || email });
    await store.memberships.add({ tenantId: org.id, userId, role: "owner" });
}
