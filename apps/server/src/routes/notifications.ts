import type { Api } from "./kit.ts";

// A person's own notifications: what happened while they were not looking.
export function notificationRoutes(api: Api): void {
    const { route, store, notifier } = api;

    route("get", "/api/v1/notifications", "signed-in", async (c) => {
        const userId = c.get("user").id;
        const [notifications, unread, email] = await Promise.all([
            store.notifications.list(userId),
            store.notifications.unread(userId),
            store.notifications.emailWanted(userId),
        ]);
        // `emailAvailable`: whether this server can send e-mail at all.
        return c.json({ notifications, unread, email, emailAvailable: notifier.emailAvailable });
    });

    route("post", "/api/v1/notifications/read", "signed-in", async (c) => {
        await store.notifications.markRead(c.get("user").id);
        return c.json({ ok: true });
    });

    route("put", "/api/v1/notifications/email", "signed-in", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
        if (typeof body?.on !== "boolean") return c.json({ error: "on must be true or false" }, 400);
        await store.notifications.setEmailWanted(c.get("user").id, body.on);
        return c.json({ email: body.on });
    });
}
