import { ArrowLeft, Check, Monitor, Smartphone, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Template } from "../lib/api";
import { Dialog, Dots } from "./kit";

// Starting points for a new website. Atelier's own are shown as pictures taken ahead
// of time, so the gallery is there at once; a studio's own templates, which have no
// picture, as a live scaled-down copy. "Look closer" opens the real page, live, at
// desktop and phone width.

function Thumb({ template }: { template: Template }) {
    return (
        <span className="gallery-thumb" aria-hidden="true">
            {template.imageUrl ? (
                // A picture taken ahead of time: there at once. The live page is one step away, in "Look closer".
                <img src={template.imageUrl} alt="" loading="lazy" />
            ) : template.previewUrl ? (
                // Looked at, not used: no scripts, and it takes no clicks.
                <iframe src={template.previewUrl} title={`${template.name}, shown small`} sandbox="" loading="lazy" tabIndex={-1} />
            ) : (
                <span className="gallery-blank">An empty page</span>
            )}
        </span>
    );
}

const DESKTOP = 1280;

// One design, live, at the size it would really be. A desktop is 1280 wide: where the window is
// narrower than that, the page is still laid out at 1280 and shown smaller, so "Desktop" never
// turns into the phone layout. Its picture stands in until the live page has arrived.
export function Closer({ src, picture, name, phone }: { src: string; picture?: string; name: string; phone: boolean }) {
    const box = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
        measure();
        const watch = new ResizeObserver(measure);
        watch.observe(el);
        return () => watch.disconnect();
    }, []);
    // biome-ignore lint/correctness/useExhaustiveDependencies: a different page has not arrived yet
    useEffect(() => setLoaded(false), [src]);
    // On a phone there is no room to show a desktop usefully: the page is shown as the phone would lay it out.
    const narrow = size.width > 0 && size.width < 600;
    const asIs = phone || narrow || size.width === 0;
    const scale = asIs ? 1 : Math.min(1, size.width / DESKTOP);
    return (
        <div className={`gallery-look ${phone ? "gallery-look-phone" : ""}`} ref={box}>
            {!loaded && (
                <div className="gallery-look-wait" aria-live="polite">
                    {picture && !phone && !narrow && <img src={picture} alt="" />}
                    <span className="chip">
                        <Dots /> Loading the live page…
                    </span>
                </div>
            )}
            <iframe
                src={src}
                title={`${name}, live`}
                sandbox=""
                onLoad={() => setLoaded(true)}
                style={
                    asIs
                        ? undefined
                        : { width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "top left" }
                }
            />
        </div>
    );
}

export function Gallery({
    templates,
    looks,
    chosen,
    mayManage,
    onChoose,
    onRemove,
    onClose,
}: {
    templates: Template[];
    // Looks an empty website can start in ("look:<id>").
    looks: Template[];
    chosen: string | null;
    mayManage: boolean;
    onChoose: (id: string | null) => void;
    onRemove: (template: Template) => void;
    onClose: () => void;
}) {
    const [looking, setLooking] = useState<Template | null>(null);
    const [phone, setPhone] = useState(false);
    const blank: Template = {
        id: "",
        name: "An empty page",
        description: "Nothing yet: your assistant builds the first page from what you describe.",
    };
    const own = templates.filter((t) => t.own);
    const builtIn = templates.filter((t) => !t.own);

    if (looking) {
        return (
            <Dialog onClose={onClose} large>
                <div className="gallery-look-head">
                    <button type="button" className="btn btn-sm" onClick={() => setLooking(null)}>
                        <ArrowLeft /> All designs and templates
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
                <Closer src={looking.previewUrl ?? ""} picture={looking.imageUrl} name={looking.name} phone={phone} />
                <div className="dialog-actions">
                    <button type="button" className="btn" onClick={() => setLooking(null)}>
                        Back
                    </button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                            onChoose(looking.id);
                            onClose();
                        }}
                    >
                        <Check /> Start from this
                    </button>
                </div>
            </Dialog>
        );
    }

    const card = (t: Template) => {
        const id = t.id || null;
        return (
            <li key={t.id || "blank"} className={chosen === id ? "on" : ""}>
                <Thumb template={t} />
                <strong>
                    {t.name}
                    {chosen === id && <span className="chip chip-seal">Chosen</span>}
                </strong>
                <span className="muted">{t.description}</span>
                <span className="gallery-actions">
                    <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                            onChoose(id);
                            onClose();
                        }}
                    >
                        Start from this
                    </button>
                    {t.previewUrl && (
                        <button type="button" className="btn btn-sm" onClick={() => setLooking(t)}>
                            Look closer
                        </button>
                    )}
                    {t.own && mayManage && (
                        <button type="button" className="btn btn-sm" onClick={() => onRemove(t)}>
                            <Trash2 /> Remove
                        </button>
                    )}
                </span>
            </li>
        );
    };

    return (
        <Dialog onClose={onClose} large>
            <h2 className="display">Designs and templates</h2>
            <p className="muted">
                A new website can begin empty, or as one of these: a small finished website that is there the moment you open it, for your
                assistant to make yours.
            </p>
            {own.length > 0 && (
                <>
                    <p className="eyebrow gallery-group">From this studio</p>
                    <ul className="gallery">{own.map(card)}</ul>
                    <p className="eyebrow gallery-group">From Atelier</p>
                </>
            )}
            {looks.length > 0 && (
                <>
                    <p className="eyebrow gallery-group">Start simply, in a look</p>
                    <p className="muted">
                        A first page in a finished design: colours, lettering and spacing chosen for you. You can change the look at any
                        time without losing a word.
                    </p>
                    <ul className="gallery">{looks.map(card)}</ul>
                    <p className="eyebrow gallery-group">Or start from a finished website</p>
                </>
            )}
            <ul className="gallery">{[blank, ...builtIn].map(card)}</ul>
            <p className="field-help">To add your own: on a website's card, choose More, then “Save as a template”.</p>
            <div className="dialog-actions">
                <button type="button" className="btn" onClick={onClose}>
                    Close
                </button>
            </div>
        </Dialog>
    );
}
