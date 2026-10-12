import { ArrowDown, ArrowUp, Bold, GripVertical, Italic, Link2, List, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ContentDocument, ContentField } from "../lib/api";
import { timeAgo } from "../lib/hooks";
import { Dialog, Dots, useToast } from "../ui/kit";
import { PictureField } from "./Media";

// Editing a piece of wording: proper fields with plain labels, in whichever place
// it is being edited (the pop-up from the editor, or the Content page). ADR-0014.
//
// Whatever shape the saved content has, a person sees fields: a line of text, a
// paragraph, a list, a group of related fields, a set of entries with parts.
// Content is stored as JSON because that suits the assistant; a person is never
// shown it or asked to write it.

// "heroTitle" / "hero_title" -> "Hero title"
export function plainLabel(key: string): string {
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// What a document is called: the page (or part of the website) it belongs to.
export function documentName(doc: Pick<ContentDocument, "kind" | "slug">): string {
    if (doc.slug === "shared") return "On every page";
    const name = plainLabel(doc.slug === "index" && doc.kind !== "page" ? doc.kind : doc.slug);
    if (doc.kind === "page") return `${name} page`;
    return doc.slug === "index" ? name : `${name} ${plainLabel(doc.kind).toLowerCase()}`;
}

// ---- what kind of field a value is ---------------------------------------------------------

type Kind = ContentField["type"] | "link" | "group" | "number" | "yesno";
export interface Shape {
    key: string;
    label: string;
    type: Kind;
    help?: string;
    required?: boolean;
    max?: number;
    // items: the parts of each entry. group: the fields inside it.
    parts?: Shape[];
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const MEDIA = /^media\/[a-z0-9][a-z0-9-]*\.(jpe?g|png|webp|avif|gif|svg)$/;
const LINK = /^(https?:\/\/|mailto:|tel:)\S+$|^[\w./-]+\.html?([#?]\S*)?$/;

// Worked out from a value, for content saved without a description of its fields.
export function shapeOf(key: string, value: unknown): Shape {
    const label = plainLabel(key);
    if (typeof value === "number") return { key, label, type: "number" };
    if (typeof value === "boolean") return { key, label, type: "yesno" };
    if (typeof value === "string") {
        if (MEDIA.test(value)) return { key, label, type: "image" };
        if (/^media\/[a-z0-9][a-z0-9-]*\.(mp4|webm)$/.test(value)) return { key, label, type: "video" };
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { key, label, type: "date" };
        if (LINK.test(value.trim())) return { key, label, type: "link" };
        if (/<(p|br|strong|em|b|i|ul|ol|li|a|h[2-4]|blockquote)[\s>/]/i.test(value)) return { key, label, type: "rich" };
        return { key, label, type: value.length > 90 || value.includes("\n") ? "long" : "text" };
    }
    if (Array.isArray(value)) {
        const entries = value.filter(isObject);
        if (entries.length === 0 || entries.length < value.length) return { key, label, type: "list" };
        // The parts are everything any entry has, in the order they first appear.
        const parts = new Map<string, Shape>();
        for (const entry of entries)
            for (const [k, v] of Object.entries(entry)) if (!parts.has(k) && v !== null && v !== undefined) parts.set(k, shapeOf(k, v));
        return { key, label, type: "items", parts: [...parts.values()] };
    }
    if (isObject(value)) return { key, label, type: "group", parts: Object.entries(value).map(([k, v]) => shapeOf(k, v)) };
    return { key, label, type: "text" };
}

const described = (f: ContentField): Shape => ({
    key: f.key,
    label: f.label,
    type: f.type,
    help: f.help,
    required: f.required,
    max: f.max,
    parts: f.itemFields?.map((p) => ({ key: p.key, label: p.label, type: p.type, help: p.help, required: p.required, max: p.max })),
});

// The fields to show: as the document describes them, then any value it does not
// describe (worked out from the value), so nothing saved is ever hidden.
export function fieldsOf(doc: Pick<ContentDocument, "draft" | "fields">): Shape[] {
    const draft = doc.draft ?? {};
    const known = (doc.fields ?? []).map((f) =>
        f.type === "items" && !f.itemFields
            ? { ...shapeOf(f.key, draft[f.key] ?? []), label: f.label, help: f.help, required: f.required, max: f.max }
            : described(f),
    );
    const seen = new Set(known.map((f) => f.key));
    return [
        ...known,
        ...Object.entries(draft)
            .filter(([key]) => !seen.has(key))
            .map(([key, value]) => shapeOf(key, value)),
    ];
}

// How many separate things a person can change in a document (for "12 pieces of wording").
export function countPieces(doc: Pick<ContentDocument, "draft" | "fields">): number {
    const count = (shapes: Shape[]): number => shapes.reduce((n, s) => n + (s.type === "group" ? count(s.parts ?? []) : 1), 0);
    return count(fieldsOf(doc));
}

const text = (v: unknown): string =>
    typeof v === "string" ? v : v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v);
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => !isObject(x)).map((x) => text(x)) : []);
const entries = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);

