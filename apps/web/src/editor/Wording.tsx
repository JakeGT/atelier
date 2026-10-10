import { ArrowDown, ArrowUp, Bold, Italic, Link2, List, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ContentDocument, ContentField } from "../lib/api";
import { timeAgo } from "../lib/hooks";
import { Dialog, Dots } from "../ui/kit";
import { PictureField } from "./Media";

// Editing a piece of wording: proper fields with plain labels, in whichever place
// it is being edited (the pop-up from the editor, or the Content page). ADR-0014.

// "heroTitle" / "hero_title" -> "Hero title"
export function plainLabel(key: string): string {
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// What a document is called: the page it belongs to.
export function documentName(doc: Pick<ContentDocument, "kind" | "slug">): string {
    if (doc.slug === "shared") return "On every page";
    const name = plainLabel(doc.slug);
    return doc.kind === "page" ? `${name} page` : name;
}

type Shown = ContentField & { structured?: boolean };

const isLines = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// The fields to show: as the document describes them, then any value it does not
// describe (worked out from the value), so nothing saved is ever hidden.
export function fieldsOf(doc: Pick<ContentDocument, "draft" | "fields">): Shown[] {
    const draft = doc.draft ?? {};
    const described = doc.fields ?? [];
    const seen = new Set(described.map((f) => f.key));
    const guessed: Shown[] = Object.entries(draft)
        .filter(([key]) => !seen.has(key))
        .map(([key, value]) => {
            const label = plainLabel(key);
            if (typeof value === "string" && /^media\/[a-z0-9][a-z0-9-]*\.(jpg|png|webp|avif|gif|svg)$/.test(value))
                return { key, label, type: "image" };
            if (typeof value === "string") return { key, label, type: value.length > 90 || value.includes("\n") ? "long" : "text" };
            if (isLines(value)) return { key, label, type: "list" };
            return { key, label, type: "long", structured: true };
        });
    return [...described, ...guessed];
}

// A field's value as the text its control edits.
function toText(field: Shown, value: unknown): string {
    if (field.structured) return JSON.stringify(value ?? null, null, 2);
    if (field.type === "list") return isLines(value) ? value.join("\n") : "";
    // A list of items is carried as text here and edited as proper fields by ItemsField.
    if (field.type === "items") return JSON.stringify(Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : []);
    return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

type Values = Record<string, string>;
const valuesOf = (doc: Pick<ContentDocument, "draft" | "fields">): Values =>
    Object.fromEntries(fieldsOf(doc).map((f) => [f.key, toText(f, doc.draft?.[f.key])]));

interface FormProps {
    doc: ContentDocument;
    canEdit: boolean;
    // Saves the whole document. Rejects with a message if it could not (someone else changed it, say).
    onSave: (doc: ContentDocument, draft: Record<string, unknown>) => Promise<void>;
    // The field to put the cursor in first.
    focus?: string | null;
    onClose?: () => void;
}

export function WordingForm({ doc, canEdit, onSave, focus, onClose }: FormProps) {
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: react only when the revision changes
    useEffect(() => {
        if (doc.rev === based) return;
        const latest = valuesOf(doc);
        const same = JSON.stringify(valuesRef.current) === JSON.stringify(latest);
        const unsaved = JSON.stringify(valuesRef.current) !== JSON.stringify(basedValues.current);
        if (unsaved && !same) return;
        setValues(latest);
        setBased(doc.rev);
        basedValues.current = latest;
        setError(null);
    }, [doc.rev]);
    const outdated = doc.rev !== based;
    const dirty = JSON.stringify(values) !== JSON.stringify(basedValues.current);
    const useTheirs = () => {
        const latest = valuesOf(doc);
        setValues(latest);
        setBased(doc.rev);
        basedValues.current = latest;
        setError(null);
    };

    async function save() {
        const draft: Record<string, unknown> = { ...(doc.draft ?? {}) };
        for (const f of fields) {
            const text = values[f.key] ?? "";
            if (f.structured) {
                try {
                    draft[f.key] = JSON.parse(text);
                } catch {
                    setError(
                        `"${f.label}" has a mistake in its brackets or quotes. If that is unclear, ask your assistant to change it instead.`,
                    );
                    return;
                }
            } else if (f.type === "items") {
                draft[f.key] = parseItems(text);
            } else if (f.type === "list") {
                draft[f.key] = text
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean);
            } else draft[f.key] = text;
        }
        setSaving(true);
        setError(null);
        try {
            await onSave(doc, draft);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
    const changed = JSON.stringify(doc.draft) !== JSON.stringify(doc.published);

    return (
        <div className="wording-form">
            {fields.length === 0 && <p className="muted">There is no wording here yet.</p>}
            {fields.map((f) => (
                <div key={f.key} className="field">
                    <label htmlFor={`f-${doc.id}-${f.key}`} className="eyebrow">
                        {f.label}
                        {f.type === "list" && <span className="field-note"> · one per line</span>}
                        {f.required && <span className="field-note"> · needed before publishing</span>}
                        {f.structured && <span className="field-note"> · structured: easier to ask your assistant</span>}
                    </label>
                    {f.type === "items" && f.help && <span className="field-help field-help-first">{f.help}</span>}
                    {f.type === "items" ? (
                        <ItemsField
                            field={f}
                            value={values[f.key] ?? "[]"}
                            onChange={(v) => set(f.key, v)}
                            readOnly={!canEdit}
                            id={`f-${doc.id}-${f.key}`}
                        />
                    ) : f.type === "image" ? (
                        <PictureField value={values[f.key] ?? ""} onChange={(v) => set(f.key, v)} readOnly={!canEdit} />
                    ) : f.type === "rich" ? (
                        <RichEditor
                            id={`f-${doc.id}-${f.key}`}
                            value={values[f.key] ?? ""}
                            onChange={(v) => set(f.key, v)}
                            readOnly={!canEdit}
                            focus={focus === f.key}
                        />
                    ) : f.type === "text" ? (
                        <input
                            id={`f-${doc.id}-${f.key}`}
                            value={values[f.key] ?? ""}
                            onChange={(e) => set(f.key, e.target.value)}
                            readOnly={!canEdit}
                            // biome-ignore lint/a11y/noAutofocus: the field the person asked to edit
                            autoFocus={focus === f.key}
                        />
                    ) : (
                        <textarea
                            id={`f-${doc.id}-${f.key}`}
                            className={f.structured ? "mono" : ""}
                            value={values[f.key] ?? ""}
                            spellCheck={!f.structured}
                            readOnly={!canEdit}
                            rows={Math.min(
                                14,
                                Math.max(3, Math.ceil((values[f.key] ?? "").length / 60), (values[f.key] ?? "").split("\n").length + 1),
                            )}
                            onChange={(e) => set(f.key, e.target.value)}
                            // biome-ignore lint/a11y/noAutofocus: the field the person asked to edit
                            autoFocus={focus === f.key}
                        />
                    )}
                    {f.help && f.type !== "items" && <span className="field-help">{f.help}</span>}
                    <Room field={f} text={values[f.key] ?? ""} />
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
            <WordingForm {...props} />
        </Dialog>
    );
}

// A small editor for text with a little formatting: bold, italic, links, lists.
// What it produces is cleaned by the server before it is stored or shown.
type Item = Record<string, unknown>;
const parseItems = (text: string): Item[] => {
    try {
        const v = JSON.parse(text) as unknown;
        return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Item[]) : [];
    } catch {
        return [];
    }
};

// How much room is left, said only when it matters: nearly full, or over.
function Room({ field, text }: { field: { type: string; max?: number }; text: string }) {
    if (!field.max) return null;
    const count =
        field.type === "items"
            ? parseItems(text).length
            : field.type === "list"
              ? text.split("\n").filter((l) => l.trim()).length
              : text.length;
    if (field.type !== "text" && field.type !== "long" && field.type !== "list" && field.type !== "items") return null;
    if (count < field.max * 0.8) return null;
    const unit = field.type === "text" || field.type === "long" ? "characters" : "entries";
    return (
        <span className={`field-help ${count > field.max ? "field-over" : ""}`}>
            {count > field.max
                ? `${count - field.max} ${unit} too many: the most is ${field.max}. It can be saved, but not published, like this.`
                : `${count} of ${field.max} ${unit}`}
        </span>
    );
}

// A list whose entries each have several parts (a service: its name, its summary,
// its photograph). Each entry is a card of proper fields; entries can be added,
// removed and moved.
function ItemsField({
    field,
    value,
    onChange,
    readOnly,
    id,
}: {
    field: ContentField;
    value: string;
    onChange: (text: string) => void;
    readOnly: boolean;
    id: string;
}) {
    const items = parseItems(value);
    const parts = field.itemFields ?? [];
    const write = (next: Item[]) => onChange(JSON.stringify(next));
    const setPart = (i: number, key: string, v: string) => write(items.map((it, n) => (n === i ? { ...it, [key]: v } : it)));
    const move = (i: number, by: number) => {
        const next = [...items];
        const [it] = next.splice(i, 1);
        if (it) next.splice(i + by, 0, it);
        write(next);
    };
    const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
    const one = field.label.replace(/s$/i, "").toLowerCase();
    const full = field.max !== undefined && items.length >= field.max;

    return (
        <div className="items">
            {items.length === 0 && <p className="muted">Nothing here yet.</p>}
            {items.map((item, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: entries have no identity of their own; position is what they are
                <fieldset key={i} className="item">
                    <legend className="mono muted">
                        {i + 1} of {items.length}
                    </legend>
                    {parts.map((p) => {
                        const pid = `${id}-${i}-${p.key}`;
                        const v = str(item[p.key]);
                        return (
                            <div key={p.key} className="field">
                                <label htmlFor={pid} className="eyebrow">
                                    {p.label}
                                    {p.required && <span className="field-note"> · needed before publishing</span>}
                                </label>
                                {p.type === "image" ? (
                                    <PictureField value={v} onChange={(nv) => setPart(i, p.key, nv)} readOnly={readOnly} />
                                ) : p.type === "rich" ? (
                                    <RichEditor
                                        id={pid}
                                        value={v}
                                        onChange={(nv) => setPart(i, p.key, nv)}
                                        readOnly={readOnly}
                                        focus={false}
                                    />
                                ) : p.type === "long" ? (
                                    <textarea
                                        id={pid}
                                        rows={3}
                                        value={v}
                                        readOnly={readOnly}
                                        onChange={(e) => setPart(i, p.key, e.target.value)}
                                    />
                                ) : (
                                    <input
                                        id={pid}
                                        value={v}
                                        readOnly={readOnly}
                                        placeholder={p.type === "link" ? "A web address, or a page such as about.html" : undefined}
                                        onChange={(e) => setPart(i, p.key, e.target.value)}
                                    />
                                )}
                                {p.help && <span className="field-help">{p.help}</span>}
                                <Room field={p} text={v} />
                            </div>
                        );
                    })}
                    {!readOnly && (
                        <div className="item-actions">
                            <button type="button" className="btn btn-sm" onClick={() => move(i, -1)} disabled={i === 0}>
                                <ArrowUp /> Move up
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => move(i, 1)} disabled={i === items.length - 1}>
                                <ArrowDown /> Move down
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => write(items.filter((_, n) => n !== i))}>
                                <Trash2 /> Remove this {one}
                            </button>
                        </div>
                    )}
                </fieldset>
            ))}
            {!readOnly && (
                <button type="button" className="btn btn-sm" onClick={() => write([...items, {}])} disabled={full}>
                    <Plus /> {full ? `No more than ${field.max}` : `Add ${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`}
                </button>
            )}
        </div>
    );
}

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
    const box = useRef<HTMLDivElement>(null);
    // The box owns its contents while it is being typed in; only an outside change is written back into it.
    const last = useRef(value);
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        if (el.innerHTML === "" || value !== last.current) el.innerHTML = value;
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
        if (url) run("createLink", url.trim());
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
