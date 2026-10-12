import type { NotificationStore, Store } from "../store/types.ts";

// Telling people about things that happen when they are not looking (E5.3): a
// request to the assistant that did not finish, a website that could not be
// published, a studio that reached its usage limit. Every notification is shown
// in the app; it is also e-mailed when mail is set up and the person wants that.

export interface Mailer {
    send(message: { to: string; subject: string; text: string }): Promise<void>;
}

// Resend's HTTP API (the platform already sends its sign-in mail through Resend).
export class ResendMailer implements Mailer {
    private readonly apiKey: string;
    private readonly from: string;
    private readonly fetch: typeof fetch;
    constructor(opts: { apiKey: string; from: string; fetch?: typeof fetch }) {
        this.apiKey = opts.apiKey;
        this.from = opts.from;
        this.fetch = opts.fetch ?? fetch;
    }
    async send(message: { to: string; subject: string; text: string }): Promise<void> {
        const res = await this.fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`the mail service answered ${res.status}`);
    }
}

export interface NoticeInput {
    tenantId: string | null;
    kind: string;
    title: string;
    body: string;
    // A path in the app to go and look.
    link: string | null;
    // The same event is told to a person once.
    dedupe: string | null;
}

export class Notifier {
    private readonly notifications: NotificationStore;
    private readonly store: Store;
    private readonly mailer: Mailer | null;
    private readonly origin: string;
    private readonly operatorEmail: string | null;
    // The operator is e-mailed about one kind of problem at most this often.
    private readonly lastOperatorMail = new Map<string, number>();

    constructor(store: Store, opts: { mailer: Mailer | null; publicOrigin: string; operatorEmail?: string | null }) {
        this.store = store;
        this.notifications = store.notifications;
        this.mailer = opts.mailer;
        this.origin = opts.publicOrigin.replace(/\/+$/, "");
        this.operatorEmail = opts.operatorEmail ?? null;
    }

    get emailAvailable(): boolean {
        return this.mailer !== null;
    }

    // Never throws: a notification that cannot be recorded or sent must not fail what it reports on.
    async tell(userIds: Iterable<string>, notice: NoticeInput): Promise<void> {
        for (const userId of new Set(userIds)) {
            try {
                const made = await this.notifications.add({ userId, ...notice });
                if (!made || !this.mailer || !(await this.notifications.emailWanted(userId))) continue;
                const user = await this.store.users.findById(userId);
                if (!user) continue;
                await this.mailer.send({ to: user.email, subject: notice.title, text: this.letter(notice) });
                await this.notifications.markEmailed(userId, made.id);
            } catch (err) {
                console.warn(`could not notify ${userId} (${notice.kind}): ${(err as Error).message}`);
            }
        }
    }

    // A plain e-mail to an address that may not belong to anyone here yet (an invitation).
    // Never throws; does nothing when e-mail is not set up.
    async mail(to: string, subject: string, text: string): Promise<void> {
        if (!this.mailer) return;
        await this.mailer.send({ to, subject, text }).catch((err: Error) => console.warn(`could not e-mail ${to}: ${err.message}`));
    }

    // A studio's owners and admins: the people who can do something about it.
    async tellStudio(tenantId: string, notice: Omit<NoticeInput, "tenantId">, alsoTell: string[] = []): Promise<void> {
        const members = await this.store.memberships.list(tenantId).catch(() => []);
        const responsible = members.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.userId);
        await this.tell([...responsible, ...alsoTell], { ...notice, tenantId });
    }

    // Whoever runs this Atelier: a problem on the platform's side, not a studio's.
    async tellOperator(kind: string, title: string, body: string): Promise<void> {
        const admins = await this.notifications.admins().catch(() => []);
        const hour = new Date().toISOString().slice(0, 13);
        for (const userId of admins) {
            await this.notifications
                .add({ userId, tenantId: null, kind, title, body, link: "/operator", dedupe: `${kind}:${hour}` })
                .catch((err: Error) => console.warn(`could not notify operator: ${err.message}`));
        }
        const last = this.lastOperatorMail.get(kind) ?? 0;
        if (!this.mailer || !this.operatorEmail || Date.now() - last < 30 * 60_000) return;
        this.lastOperatorMail.set(kind, Date.now());
        await this.mailer
            .send({ to: this.operatorEmail, subject: `Atelier: ${title}`, text: `${body}\n\n${this.origin}/operator\n` })
            .catch((err: Error) => console.warn(`could not e-mail the operator: ${err.message}`));
    }

    private letter(notice: NoticeInput): string {
        const where = notice.link ? `\n\nOpen it: ${this.origin}${notice.link}` : "";
        return `${notice.body}${where}\n\n—\nAtelier. To stop these e-mails, open Notifications in Atelier and untick "E-mail me about these too".\n`;
    }
}