// What is stored: lists without blank lines, everything else as typed. A value that is not what
// its field expects (a list holding numbers or further lists, say, as the assistant may have
// saved it) is left exactly as it is: saving something else in the document must not change or lose it.
function tidy(shape: Shape, value: unknown): unknown {
    if (shape.type === "list") {
        if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return value;
        return value.map((l: string) => l.trim()).filter(Boolean);
    }
    if (shape.type === "items") {
        if (!Array.isArray(value) || !value.every(isObject)) return value;
        return value.map((e) => tidyAll(shape.parts ?? [], e));
    }
    if (shape.type === "group") return isObject(value) ? tidyAll(shape.parts ?? [], value) : value;
    return value;
}
function tidyAll(shapes: Shape[], values: Record<string, unknown>): Record<string, unknown> {
    const out = { ...values };
    for (const s of shapes) if (s.key in out) out[s.key] = tidy(s, out[s.key]);
    return out;
}

// ---- one field, of any kind ---------------------------------------------------------------------

// How much room is left, said only when it matters: nearly full, or over.
function Room({ shape, value }: { shape: Shape; value: unknown }) {
    if (!shape.max) return null;
    const countable = shape.type === "text" || shape.type === "long" || shape.type === "list" || shape.type === "items";
    if (!countable) return null;
    const count =
        shape.type === "items"
            ? entries(value).length
            : shape.type === "list"
              ? lines(value).filter((l) => l.trim()).length
              : text(value).length;
    if (count < shape.max * 0.8) return null;
    const unit = shape.type === "text" || shape.type === "long" ? "characters" : "entries";
    return (
        <span className={`field-help ${count > shape.max ? "field-over" : ""}`}>
            {count > shape.max
                ? `${count - shape.max} ${unit} too many: the most is ${shape.max}. It can be saved, but not published, like this.`
                : `${count} of ${shape.max} ${unit}`}
        </span>
    );
}

interface FieldProps {
    shape: Shape;
    value: unknown;
    onChange: (value: unknown) => void;
    readOnly: boolean;
    id: string;
    focus?: boolean;
    // Shown beside the label: where on the website this appears.
    where?: ReactNode;
}

