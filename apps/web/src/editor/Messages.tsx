import { Download, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormMessage } from "../lib/api";
import { orgApi } from "../lib/api";
import { timeAgo } from "../lib/hooks";
import { Dots, useToast } from "../ui/kit";

// "email" -> "Email"; "your_name" -> "Your name".
const label = (key: string): string => {
    const words = key.replace(/[-_]+/g, " ").trim();
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};
const formName = (form: string): string => `${label(form)} form`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What visitors sent through the website's forms, newest first. Opening the
// list is reading it: anything new is marked as seen.
export function Messages({ org, projectId, canEdit, onSeen }: { org: string; projectId: string; canEdit: boolean; onSeen: () => void }) {
    const toast = useToast();
    const [messages, setMessages] = useState<FormMessage[] | null>(null);
    const [asking, setAsking] = useState<string | null>(null);

    const load = useCallback(async () => {
        const a = orgApi(org);
        try {
            const box = await a.listMessages(projectId);
            setMessages(box.messages);
            if (box.unread > 0 && canEdit) await a.readMessages(projectId).then(onSeen);
        } catch {
            setMessages([]);
        }
    }, [org, projectId, canEdit, onSeen]);
    useEffect(() => {
        void load();
    }, [load]);

    const remove = async (id: string) => {
        try {
            await orgApi(org).removeMessage(projectId, id);
            setMessages((list) => (list ?? []).filter((m) => m.id !== id));
            setAsking(null);
        } catch (err) {
            toast((err as Error).message, "error");
        }
    };

    if (messages === null) {
        return (
            <div className="panel-loading">
                <Dots />
            </div>
        );
    }
    if (messages.length === 0) {
        return (
            <div className="content-empty">
                <h2 className="display">No messages yet.</h2>
                <p className="muted">
                    When a visitor fills in a form on this website (a contact form, a sign-up box), what they wrote arrives here, and you
                    are told by e-mail. No form on the website yet? In the editor, ask your assistant: "Add a contact form."
                </p>
            </div>
        );
    }
    const real = messages.filter((m) => !m.preview).length;
    return (
        <div className="messages">
            <div className="messages-head">
                <p className="muted">
                    {real === 0
                        ? "Nothing from visitors yet: what is below was sent from the preview, to try the form out."
                        : `${real === 1 ? "1 message" : `${real} messages`} from visitors, newest first. Messages are kept for a year.`}
                </p>
                {real > 0 && (
                    <a className="btn btn-sm" href={orgApi(org).messagesCsvUrl(projectId)} download>
                        <Download /> Download all as a spreadsheet
                    </a>
                )}
            </div>
            <ul className="messages-list">
                {messages.map((m) => (
                    <li key={m.id} className={`message ${m.readAt ? "" : "message-new"}`}>
                        <div className="message-head">
                            <strong>{formName(m.form)}</strong>
                            {!m.readAt && <span className="chip chip-draft">New</span>}
                            {m.preview && <span className="chip">Sent from the preview, as a trial</span>}
                            <span className="muted" title={new Date(m.createdAt).toLocaleString()}>
                                {timeAgo(m.createdAt)}
                            </span>
                        </div>
                        <dl className="message-body">
                            {Object.entries(m.data).map(([key, value]) => (
                                <div key={key}>
                                    <dt className="muted">{label(key)}</dt>
                                    <dd>{EMAIL.test(value) ? <a href={`mailto:${value}`}>{value}</a> : value}</dd>
                                </div>
                            ))}
                        </dl>
                        {canEdit &&
                            (asking === m.id ? (
                                <div className="message-foot">
                                    <span>Delete this message for good? It cannot be brought back.</span>
                                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(m.id)}>
                                        Yes, delete it
                                    </button>
                                    <button type="button" className="btn btn-sm" onClick={() => setAsking(null)}>
                                        Keep it
                                    </button>
                                </div>
                            ) : (
                                <div className="message-foot">
                                    <button type="button" className="btn btn-sm" onClick={() => setAsking(m.id)}>
                                        <Trash2 /> Delete this message
                                    </button>
                                </div>
                            ))}
                    </li>
                ))}
            </ul>
        </div>
    );
}
