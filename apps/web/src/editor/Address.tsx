import { Check, CloudOff, Copy, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { HostedDomain, Hosting, OrgApi, Project } from "../lib/api";
import { ReauthRequired, reauthenticate } from "../lib/api";
import { Dialog, Dots, useToast } from "../ui/kit";

interface Props {
    project: Project;
    api: OrgApi;
    // Owners and admins add and remove domains; everyone else can look.
    mayManage: boolean;
    // Shown the option to take the website offline.
    canPublish: boolean;
    // Open on the "take offline?" confirmation (the person chose Unpublish elsewhere).
    startUnpublish?: boolean;
    // The website was taken offline.
    onUnpublished: () => void;
    onClose: () => void;
}

const STATUS: Record<string, { label: string; chip: string }> = {
    active: { label: "Connected", chip: "chip-live" },
    pending: { label: "Waiting for DNS", chip: "chip-draft" },
    initializing: { label: "Waiting for DNS", chip: "chip-draft" },
    unknown: { label: "Status unavailable", chip: "chip-plain" },
};

// The name in an address ("example.com"), or the address as it is if it cannot be read as one.
const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};

// Where the website lives: its address, and the owner's own domains.
export function Address({ project, api, mayManage, canPublish, startUnpublish = false, onUnpublished, onClose }: Props) {
    const toast = useToast();
    const [hosting, setHosting] = useState<Hosting | null>(null);
    const [hostname, setHostname] = useState("");
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [confirmOffline, setConfirmOffline] = useState(startUnpublish);

    const load = useCallback(async () => {
        try {
            setHosting(await api.hosting(project.id));
        } catch (err) {
            toast((err as Error).message, "error");
        }
    }, [api, project.id, toast]);
    useEffect(() => {
        void load();
    }, [load]);

    // Adding or removing a domain changes where the world finds the website, so it may ask for a fresh sign-in.
    const fail = (err: unknown) => {
        if (err instanceof ReauthRequired) {
            toast("Please confirm your sign-in, then try that again.", "error");
            setTimeout(reauthenticate, 1400);
        } else toast((err as Error).message, "error");
    };

    async function add(e: FormEvent) {
        e.preventDefault();
        if (!hostname.trim() || busy) return;
        setBusy(true);
        try {
            const added = await api.addDomain(project.id, hostname.trim());
            setHostname("");
            toast(`${added.hostname} added. Point its DNS record at the address shown, then check again.`);
            await load();
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    }

    async function check(d: HostedDomain) {
        setBusy(true);
        try {
            await api.checkDomain(project.id, d.hostname);
            await load();
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    }

    async function remove(d: HostedDomain) {
        if (busy) return;
        setBusy(true);
        try {
            await api.removeDomain(project.id, d.hostname);
            toast(`${d.hostname} is disconnected.`);
            await load();
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    }

    async function takeOffline() {
        setBusy(true);
        try {
            await api.unpublish(project.id);
            toast(`${project.name} is offline. Publish to bring it back.`);
            onUnpublished();
        } catch (err) {
            fail(err);
            setBusy(false);
        }
    }

    const copy = (text: string) => {
        // The browser can refuse (an old browser, or copying not allowed here): say so, not nothing.
        const refused = () => toast("That couldn't be copied from here. Select the address and copy it yourself.", "error");
        if (!navigator.clipboard) return refused();
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        }, refused);
    };

    return (
        <Dialog onClose={onClose} wide>
            <p className="eyebrow">Address</p>
            <h2>Where {project.name} lives</h2>
            {hosting === null ? (
                <div className="panel-loading">
                    <Dots />
                </div>
            ) : !hosting.enabled ? (
                <p>Hosting isn't set up on this server yet, so published versions are recorded but not served anywhere.</p>
            ) : !hosting.url ? (
                <p>This website doesn't have an address yet. Press Publish, and it will be live at one a few seconds later.</p>
            ) : (
                <>
                    <div className="address-line">
                        <a href={hosting.url} target="_blank" rel="noreferrer" className="mono">
                            {hostOf(hosting.url)} <ExternalLink />
                        </a>
                        <button type="button" className="btn btn-sm" onClick={() => copy(hosting.url ?? "")}>
                            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
                        </button>
                    </div>
                    {hosting.lastDeployment?.state === "failed" && (
                        <p className="address-warning">
                            The last publish didn't go through, so this still shows the version before it.
                            {hosting.lastDeployment.error
                                ? ` ${hosting.lastDeployment.error.charAt(0).toUpperCase()}${hosting.lastDeployment.error.slice(1)}.`
                                : ""}
                        </p>
                    )}

                    <h3 className="eyebrow address-head">Your own domain</h3>
                    {hosting.domains.length > 0 && (
                        <ul className="rows">
                            {hosting.domains.map((d) => {
                                const s = STATUS[d.status] ?? { label: d.status, chip: "chip-plain" };
                                return (
                                    <li key={d.hostname} className="domain-row">
                                        <span className="row-main">
                                            <strong>{d.hostname}</strong>
                                        </span>
                                        <span className="row-actions">
                                            <span className={`chip ${s.chip}`}>{s.label}</span>
                                            {mayManage && d.status !== "active" && (
                                                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void check(d)}>
                                                    <RefreshCw /> Check again
                                                </button>
                                            )}
                                            {mayManage && (
                                                <button
                                                    type="button"
                                                    className="btn btn-sm btn-danger"
                                                    disabled={busy}
                                                    onClick={() => void remove(d)}
                                                >
                                                    <Trash2 /> Remove
                                                </button>
                                            )}
                                        </span>
                                        {d.status === "active" ? (
                                            <span className="domain-help muted">
                                                Visitors and search engines are sent here after your next publish.
                                            </span>
                                        ) : (
                                            <span className="domain-help muted">
                                                At your domain provider, add a <span className="mono">CNAME</span> record for{" "}
                                                <span className="mono">{d.hostname}</span> pointing to{" "}
                                                <span className="mono">{hosting.target}</span>
                                                {d.error ? `. ${d.error}` : "."}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {mayManage ? (
                        <>
                            <form className="invite" onSubmit={add}>
                                <input
                                    value={hostname}
                                    onChange={(e) => setHostname(e.target.value)}
                                    placeholder="www.example.com"
                                    aria-label="Domain name"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                />
                                <button type="submit" className="btn btn-primary" disabled={!hostname.trim() || busy}>
                                    {busy ? <Dots /> : "Add domain"}
                                </button>
                            </form>
                            <p className="field-help">
                                Use a name like <span className="mono">www.example.com</span>. A bare name (
                                <span className="mono">example.com</span>) only works if your domain's DNS is managed by Cloudflare.
                                Certificates are issued and renewed for you.
                            </p>
                        </>
                    ) : (
                        hosting.domains.length === 0 && (
                            <p className="muted">No domain connected. An owner or admin of this studio can add one.</p>
                        )
                    )}
                </>
            )}
            {confirmOffline ? (
                <div className="offline-confirm">
                    <p>
                        <strong>Take {project.name} offline?</strong> Its address{hosting?.domains.length ? " and domains" : ""} will stop
                        working straight away. Your pages, versions and releases stay here, and Publish brings it back at the same address.
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="btn" onClick={() => setConfirmOffline(false)} disabled={busy}>
                            Keep it live
                        </button>
                        <button type="button" className="btn btn-danger-solid" onClick={() => void takeOffline()} disabled={busy}>
                            {busy ? <Dots /> : <CloudOff />} Take offline
                        </button>
                    </div>
                </div>
            ) : (
                <div className="dialog-actions dialog-actions-split">
                    {canPublish && hosting?.url ? (
                        <button type="button" className="btn btn-danger" onClick={() => setConfirmOffline(true)}>
                            <CloudOff /> Unpublish
                        </button>
                    ) : (
                        <span />
                    )}
                    <span>
                        <button type="button" className="btn" onClick={onClose}>
                            Close
                        </button>
                    </span>
                </div>
            )}
        </Dialog>
    );
}