function Field({ shape, value, onChange, readOnly, id, focus, where }: FieldProps) {
    // Only a field with a box of its own to type in has something for its label to point at;
    // a group, a set of entries and a picture do not.
    const boxed = shape.type !== "group" && shape.type !== "items" && shape.type !== "image" && shape.type !== "video";
    const label = (
        <span className="field-label">
            <label htmlFor={boxed ? id : undefined} className="eyebrow">
                {shape.label}
                {shape.type === "list" && <span className="field-note"> · one per line</span>}
                {shape.required && <span className="field-note"> · needed before publishing</span>}
            </label>
            {where}
        </span>
    );
    const help = shape.help && <span className="field-help">{shape.help}</span>;

    if (shape.type === "group") {
        const group = isObject(value) ? value : {};
        return (
            <fieldset className="group">
                <legend>{label}</legend>
                {help}
                {(shape.parts ?? []).map((part) => (
                    <Field
                        key={part.key}
                        shape={part}
                        value={group[part.key]}
                        onChange={(v) => onChange({ ...group, [part.key]: v })}
                        readOnly={readOnly}
                        id={`${id}-${part.key}`}
                    />
                ))}
            </fieldset>
        );
    }
    if (shape.type === "items") {
        return (
            <div className="field">
                {label}
                {help && <span className="field-help field-help-first">{shape.help}</span>}
                <Items shape={shape} value={entries(value)} onChange={onChange} readOnly={readOnly} id={id} />
                <Room shape={shape} value={value} />
            </div>
        );
    }
    if (shape.type === "yesno") {
        return (
            <div className="field">
                <label className="check">
                    <input
                        id={id}
                        type="checkbox"
                        checked={value === true}
                        disabled={readOnly}
                        onChange={(e) => onChange(e.target.checked)}
                    />
                    <span>
                        {shape.label}
                        <span className="field-note"> · {value === true ? "shown on the website" : "hidden on the website"}</span>
                    </span>
                </label>
                {where}
                {help}
            </div>
        );
    }
    const str = text(value);
    return (
        <div className="field">
            {label}
            {shape.type === "image" || shape.type === "video" ? (
                <PictureField value={str} onChange={onChange} readOnly={readOnly} kind={shape.type} />
            ) : shape.type === "rich" ? (
                <RichEditor id={id} value={str} onChange={onChange} readOnly={readOnly} focus={focus === true} />
            ) : shape.type === "long" || shape.type === "list" ? (
                <textarea
                    id={id}
                    value={shape.type === "list" ? lines(value).join("\n") : str}
                    readOnly={readOnly}
                    rows={Math.min(
                        14,
                        Math.max(3, Math.ceil(str.length / 60), (shape.type === "list" ? lines(value).length : str.split("\n").length) + 1),
                    )}
                    onChange={(e) => onChange(shape.type === "list" ? e.target.value.split("\n") : e.target.value)}
                    // biome-ignore lint/a11y/noAutofocus: the field the person asked to edit
                    autoFocus={focus}
                />
            ) : (
                <input
                    id={id}
                    type={shape.type === "number" ? "number" : shape.type === "date" ? "date" : "text"}
                    value={str}
                    readOnly={readOnly}
                    placeholder={shape.type === "link" ? "A web address, or a page such as about.html" : undefined}
                    onChange={(e) =>
                        onChange(shape.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)
                    }
                    // biome-ignore lint/a11y/noAutofocus: the field the person asked to edit
                    autoFocus={focus}
                />
            )}
            {help}
            <Room shape={shape} value={value} />
        </div>
    );
}

