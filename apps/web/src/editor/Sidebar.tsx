import { ChevronRight, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Checkpoint, ContentDocument, Release } from "../lib/api";
import { timeAgo } from "../lib/hooks";

export type Tab = "versions" | "releases" | "content";

interface SidebarProps {
    tab: Tab;
    onTab: (t: Tab) => void;
    checkpoints: Checkpoint[];
    releases: Release[];
    documents: ContentDocument[];
    busy: boolean;
    canPublish: boolean;
    canEdit: boolean;
    onRestore: (sha: string) => void;
    onRollback: (number: number) => void;
    onSaveDocument: (doc: ContentDocument, draft: Record<string, unknown>) => Promise<void>;
}

const TABS: { id: Tab; label: string }[] = [
    { id: "versions", label: "Versions" },
    { id: "releases", label: "Published" },
    { id: "content", label: "Wording" },
];

// One line under the tabs saying what this list is and what you can do with it.
const ABOUT: Record<Tab, string> = {
    versions: "Every change your assistant makes is saved here. Choose one to go back to it. Nothing here is public until you publish.",
    releases: "Each time you publish, it is recorded here. You can put an earlier one back.",
    content: "The words on your website that you can change yourself, without asking your assistant.",
};

export function Sidebar(props: SidebarProps) {
    const { tab, onTab, checkpoints, releases, documents } = props;
    const counts: Record<Tab, number> = { versions: checkpoints.length, releases: releases.length, content: documents.length };
    return (
        <aside className="side">
            <div className="tabs" role="tablist">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        className={tab === t.id ? "on" : ""}
                        onClick={() => onTab(t.id)}
                    >
                        {t.label}
                        {counts[t.id] > 0 && <span className="mono">{counts[t.id]}</span>}
                    </button>
                ))}
            </div>
            <div className="side-scroll">
                <p className="side-about">{ABOUT[tab]}</p>
                {tab === "versions" && <Versions {...props} />}
                {tab === "releases" && <Releases {...props} />}
                {tab === "content" && <Content {...props} />}
            </div>
        </aside>
    );
}

function Empty({ title, body }: { title: string; body: string }) {
    return (
        <div className="side-empty">
            <h3 className="display">{title}</h3>
            <p className="muted">{body}</p>
        </div>
    );
}

function Versions({ checkpoints, busy, canEdit, onRestore }: SidebarProps) {
    if (checkpoints.length === 0) {
        return <Empty title="No versions yet." body="Every request you make is saved here, so you can always go back." />;
    }
    return (
        <ol className="timeline">
            {checkpoints.map((c, i) => (
                <li key={c.sha} className={i === 0 ? "current" : ""}>
                    <p className="tl-title">{c.message}</p>
                    <p className="mono muted">{timeAgo(c.date)}</p>
                    {i === 0 ? (
                        <span className="chip chip-seal">What you see now</span>
                    ) : (
                        canEdit && (
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onRestore(c.sha)}>
                                <Undo2 /> Go back to this
                            </button>
                        )
                    )}
                </li>
            ))}
        </ol>
    );
}

// A release's state, in the words a person would use.
const RELEASE_STATE: Record<string, string> = {
    planned: "Not published",
    failed: "Didn't publish",
    superseded: "Was live",
    rolled_back: "Was live",
};

