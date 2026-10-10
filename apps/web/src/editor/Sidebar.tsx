import { ArrowRight, PencilLine, Undo2 } from "lucide-react";
import { useState } from "react";
import type { Checkpoint, ContentDocument, Release } from "../lib/api";
import { navigate, timeAgo } from "../lib/hooks";
import { MediaLibrary } from "./Media";
import { countPieces, documentName, WordingDialog } from "./Wording";

export type Tab = "versions" | "releases" | "content" | "files";

interface SidebarProps {
    tab: Tab;
    onTab: (t: Tab) => void;
    checkpoints: Checkpoint[];
    releases: Release[];
    documents: ContentDocument[];
    busy: boolean;
    canPublish: boolean;
    canEdit: boolean;
    // Changes when a file is added outside this panel.
    filesKey: number;
    // The page that manages all of a website's content.
    contentHref: string;
    onRestore: (sha: string) => void;
    onRollback: (number: number) => void;
    onSaveDocument: (doc: ContentDocument, draft: Record<string, unknown>) => Promise<void>;
}

const TABS: { id: Tab; label: string }[] = [
    { id: "versions", label: "Versions" },
    { id: "releases", label: "Published" },
    { id: "content", label: "Wording" },
    { id: "files", label: "Pictures" },
];

// One line under the tabs saying what this list is and what you can do with it.
const ABOUT: Record<Tab, string> = {
    versions: "Every change your assistant makes is saved here. Choose one to go back to it. Nothing here is public until you publish.",
    releases: "Each time you publish, it is recorded here. You can put an earlier one back.",
    content: "The words on your website that you can change yourself, without asking your assistant.",
    files: "",
};

export function Sidebar(props: SidebarProps) {
    const { tab, onTab, checkpoints, releases, documents } = props;
    const counts: Record<Tab, number> = { versions: checkpoints.length, releases: releases.length, content: documents.length, files: 0 };
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
                {ABOUT[tab] && <p className="side-about">{ABOUT[tab]}</p>}
                {tab === "versions" && <Versions {...props} />}
                {tab === "releases" && <Releases {...props} />}
                {tab === "content" && <Content {...props} />}
                {/* Remounted when a file is added from elsewhere (beside the message box), so it shows at once. */}
                {tab === "files" && <MediaLibrary key={props.filesKey} />}
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

function Content({ documents, canEdit, onSaveDocument, contentHref }: SidebarProps) {
    const more = (
        <a
            className="btn btn-sm side-more"
            href={contentHref}
            onClick={(e) => {
                e.preventDefault();
                navigate(contentHref);
            }}
        >
            Manage all content on its own page <ArrowRight />
        </a>
    );
    if (documents.length === 0) {
        return (
            <Empty
                title="No wording yet."
                body="When your assistant writes headlines, introductions or details like opening hours, they appear here for you to edit."
            />
        );
    }
    return (
        <>
            <ul className="docs">
                {documents.map((d) => (
                    <Document key={d.id} doc={d} canEdit={canEdit} onSave={onSaveDocument} />
                ))}
            </ul>
            {more}
        </>
    );
}

function Document({ doc, canEdit, onSave }: { doc: ContentDocument; canEdit: boolean; onSave: SidebarProps["onSaveDocument"] }) {
    const [open, setOpen] = useState(false);
    const count = countPieces(doc);
    const changed = JSON.stringify(doc.draft) !== JSON.stringify(doc.published);
    return (
        <li>
            <button type="button" className="doc-head" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Open to edit">
                <PencilLine />
                <span className="doc-name">
                    <strong>{documentName(doc)}</strong>
                    <span className="mono muted">
                        {count} {count === 1 ? "piece of wording" : "pieces of wording"}
                    </span>
                </span>
                <span className={`chip ${changed ? "chip-draft" : "chip-live"}`}>{changed ? "Not published yet" : "Published"}</span>
            </button>
            {open && <WordingDialog doc={doc} canEdit={canEdit} onSave={onSave} onClose={() => setOpen(false)} />}
        </li>
    );
}
