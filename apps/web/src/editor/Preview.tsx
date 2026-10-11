import { ArrowLeft, ArrowRight, ExternalLink, Monitor, PencilLine, RotateCw, Smartphone, Tablet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { plainFile } from "../lib/activity";
import { Dots } from "../ui/kit";

export type Device = "desktop" | "tablet" | "phone";

const DEVICES: { id: Device; label: string; icon: typeof Monitor }[] = [
    { id: "desktop", label: "Desktop", icon: Monitor },
    { id: "tablet", label: "Tablet", icon: Tablet },
    { id: "phone", label: "Phone", icon: Smartphone },
];

interface PreviewProps {
    url: string | null;
    reloadKey: number;
    device: Device;
    onDevice: (d: Device) => void;
    onReload: () => void;
    hasPage: boolean;
    // The website is still being opened (its workspace is starting): not known yet whether it has pages.
    opening?: boolean;
    working: boolean;
    // Whether this person may change wording (then the preview offers "Edit text").
    canEdit: boolean;
    // Text typed into a bound element of the page: its reference ("page/home#headline") and new value.
    onWording: (ref: string, value: string) => void;
    // A bound element that cannot be typed into in place (formatted text, a list) was clicked.
    onOpenWording: (ref: string) => void;
}

// Where the person has been inside the preview, so Back and Forward know whether
// they have anywhere to go. The preview is sandboxed and the editor cannot look
// inside it; each page says where it is (the server adds a few lines for that),
// and this keeps the trail.
interface Trail {
    pages: string[];
    at: number;
}

const HOME = "index.html";
const REF = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}#[A-Za-z][\w-]{0,63}$/;
// What a page says about itself is untrusted: only a plausible relative path is kept.
const safePath = (v: unknown): string | null =>
    typeof v === "string" && v.length < 300 && !v.includes("..") && /^[\w\-./%~ ]+$/.test(v) ? v : null;

