import { ArrowLeft, Check, LayoutPanelTop, Monitor, Palette, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesignLayout, DesignLook, OrgApi, Project } from "../lib/api";
import { Dialog, Dots, useToast } from "../ui/kit";

// The website's design: the look it wears (a whole design language, changed in
// one step) and the ready-made sections its pages can be built from. Every
// choice is shown as it really looks: your own website in each look, and each
// section in the look you have.

function Thumb({ src, title }: { src: string; title: string }) {
    return (
        <span className="gallery-thumb" aria-hidden="true">
            <iframe src={src} title={title} sandbox="" loading="lazy" tabIndex={-1} />
        </span>
    );
}

const PLACE: Record<DesignLayout["place"], string> = { top: "Top of a page", body: "Anywhere on a page", bottom: "Bottom of a page" };

export function DesignDialog({
    api,
    project,
    canEdit,
    onAsk,
    onChanged,
    onClose,
}: {
    api: OrgApi;
    project: Project;
    canEdit: boolean;
    // Puts a request in the message box for the person to read and send.
    onAsk: (request: string) => void;
    // The look was changed: the preview and the history are out of date.
    onChanged: () => void;
    onClose: () => void;
}) {
    const toast = useToast();
    const [tab, setTab] = useState<"looks" | "sections">("looks");
    const [current, setCurrent] = useState<string | null>(null);
    const [looks, setLooks] = useState<DesignLook[] | null>(null);
    const [layouts, setLayouts] = useState<DesignLayout[] | null>(null);
    const [looking, setLooking] = useState<{
        name: string;
        description: string;
        src: string;
        look?: DesignLook;
        layout?: DesignLayout;
    } | null>(null);
    const [phone, setPhone] = useState(false);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const own = await api.projectDesign(project.id).catch(() => null);
        setCurrent(own?.look ?? null);
        setLooks(own?.looks ?? []);
        setLayouts((await api.design(own?.look ?? undefined).catch(() => null))?.layouts ?? []);
    }, [api, project.id]);
    useEffect(() => {
        void load();
    }, [load]);

    const hasKit = current !== null;
    const wear = async (look: DesignLook) => {
        if (!hasKit) {
            onAsk(
                `Restyle this whole website in the “${look.name}” look: give it that look with your design tools, link theme.css and kit.css from every page, and replace the pages' own colours and fonts with the look's values. Keep every word and every page.`,
            );
            onClose();
            return;
        }
        setBusy(true);
        try {
            await api.setLook(project.id, look.id);
            toast(`The website now wears the ${look.name} look. It is saved as a version, so you can go back.`);
            setLooking(null);
            onChanged();
            await load();
        } catch (err) {
            toast((err as Error).message, "error");
        } finally {
            setBusy(false);
        }
    };
    const add = (layout: DesignLayout) => {
        onAsk(`Add the “${layout.name}” section to the home page, in the place that suits it best, with wording written for this website.`);
        onClose();
    };

    if (looking) {
        return (
            <Dialog onClose={onClose} wide>
                <div className="gallery-look-head">
                    <button type="button" className="btn btn-sm" onClick={() => setLooking(null)}>
                        <ArrowLeft /> {looking.look ? "All looks" : "All sections"}
                    </button>
                    <div className="segmented" role="radiogroup" aria-label="Preview size">
                        {/* biome-ignore lint/a11y/useSemanticElements: a button group styled as a segmented control */}
                        <button
                            type="button"
                            role="radio"
                            aria-checked={!phone}
                            className={phone ? "" : "on"}
                            onClick={() => setPhone(false)}
                        >
                            <Monitor /> Desktop
                        </button>
                        {/* biome-ignore lint/a11y/useSemanticElements: a button group styled as a segmented control */}
                        <button
                            type="button"
                            role="radio"
                            aria-checked={phone}
                            className={phone ? "on" : ""}
                            onClick={() => setPhone(true)}
                        >
                            <Smartphone /> Phone
                        </button>
                    </div>
                </div>
                <h2 className="display">{looking.name}</h2>
                <p className="muted">{looking.description}</p>
                <div className={`gallery-look ${phone ? "gallery-look-phone" : ""}`}>
                    <iframe src={looking.src} title={looking.name} sandbox="" />
                </div>
                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={() => setLooking(null)}>
                        Back
                    </button>
                    {canEdit && looking.look && looking.look.id !== current && (
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy}
                            onClick={() => looking.look && void wear(looking.look)}
                        >
                            {busy ? <Dots /> : hasKit ? "Use this look" : "Ask my assistant to restyle the website like this"}
                        </button>
                    )}
                    {canEdit && looking.layout && (
                        <button type="button" className="btn btn-primary" onClick={() => looking.layout && add(looking.layout)}>
                            Ask my assistant to add this
                        </button>
                    )}
                </div>
            </Dialog>
        );
    }

    return (
        <Dialog onClose={onClose} wide>
            <p className="eyebrow">{project.name}</p>
            <h2 className="display">Design</h2>
            <div className="tabs design-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "looks"}
                    className={tab === "looks" ? "on" : ""}
                    onClick={() => setTab("looks")}
                >
                    <Palette /> Looks
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "sections"}
                    className={tab === "sections" ? "on" : ""}
                    onClick={() => setTab("sections")}
                >
                    <LayoutPanelTop /> Sections
                </button>
            </div>

            {tab === "looks" ? (
                looks === null ? (
                    <Dots />
                ) : (
                    <>
                        <p className="muted design-about">
                            {hasKit
                                ? "A look is a whole design: colours, lettering, corners and spacing. Each picture below is your own website in that look. Changing it changes every page at once and none of your words."
                                : "A look is a whole design: colours, lettering, corners and spacing. This website was built with its own styling, so its look cannot be switched in one step; your assistant can restyle it in any of these."}
                        </p>
                        <ul className="gallery">
                            {looks.map((l) => (
                                <li key={l.id} className={l.id === current ? "on" : ""}>
                                    <Thumb src={l.previewUrl} title={`${l.name}, shown small`} />
                                    <strong>
                                        {l.name}
                                        {l.id === current && <span className="chip chip-seal">Wearing now</span>}
                                    </strong>
                                    <span className="muted">{l.description}</span>
                                    <span className="gallery-actions">
                                        {canEdit && l.id !== current && (
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-primary"
                                                disabled={busy}
                                                onClick={() => void wear(l)}
                                            >
                                                {hasKit ? (
                                                    <>
                                                        <Check /> Use this look
                                                    </>
                                                ) : (
                                                    "Ask my assistant to restyle it"
                                                )}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className="btn btn-sm"
                                            onClick={() =>
                                                setLooking({ name: l.name, description: l.description, src: l.previewUrl, look: l })
                                            }
                                        >
                                            Look closer
                                        </button>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </>
                )
            ) : layouts === null ? (
                <Dots />
            ) : (
                <>
                    <p className="muted design-about">
                        Ready-made parts of a page, shown in {hasKit ? "your website's look" : "a sample look"}. Your assistant places one,
                        writes its words for your website, and every word in it can be edited afterwards.
                    </p>
                    <ul className="gallery">
                        {layouts.map((l) => (
                            <li key={l.id}>
                                <Thumb src={l.previewUrl} title={`${l.name}, shown small`} />
                                <strong>{l.name}</strong>
                                <span className="muted">{l.description}</span>
                                <span className="mono muted design-place">{PLACE[l.place]}</span>
                                <span className="gallery-actions">
                                    {canEdit && (
                                        <button type="button" className="btn btn-sm btn-primary" onClick={() => add(l)}>
                                            Ask my assistant to add this
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="btn btn-sm"
                                        onClick={() =>
                                            setLooking({ name: l.name, description: l.description, src: l.previewUrl, layout: l })
                                        }
                                    >
                                        Look closer
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            <div className="dialog-actions">
                <button type="button" className="btn" onClick={onClose}>
                    Close
                </button>
            </div>
        </Dialog>
    );
}