function Releases({ releases, busy, canPublish, onRollback }: SidebarProps) {
    if (releases.length === 0) {
        return <Empty title="Not published yet." body="When you press Publish, it is recorded here." />;
    }
    return (
        <ol className="timeline">
            {releases.map((r) => {
                const live = r.state === "live";
                const past = r.state === "superseded" || r.state === "rolled_back";
                return (
                    <li key={r.id} className={live ? "current" : ""}>
                        <p className="tl-title">
                            Release {r.number}
                            {r.rollbackOf && <span className="muted"> · an earlier one put back</span>}
                        </p>
                        <p className="mono muted">{timeAgo(r.deployedAt ?? r.createdAt)}</p>
                        {live ? (
                            <span className="chip chip-live">Live</span>
                        ) : past && canPublish ? (
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onRollback(r.number)}>
                                <Undo2 /> Put this one back
                            </button>
                        ) : (
                            <span className="chip chip-plain">{RELEASE_STATE[r.state] ?? r.state}</span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

function Content({ documents, canEdit, onSaveDocument }: SidebarProps) {
    if (documents.length === 0) {
        return (
            <Empty
                title="No wording yet."
                body="When your assistant writes headlines, introductions or details like opening hours, they appear here for you to edit."
            />
        );
    }
    return (
        <ul className="docs">
            {documents.map((d) => (
                <Document key={d.id} doc={d} canEdit={canEdit} onSave={onSaveDocument} />
            ))}
        </ul>
    );
}

// "heroTitle" / "hero_title" -> "Hero title"
function label(key: string): string {
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// Each field is edited as text: plain strings as they are, anything structured
// (lists, numbers, nested objects) as JSON, which is parsed back on save.
// A list of plain strings (opening hours, say) is edited one per line.
type Field = { key: string; text: string; kind: "text" | "lines" | "structured" };

const isLines = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

const toFields = (draft: Record<string, unknown> | null): Field[] =>
    Object.entries(draft ?? {}).map(([key, value]) =>
        typeof value === "string"
            ? { key, text: value, kind: "text" }
            : isLines(value)
              ? { key, text: value.join("\n"), kind: "lines" }
              : { key, text: JSON.stringify(value, null, 2), kind: "structured" },
    );

function Document({ doc, canEdit, onSave }: { doc: ContentDocument; canEdit: boolean; onSave: SidebarProps["onSaveDocument"] }) {
    const [open, setOpen] = useState(false);
    const [fields, setFields] = useState<Field[]>(() => toFields(doc.draft));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    // When the document changes underneath (someone else or the assistant saved it):
    // show the new wording, unless this person has unsaved edits. Those are kept,
    // and they are told, instead of having their typing replaced.
    const [based, setBased] = useState(doc.rev);
    const fieldsRef = useRef(fields);
    fieldsRef.current = fields;
    const basedDraft = useRef(doc.draft);
    // biome-ignore lint/correctness/useExhaustiveDependencies: react only when the revision changes
    useEffect(() => {
        if (doc.rev === based) return;
        // What is on screen already matches the new version (this person just saved it): nothing to resolve.
        const same = JSON.stringify(fieldsRef.current) === JSON.stringify(toFields(doc.draft));
        const unsaved = JSON.stringify(fieldsRef.current) !== JSON.stringify(toFields(basedDraft.current));
        if (unsaved && !same) return;
        setFields(toFields(doc.draft));
        setBased(doc.rev);
        basedDraft.current = doc.draft;
        setError(null);
    }, [doc.rev]);
    const outdated = doc.rev !== based;
    const useTheirs = () => {
        setFields(toFields(doc.draft));
        setBased(doc.rev);
        basedDraft.current = doc.draft;
        setError(null);
    };

    const changed = JSON.stringify(doc.draft) !== JSON.stringify(doc.published);
    const dirty = JSON.stringify(fields) !== JSON.stringify(toFields(outdated ? basedDraft.current : doc.draft));

    async function save() {
        const draft: Record<string, unknown> = {};
        for (const f of fields) {
            if (f.kind === "text") {
                draft[f.key] = f.text;
                continue;
            }
            if (f.kind === "lines") {
                draft[f.key] = f.text
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean);
                continue;
            }
            try {
                draft[f.key] = JSON.parse(f.text);
            } catch {
                setError(
                    `"${label(f.key)}" has a mistake in its brackets or quotes. If that is unclear, ask your assistant to change it instead.`,
                );
                return;
            }
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

    return (
        <li className={open ? "open" : ""}>
            <button type="button" className="doc-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                <ChevronRight />
                <span className="doc-name">
                    <strong>{label(doc.slug)}</strong>
                    <span className="mono muted">
                        {fields.length} {fields.length === 1 ? "piece of wording" : "pieces of wording"}
                    </span>
                </span>
                <span className={`chip ${changed ? "chip-draft" : "chip-live"}`}>{changed ? "Not published yet" : "Published"}</span>
            </button>
            {open && (
                <div className="doc-body">
                    {fields.length === 0 && <p className="muted">This document is empty.</p>}
                    {fields.map((f, i) => (
                        <label key={f.key} className="field">
                            <span className="eyebrow">
                                {label(f.key)}
                                {f.kind === "lines" && <span className="field-note"> · one per line</span>}
                                {f.kind === "structured" && <span className="field-note"> · structured: easier to ask your assistant</span>}
                            </span>
                            <textarea
                                className={f.kind === "structured" ? "mono" : ""}
                                value={f.text}
                                spellCheck={f.kind !== "structured"}
                                readOnly={!canEdit}
                                rows={Math.min(
                                    f.kind === "structured" ? 12 : 8,
                                    Math.max(1, Math.ceil(f.text.length / 34), f.text.split("\n").length),
                                )}
                                onChange={(e) => setFields((prev) => prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                            />
                        </label>
                    ))}
                    {outdated && (
                        <p className="doc-error">
                            This was changed by someone else while you were editing. Your edits are still here but can't be saved over
                            theirs.{" "}
                            <button type="button" className="link" onClick={useTheirs}>
                                Show their version instead
                            </button>
                        </p>
                    )}
                    {error && !outdated && <p className="doc-error">{error}</p>}
                    <div className="doc-foot">
                        <span className="mono muted">Last changed {timeAgo(doc.updatedAt)}</span>
                        {canEdit && (
                            <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={saving || !dirty || outdated}
                                onClick={save}
                                title="Saved changes show in the preview. They go public when you publish."
                            >
                                Save
                            </button>
                        )}
                    </div>
                </div>
            )}
        </li>
    );
}
