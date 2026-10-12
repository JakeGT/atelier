import { randomBytes, randomUUID } from "node:crypto";
import type { Organization, User } from "@atelier/shared";
import type { Store } from "../store/types.ts";

const slugify = (s: string): string =>
    s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

// "Maren Okoro" -> "Maren's studio". With only an e-mail address to go on, the part before the @.
export function personalStudioName(user: Pick<User, "name" | "email">): string {
    const first = (user.name.trim().split(/\s+/)[0] || user.email.split("@")[0] || "My").slice(0, 40);
    return `${first}${first.endsWith("s") ? "'" : "'s"} studio`;
}

// Everyone has exactly one personal studio, which they own, from the moment they
// first arrive: being invited into someone else's studio does not replace it.
// Called on every sign-in, so it also repairs an account that somehow lacks one.
//
// People who were here before personal studios existed keep the studio that was
// made for them then: the oldest one they own that is nobody's personal studio.
export async function ensurePersonalStudio(store: Store, user: Pick<User, "id" | "name" | "email" | "onboardedAt">): Promise<Organization> {
    const orgs = await store.organizations.listForUser(user.id);
    const mine = orgs.find((o) => o.personalOf === user.id);
    if (mine) return mine;

    if (user.onboardedAt) {
        for (const org of orgs) {
            if (org.role === "owner" && !org.personalOf && (await store.organizations.setPersonal(org.id, user.id))) {
                return { ...org, personalOf: user.id };
            }
        }
    }

    const base = slugify(user.name || user.email).slice(0, 24) || "studio";
    const org = await store.organizations.create({
        id: randomUUID(),
        slug: `${base}-${randomBytes(6).toString("hex")}`,
        name: personalStudioName(user),
        personalOf: user.id,
    });
    await store.memberships.add({ tenantId: org.id, userId: user.id, role: "owner" });
    await store.audit.record({
        tenantId: org.id,
        actorId: user.id,
        action: "org.create",
        target: `org:${org.id}`,
        detail: { name: org.name, personal: true },
    });
    return org;
}

// Studios the person has been added to (by e-mail) become memberships. Returns how many.
export async function acceptInvitations(
    store: Store,
    user: Pick<User, "id" | "email"> & { name?: string },
    // Told when someone joins: the new member, and the studio's owners and admins.
    notifier?: {
        tell: (
            userIds: string[],
            notice: { tenantId: string | null; kind: string; title: string; body: string; link: string | null; dedupe: string | null },
        ) => Promise<void>;
    },
): Promise<number> {
    const joined = await store.invitations.acceptAll(user.id, user.email);
    for (const tenantId of joined) {
        await store.audit.record({ tenantId, actorId: user.id, action: "invitation.accept", target: `user:${user.id}`, detail: null });
        if (!notifier) continue;
        const org = await store.organizations.findById(tenantId);
        if (!org) continue;
        await notifier.tell([user.id], {
            tenantId,
            kind: "studio.joined",
            title: `You now belong to ${org.name}`,
            body: `You were added to the studio ${org.name}. Its websites are there for you to open.`,
            link: `/o/${org.slug}`,
            dedupe: `joined:${tenantId}`,
        });
        const others = (await store.memberships.list(tenantId))
            .filter((m) => (m.role === "owner" || m.role === "admin") && m.userId !== user.id)
            .map((m) => m.userId);
        await notifier.tell(others, {
            tenantId,
            kind: "studio.member",
            title: `${user.name ?? user.email} joined ${org.name}`,
            body: `${user.name ?? user.email} (${user.email}) accepted the invitation and can now open the studio's websites.`,
            link: `/o/${org.slug}/settings`,
            dedupe: `member:${tenantId}:${user.id}`,
        });
    }
    return joined.length;
}