export function Preview({
    url,
    reloadKey,
    device,
    onDevice,
    onReload,
    hasPage,
    opening,
    working,
    canEdit,
    onWording,
    onOpenWording,
}: PreviewProps) {
    const frame = useRef<HTMLIFrameElement>(null);
    const [trail, setTrail] = useState<Trail>({ pages: [HOME], at: 0 });
    // Set when Back or Forward was pressed: the next page to report is a move along the trail, not a new visit.
    const moving = useRef<"back" | "forward" | null>(null);
    // The page a reload should come back to (reloading must not send the person home).
    const [start, setStart] = useState(HOME);
    const current = trail.pages[trail.at] ?? HOME;
    const currentRef = useRef(current);
    currentRef.current = current;
    // "Edit text": the page outlines what can be edited; text is typed in place.
    const [editing, setEditing] = useState(false);
    const editingRef = useRef(editing);
    editingRef.current = editing;
    const handlers = useRef({ onWording, onOpenWording });
    handlers.current = { onWording, onOpenWording };
    const tell = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ atelierPreview: 1, ...message }, "*");
    const toggleEditing = () => {
        setEditing((on) => {
            tell({ edit: !on });
            return !on;
        });
    };

    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            if (e.source !== frame.current?.contentWindow) return;
            const data = e.data as { atelierPreview?: unknown; path?: unknown; change?: unknown; open?: unknown } | null;
            if (data?.atelierPreview !== 1) return;
            // What the page says is untrusted: a reference of the right shape and a short string, or nothing.
            const change = data.change as { ref?: unknown; value?: unknown } | undefined;
            if (
                change &&
                typeof change.ref === "string" &&
                REF.test(change.ref) &&
                typeof change.value === "string" &&
                change.value.length <= 5000
            ) {
                if (editingRef.current) handlers.current.onWording(change.ref, change.value);
                return;
            }
            if (typeof data.open === "string" && REF.test(data.open)) {
                if (editingRef.current) handlers.current.onOpenWording(data.open);
                return;
            }
            const path = safePath(data.path);
            if (!path) return;
            // Each page that arrives is told whether text is being edited.
            if (editingRef.current) frame.current?.contentWindow?.postMessage({ atelierPreview: 1, edit: true }, "*");
            const move = moving.current;
            moving.current = null;
            setTrail((t) => {
                if (move === "back") return { ...t, at: Math.max(0, t.at - 1) };
                if (move === "forward") return { ...t, at: Math.min(t.pages.length - 1, t.at + 1) };
                if (t.pages[t.at] === path) return t;
                return { pages: [...t.pages.slice(0, t.at + 1), path], at: t.at + 1 };
            });
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);

    // A reload starts the frame again: at the page that was showing, with a fresh trail.
    // biome-ignore lint/correctness/useExhaustiveDependencies: only when a reload is asked for or the preview address changes
    useEffect(() => {
        const page = currentRef.current;
        setStart(page);
        setTrail({ pages: [page], at: 0 });
        moving.current = null;
    }, [reloadKey, url]);

    const go = (direction: "back" | "forward") => {
        moving.current = direction;
        tell({ go: direction });
        // If the page never answers (it has no bridge), forget the request.
        setTimeout(() => {
            if (moving.current === direction) moving.current = null;
        }, 1500);
    };

    const canBack = trail.at > 0;
    const canForward = trail.at < trail.pages.length - 1;
    const name = plainFile(current).replace(/^the /, "");
    const src = url ? `${url}${start === HOME ? "" : start}` : null;

    return (
        <section className="bench">
            {/* The tools sit above the frame, not inside it: they keep the full width
                whichever size is being previewed, so the way back to Desktop is always there. */}
            <div className="frame-chrome">
                <div className="frame-nav">
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => go("back")}
                        disabled={!canBack || !hasPage}
                        title="Go back to the page you were on before"
                    >
                        <ArrowLeft /> <span className="tool-label">Back</span>
                    </button>
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => go("forward")}
                        disabled={!canForward || !hasPage}
                        title="Go forward again"
                    >
                        <span className="tool-label">Forward</span> <ArrowRight />
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={onReload} title="Reload the preview">
                        <RotateCw /> <span className="tool-label">Reload</span>
                    </button>
                    {url && hasPage && (
                        <a
                            className="btn btn-ghost btn-sm"
                            href={`${url}${current === HOME ? "" : current}`}
                            target="_blank"
                            rel="noreferrer"
                            title="Open this page of the preview in a new tab"
                        >
                            <ExternalLink /> <span className="tool-label">Open</span>
                        </a>
                    )}
                </div>
                <div className="frame-address mono">
                    <span>Preview</span>
                    <span className="muted"> · {hasPage ? name.charAt(0).toUpperCase() + name.slice(1) : "private"}</span>
                </div>
                <div className="frame-tools">
                    <div className="segmented" role="radiogroup" aria-label="Preview size">
                        {DEVICES.map((d) => (
                            // biome-ignore lint/a11y/useSemanticElements: a button group styled as a segmented control
                            <button
                                key={d.id}
                                type="button"
                                role="radio"
                                aria-checked={device === d.id}
                                title={d.label}
                                className={device === d.id ? "on" : ""}
                                onClick={() => onDevice(d.id)}
                            >
                                <d.icon /> <span className="tool-label">{d.label}</span>
                            </button>
                        ))}
                    </div>
                    {canEdit && hasPage && (
                        <button
                            type="button"
                            className={`btn btn-sm ${editing ? "btn-primary" : "btn-ghost"}`}
                            onClick={toggleEditing}
                            aria-pressed={editing}
                            title="Click a piece of text in the page and type to change it"
                        >
                            <PencilLine /> <span className="tool-label">{editing ? "Done editing" : "Edit text"}</span>
                        </button>
                    )}
                </div>
            </div>

            <div className={`frame frame-${device}`}>
                <div className="frame-view">
                    {hasPage && src ? (
                        // Agent-written pages: sandboxed (no same-origin), so they can't act as the signed-in user.
                        <iframe
                            ref={frame}
                            key={`${reloadKey}:${start}`}
                            src={src}
                            title="Website preview"
                            sandbox="allow-scripts allow-forms allow-popups allow-modals"
                        />
                    ) : opening ? (
                        <div className="frame-empty" aria-live="polite">
                            <Dots />
                            <h3 className="display">Opening your website…</h3>
                            <p className="muted">Its workspace is starting. This can take a little while after an update.</p>
                        </div>
                    ) : (
                        <div className="frame-empty">
                            <svg viewBox="0 0 120 120" aria-hidden="true">
                                <path d="M34 104 52 18M86 104 68 18M60 18v86" />
                                <rect x="26" y="34" width="68" height="46" rx="3" />
                                <path d="M22 84h76" />
                            </svg>
                            <h3 className="display">Nothing on the easel yet.</h3>
                            <p className="muted">Ask your assistant for a first page and it will appear here.</p>
                        </div>
                    )}
                    {editing && (
                        <div className="frame-editing">
                            Click any outlined text and type. Press Enter or click away to save it; Esc to leave it as it was.
                        </div>
                    )}
                    {working && (
                        <div className="frame-working">
                            <Dots /> Your assistant is working
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}
