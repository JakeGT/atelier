import { ExternalLink, Monitor, RotateCw, Smartphone, Tablet } from "lucide-react";
import { Dots } from "../ui/kit";

export type Device = "desktop" | "tablet" | "phone";

const DEVICES: { id: Device; label: string; icon: typeof Monitor }[] = [
    { id: "desktop", label: "Desktop", icon: Monitor },
    { id: "tablet", label: "Tablet", icon: Tablet },
    { id: "phone", label: "Phone", icon: Smartphone },
];

interface PreviewProps {
    slug: string;
    url: string | null;
    reloadKey: number;
    device: Device;
    onDevice: (d: Device) => void;
    onReload: () => void;
    hasPage: boolean;
    working: boolean;
}

export function Preview({ slug, url, reloadKey, device, onDevice, onReload, hasPage, working }: PreviewProps) {
    return (
        <section className="bench">
            <div className={`frame frame-${device}`}>
                <div className="frame-chrome">
                    <div className="frame-lights" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                    </div>
                    <div className="frame-address mono">
                        <span>{slug}</span>
                        <span className="muted"> · preview</span>
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
                        <button type="button" className="btn btn-ghost btn-sm" onClick={onReload} title="Reload the preview">
                            <RotateCw /> <span className="tool-label">Reload</span>
                        </button>
                        {url && hasPage && (
                            <a
                                className="btn btn-ghost btn-sm"
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                title="Open the preview in a new tab"
                            >
                                <ExternalLink /> <span className="tool-label">Open</span>
                            </a>
                        )}
                    </div>
                </div>

                <div className="frame-view">
                    {hasPage && url ? (
                        // Agent-written pages: sandboxed (no same-origin), so they can't act as the signed-in user.
                        <iframe
                            key={reloadKey}
                            src={url}
                            title="Website preview"
                            sandbox="allow-scripts allow-forms allow-popups allow-modals"
                        />
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