// A list whose entries each have several parts (a service: its name, its summary,
// its photograph). Each entry is a card of proper fields; entries can be added,
// removed and moved.
function Items({
    shape,
    value,
    onChange,
    readOnly,
    id,
}: {
    shape: Shape;
    value: Record<string, unknown>[];
    onChange: (value: unknown) => void;
    readOnly: boolean;
    id: string;
}) {
    const parts = shape.parts ?? [];
    const move = (i: number, by: number) => {
        const next = [...value];
        const [it] = next.splice(i, 1);
        if (it) next.splice(i + by, 0, it);
        onChange(next);
    };
    // Dragging an entry by its handle moves it; Move up and Move down do the same without a mouse.
    const [dragging, setDragging] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const drop = (to: number) => {
        if (dragging !== null && dragging !== to) {
            const next = [...value];
            const [it] = next.splice(dragging, 1);
            if (it) next.splice(to, 0, it);
            onChange(next);
        }
        setDragging(null);
        setOver(null);
    };
    const one = shape.label.replace(/ies$/i, "y").replace(/s$/i, "").toLowerCase();
    const full = shape.max !== undefined && value.length >= shape.max;
    // An entry is known by its first line of text, when it has one.
    const titleOf = (entry: Record<string, unknown>): string => {
        const first = parts.find((p) => p.type === "text" && typeof entry[p.key] === "string" && entry[p.key]);
        return first ? ` · ${String(entry[first.key]).slice(0, 50)}` : "";
    };

    return (
        <div className="items">
            {value.length === 0 && <p className="muted">Nothing here yet.</p>}
            {value.map((entry, i) => (
                <fieldset
                    // biome-ignore lint/suspicious/noArrayIndexKey: entries have no identity of their own; position is what they are
                    key={i}
                    className={`item ${dragging === i ? "item-dragging" : ""} ${over === i && dragging !== null && dragging !== i ? "item-over" : ""}`}
                    onDragOver={(e) => {
                        if (dragging === null) return;
                        e.preventDefault();
                        setOver(i);
                    }}
                    onDrop={(e) => {
                        e.preventDefault();
                        drop(i);
                    }}
                >
                    <legend className="mono muted">
                        {!readOnly && value.length > 1 && (
                            // biome-ignore lint/a11y/noStaticElementInteractions: a drag handle; Move up and Move down do the same from the keyboard
                            <span
                                className="item-grip"
                                draggable
                                onDragStart={(e) => {
                                    setDragging(i);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.dataTransfer.setData("text/plain", String(i));
                                }}
                                onDragEnd={() => {
                                    setDragging(null);
                                    setOver(null);
                                }}
                                title="Drag to move this entry"
                            >
                                <GripVertical /> Drag to move ·{" "}
                            </span>
                        )}
                        {i + 1} of {value.length}
                        {titleOf(entry)}
                    </legend>
                    {parts.map((part) => (
                        <Field
                            key={part.key}
                            shape={part}
                            value={entry[part.key]}
                            onChange={(v) => onChange(value.map((e, n) => (n === i ? { ...e, [part.key]: v } : e)))}
                            readOnly={readOnly}
                            id={`${id}-${i}-${part.key}`}
                        />
                    ))}
                    {!readOnly && (
                        <div className="item-actions">
                            <button type="button" className="btn btn-sm" onClick={() => move(i, -1)} disabled={i === 0}>
                                <ArrowUp /> Move up
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => move(i, 1)} disabled={i === value.length - 1}>
                                <ArrowDown /> Move down
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => onChange(value.filter((_, n) => n !== i))}>
                                <Trash2 /> Remove this {one}
                            </button>
                        </div>
                    )}
                </fieldset>
            ))}
            {!readOnly && (
                <button type="button" className="btn btn-sm" onClick={() => onChange([...value, {}])} disabled={full}>
                    <Plus /> {full ? `No more than ${shape.max}` : `Add ${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`}
                </button>
            )}
        </div>
    );
}

// ---- the form ----------------------------------------------------------------------------------

type Values = Record<string, unknown>;
const valuesOf = (doc: Pick<ContentDocument, "draft">): Values => ({ ...(doc.draft ?? {}) });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface FormProps {
    doc: ContentDocument;
    canEdit: boolean;
    // Saves the whole document. Rejects with a message if it could not (someone else changed it, say).
    onSave: (doc: ContentDocument, draft: Record<string, unknown>) => Promise<void>;
    // The field to bring into view and put the cursor in.
    focus?: string | null;
    onClose?: () => void;
    // For each field, where on the website it appears (the Content page supplies this).
    where?: (key: string) => ReactNode;
    // The person has started working on a field.
    onField?: (key: string) => void;
}

