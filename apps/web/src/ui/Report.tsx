import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Dialog, Dots, useToast } from "./kit";

const OPEN = "atelier:report";

// Opens the report dialog from anywhere (the account menu, beside an error).
// `about`: words to start it with, such as the error that was just shown.
export function reportProblem(about?: string): void {
    window.dispatchEvent(new CustomEvent(OPEN, { detail: about ?? "" }));
}

// Mounted once. A report goes to whoever runs this Atelier, with the page the
// person was on, so they do not have to describe where they were.
export function ReportHost() {
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<"problem" | "idea">("problem");
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    useEffect(() => {
        const show = (e: Event) => {
            const about = (e as CustomEvent<string>).detail;
            setKind("problem");
            setText(about ? `${about}\n\nWhat I was doing: ` : "");
            setOpen(true);
        };
        window.addEventListener(OPEN, show);
        return () => window.removeEventListener(OPEN, show);
    }, []);
    if (!open) return null;

    const send = async (e: FormEvent) => {
        e.preventDefault();
        setSending(true);
        const where = /^\/o\/([^/]+)(?:\/p\/([^/]+))?/.exec(window.location.pathname);
        try {
            await api.report({
                kind,
                text,
                page: window.location.pathname,
                org: where?.[1],
                project: where?.[2],
                screen: `${window.innerWidth}x${window.innerHeight}`,
                build: document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.src.split("/").pop(),
            });
            setOpen(false);
            toast("Sent. Thank you: it goes straight to the people who run Atelier.");
        } catch (err) {
            toast((err as Error).message, "error");
        } finally {
            setSending(false);
        }
    };

    return (
        <Dialog onClose={() => setOpen(false)}>
            <h2 className="display">Tell us about it</h2>
            <p className="muted">
                This goes to the people who run Atelier. The page you are on, your browser and your name are sent with it, so you do not
                have to describe where you were. Nothing from inside your website is sent.
            </p>
            <form className="report" onSubmit={send}>
                <div className="report-kinds" role="radiogroup" aria-label="What kind of report">
                    <label className={kind === "problem" ? "on" : ""}>
                        <input type="radio" name="report-kind" checked={kind === "problem"} onChange={() => setKind("problem")} />
                        Something is wrong
                    </label>
                    <label className={kind === "idea" ? "on" : ""}>
                        <input type="radio" name="report-kind" checked={kind === "idea"} onChange={() => setKind("idea")} />I have an idea
                    </label>
                </div>
                <label className="field">
                    <span>
                        {kind === "problem" ? "What happened, and what did you expect?" : "What would make Atelier better for you?"}
                    </span>
                    <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={4000} required autoFocus />
                </label>
                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={() => setOpen(false)}>
                        Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={sending || text.trim().length < 3}>
                        {sending ? <Dots /> : "Send report"}
                    </button>
                </div>
            </form>
        </Dialog>
    );
}
