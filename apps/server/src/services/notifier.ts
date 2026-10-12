import type { NotificationStore, Store } from "../store/types.ts";
import { mailHtml } from "./mailHtml.ts";

// Telling people about things that happen when they are not looking (E5.3): a
// request to the assistant that did not finish, a website that could not be
// published, a studio that reached its usage limit. Every notification is shown
// in the app; it is also e-mailed when mail is set up and the person wants that.

export interface Mail {
    to: string;
    subject: string;
    // What a program that shows no formatting shows.
    text: string;
    // The same, drawn in Atelier's own style (services/mailHtml.ts).
    html?: string;
}
export interface Mailer {
    send(message: Mail): Promise<void>;
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
    async send(message: Mail): Promise<void> {
        const res = await this.fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
                from: this.from,
                to: [message.to],
                subject: message.subject,
                text: message.text,
                ...(message.html ? { html: message.html } : {}),
            }),
            signal: AbortSignal.timeout(15_000),
        });
        // Its reason goes with the number (a refused sender and a rate limit are different repairs); this is only ever logged.
        if (!res.ok) {
            const why = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
            throw new Error(`the mail service answered ${res.status}${why ? `: ${why}` : ""}`);
        }
    }
}

const STOP = 'To stop these e-mails, open Notifications in Atelier and untick "E-mail me about these too".';

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
    private readonly sentOnce = new Set<string>();

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
                await this.mailer.send({
                    to: user.email,
                    subject: notice.title,
                    text: this.letter(notice),
                    html: mailHtml({
                        title: notice.title,
                        body: notice.body,
                        action: notice.link ? { href: `${this.origin}${notice.link}`, label: "Open it in Atelier" } : null,
                        foot: STOP,
                        origin: this.origin,
                    }),
                });
                await this.notifications.markEmailed(userId, made.id);
            } catch (err) {
                console.warn(`could not notify ${userId} (${notice.kind}): ${(err as Error)?.message ?? err}`);
            }
        }
    }

    // A plain e-mail to an address that may not belong to anyone here yet (an invitation).
    // Never throws; does nothing when e-mail is not set up.
    async mail(to: string, subject: string, text: string): Promise<void> {
        if (!this.mailer) return;
        await this.mailer
            .send({ to, subject, text, html: mailHtml({ title: subject, body: text, origin: this.origin }) })
            .catch((err: Error) => console.warn(`could not e-mail ${to}: ${err.message}`));
    }

    // A studio's owners and admins: the people who can do something about it.
    async tellStudio(tenantId: string, notice: Omit<NoticeInput, "tenantId">, alsoTell: string[] = []): Promise<void> {
        const members = await this.store.memberships.list(tenantId).catch((err: Error) => {
            console.warn(`could not find who to tell in studio ${tenantId} (${notice.kind}): ${err?.message ?? err}`);
            return [];
        });
        const responsible = members.filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.userId);
        await this.tell([...responsible, ...alsoTell], { ...notice, tenantId });
    }

    // Something sent to the operator once per period (a weekly digest). `period` names it ("2026-W41"):
    // the notification is recorded once per operator and period, and the e-mail goes only when it was
    // newly recorded, so a restart in the same week does not send it again. Returns whether it was sent.
    async tellOperatorOnce(kind: string, period: string, title: string, body: string): Promise<boolean> {
        if (this.sentOnce.has(`${kind}:${period}`)) return false;
        const admins = await this.notifications.admins().catch(() => []);
        let fresh = admins.length === 0;
        for (const userId of admins) {
            const made = await this.notifications
                .add({
                    userId,
                    tenantId: null,
                    kind,
                    title,
                    body: body.slice(0, 1500),
                    link: "/admin/reports",
                    dedupe: `${kind}:${period}`,
                })
                .catch(() => null);
            if (made) fresh = true;
        }
        this.sentOnce.add(`${kind}:${period}`);
        if (!fresh) return false;
        if (this.mailer && this.operatorEmail)
            await this.mailer
                .send({
                    to: this.operatorEmail,
                    subject: `Atelier: ${title}`,
                    text: `${body}\n\n${this.origin}/admin/reports\n`,
                    html: mailHtml({
                        title,
                        body,
                        action: { href: `${this.origin}/admin/reports`, label: "Open the reports" },
                        foot: "Sent to whoever runs this Atelier.",
                        origin: this.origin,
                    }),
                })
                .catch((err: Error) => console.warn(`could not e-mail the operator: ${err.message}`));
        return true;
    }

    // Whoever runs this Atelier: a problem on the platform's side, not a studio's.
    async tellOperator(kind: string, title: string, body: string): Promise<void> {
        // Where to go and look: reports have their own page.
        const link = kind.startsWith("feedback.") ? "/admin/reports" : "/admin";
        const admins = await this.notifications.admins().catch((err: Error) => {
            console.warn(`could not find the operators to notify (${kind}): ${err?.message ?? err}`);
            return [];
        });
        const hour = new Date().toISOString().slice(0, 13);
        for (const userId of admins) {
            await this.notifications
                .add({ userId, tenantId: null, kind, title, body, link, dedupe: `${kind}:${hour}` })
                .catch((err: Error) => console.warn(`could not notify operator: ${err.message}`));
        }
        const last = this.lastOperatorMail.get(kind) ?? 0;
        if (!this.mailer || !this.operatorEmail || Date.now() - last < 30 * 60_000) return;
        this.lastOperatorMail.set(kind, Date.now());
        await this.mailer
            .send({
                to: this.operatorEmail,
                subject: `Atelier: ${title}`,
                text: `${body}\n\n${this.origin}${link}\n`,
                html: mailHtml({
                    title,
                    body,
                    action: { href: `${this.origin}${link}`, label: link === "/admin" ? "Open the operator pages" : "Open the reports" },
                    foot: "Sent to whoever runs this Atelier.",
                    origin: this.origin,
                }),
            })
            .catch((err: Error) => {
                console.warn(`could not e-mail the operator: ${err.message}`);
                // A mail that did not go has not told anyone: try again after five minutes, not thirty.
                this.lastOperatorMail.set(kind, Date.now() - 25 * 60_000);
            });
    }

    private letter(notice: NoticeInput): string {
        const where = notice.link ? `\n\nOpen it: ${this.origin}${notice.link}` : "";
        return `${notice.body}${where}\n\n—\nAtelier. ${STOP}\n`;
    }
}
