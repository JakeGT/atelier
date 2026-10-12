import { ArrowLeft, Check, Monitor, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Template } from "../lib/api";
import { Dialog } from "./kit";

// Starting points for a new website, each shown as it really looks: a live,
// scaled-down copy of the template itself (not a picture of it), which can be
// opened larger at desktop and phone width before it is chosen.

function Thumb({ template }: { template: Template }) {
    return (
        <span className="gallery-thumb" aria-hidden="true">
            {template.previewUrl ? (
                // Looked at, not used: no scripts, and it takes no clicks.
                <iframe src={template.previewUrl} title={`${template.name}, shown small`} sandbox="" loading="lazy" tabIndex={-1} />
            ) : (
                <span className="gallery-blank">An empty page</span>
            )}
        </span>
    );
}

export function Gallery({
    templates,
    chosen,
    mayManage,
    onChoose,
    onRemove,
    onClose,
}: {
    templates: Template[];
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
            <Dialog onClose={onClose} wide>
                <div className="gallery-look-head">
                    <button type="button" className="btn btn-sm" onClick={() => setLooking(null)}>
                        <ArrowLeft /> All starting points
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
                    <iframe src={looking.previewUrl} title={`The ${looking.name} template`} sandbox="" />
                </div>
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
        <Dialog onClose={onClose} wide>
            <h2 className="display">Choose a starting point</h2>
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