export function WordingForm({ doc, canEdit, onSave, focus, onClose, where, onField }: FormProps) {
    const fields = fieldsOf(doc);
    const [values, setValues] = useState<Values>(() => valuesOf(doc));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // When the document changes underneath (someone else or the assistant saved it):
    // show the new wording, unless this person has unsaved edits. Those are kept,
    // and they are told, instead of having their typing replaced.
    const [based, setBased] = useState(doc.rev);
    const basedValues = useRef<Values>(valuesOf(doc));
    const valuesRef = useRef(values);
    valuesRef.current = values;
    const clean = (v: Values) => tidyAll(fields, v);
    // biome-ignore lint/correctness/useExhaustiveDependencies: react only when the revision changes
    useEffect(() => {
        if (doc.rev === based) return;
        const latest = valuesOf(doc);
        const unsaved = !same(clean(valuesRef.current), clean(basedValues.current));
        if (unsaved && !same(clean(valuesRef.current), clean(latest))) return;
        setValues(latest);
        setBased(doc.rev);
        basedValues.current = latest;
        setError(null);
    }, [doc.rev]);
    const outdated = doc.rev !== based;
    const dirty = !same(clean(values), clean(basedValues.current));
    const useTheirs = () => {
        const latest = valuesOf(doc);
        setValues(latest);
        setBased(doc.rev);
        basedValues.current = latest;
        setError(null);
    };

    // The field asked for is brought into view.
    const form = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!focus) return;
        form.current?.querySelector(`[data-field="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, [focus]);

    async function save() {
        setSaving(true);
        setError(null);
        try {
            await onSave(doc, clean(values));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    const changed = !same(doc.draft, doc.published);

    return (
        <div className="wording-form" ref={form}>
            {fields.length === 0 && <p className="muted">There is no wording here yet.</p>}
            {fields.map((f) => (
                <div
                    key={f.key}
                    data-field={f.key}
                    className={`field-row ${focus === f.key ? "field-row-on" : ""}`}
                    onFocusCapture={() => onField?.(f.key)}
                >
                    <Field
                        shape={f}
                        value={values[f.key]}
                        onChange={(v) => setValues((all) => ({ ...all, [f.key]: v }))}
                        readOnly={!canEdit}
                        id={`f-${doc.id}-${f.key}`}
                        focus={focus === f.key}
                        where={where?.(f.key)}
                    />
                </div>
            ))}
            {outdated && (
                <p className="doc-error">
                    This was changed by someone else while you were editing. Your edits are still here but can't be saved over theirs.{" "}
                    <button type="button" className="link" onClick={useTheirs}>
                        Show their version instead
                    </button>
                </p>
            )}
            {error && !outdated && <p className="doc-error">{error}</p>}
            <div className="wording-foot">
                <span className="mono muted">
                    Last changed {timeAgo(doc.updatedAt)} · {changed ? "not published yet" : "published"}
                </span>
                {onClose && (
                    <button type="button" className="btn btn-sm" onClick={onClose}>
                        Close
                    </button>
                )}
                {canEdit && (
                    <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={saving || !dirty || outdated}
                        onClick={() => void save()}
                        title="Saved changes show in the preview. They go public when you publish."
                    >
                        {saving ? <Dots /> : "Save"}
                    </button>
                )}
            </div>
        </div>
    );
}

// The pop-up: one piece of wording, with room to edit.
export function WordingDialog(props: FormProps & { onClose: () => void }) {
    return (
        <Dialog onClose={props.onClose} wide>
            <p className="eyebrow">Wording</p>
            <h2>{documentName(props.doc)}</h2>
            <p>Changes show in the preview when you press Save. They go public the next time you publish.</p>
            {/* Keyed by the document: if a different one is shown in this pop-up, its form starts afresh. */}
            <WordingForm key={props.doc.id} {...props} />
        </Dialog>
    );
}

// Where a link or a picture may point: a web address, an e-mail address, a telephone number, or
// one of the website's own pages or files. Anything else that names a scheme (javascript:, data:)
// is refused. A browser ignores spaces and control characters in a scheme, so they are taken out first.
const safeAddress = (address: string): boolean => {
    const bare = [...address].filter((c) => c > " ").join("");
    return !/^[a-z][a-z0-9+.-]*:/i.test(bare) || /^(https?:\/\/|mailto:|tel:)/i.test(bare);
};
const UNSAFE_TAGS = "script,style,iframe,object,embed,template,noscript,svg,math,form,link,meta,base";
const ADDRESSES = new Set(["href", "src", "srcset", "poster", "data", "action", "formaction", "xlink:href"]);

// Puts formatted wording into the editing box with anything that could run taken out. The server
// cleans formatted text too, but only fields described as formatted; wording saved without a
// description is shown here as well, so this page does not rely on that. The wording is read in a
// document of its own (where nothing loads or runs) and its parts are moved across, never written
// into this page as markup. Styling on it is kept: it cannot run anything, and losing it would
// undo what the assistant made the moment someone corrected a word.
function fillRich(box: HTMLElement, html: string): void {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const el of parsed.body.querySelectorAll(UNSAFE_TAGS)) el.remove();
    for (const el of parsed.body.querySelectorAll("*")) {
        for (const a of [...el.attributes]) {
            const name = a.name.toLowerCase();
            const unsafe =
                name.startsWith("on") ||
                name === "id" ||
                name === "name" ||
                name === "srcdoc" ||
                (ADDRESSES.has(name) && !safeAddress(a.value));
            if (unsafe) el.removeAttribute(a.name);
        }
    }
    box.replaceChildren(...parsed.body.childNodes);
}

// A small editor for text with a little formatting: bold, italic, links, lists.
// What it produces is cleaned by the server before it is stored or shown.
function RichEditor({
    id,
    value,
    onChange,
    readOnly,
    focus,
}: {
    id: string;
    value: string;
    onChange: (html: string) => void;
    readOnly: boolean;
    focus: boolean;
}) {
    const toast = useToast();
    const box = useRef<HTMLDivElement>(null);
    // The box owns its contents while it is being typed in; only an outside change is written back into it.
    const last = useRef(value);
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        if (el.innerHTML === "" || value !== last.current) fillRich(el, value);
        last.current = value;
    }, [value]);
    useEffect(() => {
        if (focus) box.current?.focus();
    }, [focus]);

    const emit = () => {
        const html = box.current?.innerHTML ?? "";
        last.current = html;
        onChange(html);
    };
    const run = (command: string, arg?: string) => {
        box.current?.focus();
        document.execCommand(command, false, arg);
        emit();
    };
    const link = () => {
        const url = window.prompt("Where should the link go? (a web address, or a page such as about.html)");
        if (!url?.trim()) return;
        if (safeAddress(url)) run("createLink", url.trim());
        else
            toast(
                "A link can go to a web address, an e-mail address, a telephone number or one of your pages. No link was added.",
                "error",
            );
    };

    return (
        <div className={`rich ${readOnly ? "rich-readonly" : ""}`}>
            {!readOnly && (
                <div className="rich-tools">
                    <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => run("bold")}
                    >
                        <Bold /> Bold
                    </button>
                    <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => run("italic")}
                    >
                        <Italic /> Italic
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onMouseDown={(e) => e.preventDefault()} onClick={link}>
                        <Link2 /> Link
                    </button>
                    <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => run("insertUnorderedList")}
                    >
                        <List /> List
                    </button>
                </div>
            )}
            {/* biome-ignore lint/a11y/useSemanticElements: an editable region with formatting; a textarea cannot hold it */}
            <div
                id={id}
                ref={box}
                className="rich-box"
                role="textbox"
                aria-multiline="true"
                tabIndex={0}
                contentEditable={!readOnly}
                suppressContentEditableWarning
                onInput={emit}
                onBlur={emit}
            />
        </div>
    );
}
