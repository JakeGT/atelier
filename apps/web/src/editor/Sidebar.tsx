import { ChevronRight, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
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
    onRestore: (sha: string) => void;
    onRollback: (number: number) => void;
    onSaveDocument: (doc: ContentDocument, draft: Record<string, unknown>) => Promise<void>;
}

const TABS: { id: Tab; label: string }[] = [
    { id: "versions", label: "Versions" },
    { id: "releases", label: "Releases" },
    { id: "content", label: "Content" },
];

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

function Versions({ checkpoints, busy, onRestore }: SidebarProps) {
    if (checkpoints.length === 0) {
        return <Empty title="No versions yet." body="Every request you make is saved here, so you can always go back." />;
    }
    return (
        <ol className="timeline">
            {checkpoints.map((c, i) => (
                <li key={c.sha} className={i === 0 ? "current" : ""}>
                    <p className="tl-title">{c.message}</p>
                    <p className="mono muted">
                        {c.sha.slice(0, 7)} · {timeAgo(c.date)}
                    </p>
                    {i === 0 ? (
                        <span className="chip chip-seal">Current</span>
                    ) : (
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onRestore(c.sha)}>
                            <Undo2 /> Restore
                        </button>
                    )}
                </li>
            ))}
        </ol>
    );
}

function Releases({ releases, busy, canPublish, onRollback }: SidebarProps) {
    if (releases.length === 0) {
        return (
            <Empty
                title="Not published yet."
                body="When you press Publish, the release is recorded here. You can roll back to any earlier one."
            />
        );
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
                            {r.rollbackOf && <span className="muted"> · rollback</span>}
                        </p>
                        <p className="mono muted">
                            {r.codeSha ? `${r.codeSha.slice(0, 7)} · ` : ""}
                            {timeAgo(r.deployedAt ?? r.createdAt)}
                        </p>
                        {live ? (
                            <span className="chip chip-live">Live</span>
                        ) : past && canPublish ? (
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onRollback(r.number)}>
                                <Undo2 /> Roll back to this
                            </button>
                        ) : (
                            <span className="chip chip-plain">{r.state}</span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

function Content({ documents, onSaveDocument }: SidebarProps) {
    if (documents.length === 0) {
        return (
            <Empty title="No content yet." body="Wording your assistant saves as content appears here, where you can edit it directly." />
        );
    }
    return (
        <ul className="docs">
            {documents.map((d) => (
                <Document key={d.id} doc={d} onSave={onSaveDocument} />
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
type Field = { key: string; text: string; structured: boolean };

const toFields = (draft: Record<string, unknown> | null): Field[] =>
    Object.entries(draft ?? {}).map(([key, value]) =>
        typeof value === "string"
            ? { key, text: value, structured: false }
            : { key, text: JSON.stringify(value, null, 2), structured: true },
    );

function Document({ doc, onSave }: { doc: ContentDocument; onSave: SidebarProps["onSaveDocument"] }) {
    const [open, setOpen] = useState(false);
    const [fields, setFields] = useState<Field[]>(() => toFields(doc.draft));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    // When the document changes underneath (the assistant saved a new draft), show that.
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the revision changes
    useEffect(() => {
        setFields(toFields(doc.draft));
        setError(null);
    }, [doc.rev]);

    const changed = JSON.stringify(doc.draft) !== JSON.stringify(doc.published);
    const dirty = JSON.stringify(fields) !== JSON.stringify(toFields(doc.draft));

    async function save() {
        const draft: Record<string, unknown> = {};
        for (const f of fields) {
            if (!f.structured) {
                draft[f.key] = f.text;
                continue;
            }
            try {
                draft[f.key] = JSON.parse(f.text);
            } catch {
                setError(`"${label(f.key)}" isn't valid yet. Check the brackets and quotes.`);
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
                        {doc.kind} · {fields.length} {fields.length === 1 ? "field" : "fields"}
                    </span>
                </span>
                <span className={`chip ${changed ? "chip-draft" : "chip-live"}`}>{changed ? "Draft" : "Published"}</span>
            </button>
            {open && (
                <div className="doc-body">
                    {fields.length === 0 && <p className="muted">This document is empty.</p>}
                    {fields.map((f, i) => (
                        <label key={f.key} className="field">
                            <span className="eyebrow">{label(f.key)}</span>
                            <textarea
                                className={f.structured ? "mono" : ""}
                                value={f.text}
                                spellCheck={!f.structured}
                                rows={Math.min(
                                    f.structured ? 12 : 8,
                                    Math.max(1, Math.ceil(f.text.length / 34), f.text.split("\n").length),
                                )}
                                onChange={(e) => setFields((prev) => prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                            />
                        </label>
                    ))}
                    {error && <p className="doc-error">{error}</p>}
                    <div className="doc-foot">
                        <span className="mono muted">
                            rev {doc.rev} · {timeAgo(doc.updatedAt)}
                        </span>
                        <button type="button" className="btn btn-sm btn-primary" disabled={saving || !dirty} onClick={save}>
                            Save draft
                        </button>
                    </div>
                </div>
            )}
        </li>
    );
}
