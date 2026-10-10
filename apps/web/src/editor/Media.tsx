import { FileText, Film, ImagePlus, Music, PencilLine, Trash2, Upload } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MediaLibrary as Library, MediaAsset, orgApi } from "../lib/api";
import { ApiError } from "../lib/api";
import { Dialog, Dots, useToast } from "../ui/kit";

// A website's pictures and files (ADR-0014 §5): the library on the Content page,
// and the chooser an image field opens. Both need to know which website they are
// for, which the page they sit in provides.

interface Scope {
    a: ReturnType<typeof orgApi>;
    projectId: string;
    canEdit: boolean;
}
const MediaScope = createContext<Scope | null>(null);
export function MediaProvider({ children, a, projectId, canEdit }: Scope & { children: ReactNode }) {
    // One object for as long as the website and the person's rights stay the same.
    const scope = useMemo(() => ({ a, projectId, canEdit }), [a, projectId, canEdit]);
    return <MediaScope.Provider value={scope}>{children}</MediaScope.Provider>;
}
export const useMedia = () => useContext(MediaScope);

const megabytes = (bytes: number): string =>
    bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ACCEPT =
    "image/jpeg,image/png,image/webp,image/avif,image/gif,image/svg+xml,application/pdf,video/mp4,video/webm,audio/mpeg,audio/mp4";
const kindWord = { image: "Picture", video: "Video", audio: "Sound", document: "Document" } as const;

function useLibrary(scope: Scope | null) {
    const [library, setLibrary] = useState<Library | null>(null);
    const load = useCallback(async () => {
        if (!scope) return;
        setLibrary(
            await scope.a
                .listMedia(scope.projectId)
                .catch(() => ({ enabled: false, assets: [], used: 0, limits: { fileBytes: 0, libraryBytes: 0, files: 0 } })),
        );
    }, [scope]);
    useEffect(() => {
        void load();
    }, [load]);
    return { library, load };
}

export function Thumb({ asset }: { asset: MediaAsset }) {
    const scope = useMedia();
    if (asset.kind === "image" && scope) return <img src={scope.a.mediaUrl(scope.projectId, asset)} alt={asset.alt} loading="lazy" />;
    const Icon = asset.kind === "video" ? Film : asset.kind === "audio" ? Music : FileText;
    return (
        <span className="media-icon">
            <Icon />
        </span>
    );
}

// Asked of every picture before it is added: what it shows, or that it is only decoration.
function Describe({
    title,
    preview,
    initial,
    action,
    busy,
    onDone,
    onClose,
}: {
    title: string;
    preview: ReactNode;
    initial: { alt: string; decorative: boolean };
    action: string;
    busy: boolean;
    onDone: (about: { alt: string; decorative: boolean }) => void;
    onClose: () => void;
}) {
    const [alt, setAlt] = useState(initial.alt);
    const [decorative, setDecorative] = useState(initial.decorative);
    const ready = decorative || alt.trim().length > 0;
    return (
        <Dialog onClose={onClose}>
            <h2 className="display">{title}</h2>
            <div className="media-describe">
                <div className="media-describe-preview">{preview}</div>
                <div className="field">
                    <label htmlFor="media-alt" className="eyebrow">
                        What does this picture show?
                    </label>
                    <textarea
                        id="media-alt"
                        rows={3}
                        value={decorative ? "" : alt}
                        disabled={decorative}
                        onChange={(e) => setAlt(e.target.value)}
                        placeholder="The shop front on a sunny morning, with pots in the window"
                        autoFocus
                    />
                    <span className="field-help">
                        One sentence. People who cannot see the picture hear this read out, and search engines read it too.
                    </span>
                </div>
                <label className="check">
                    <input type="checkbox" checked={decorative} onChange={(e) => setDecorative(e.target.checked)} />
                    <span>This picture is only decoration (a pattern, a divider) and says nothing a visitor would miss</span>
                </label>
            </div>
            <div className="dialog-actions">
                <button type="button" className="btn" onClick={onClose} disabled={busy}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!ready || busy}
                    onClick={() => onDone({ alt: alt.trim(), decorative })}
                >
                    {busy ? <Dots /> : action}
                </button>
            </div>
        </Dialog>
    );
}

// Adds files one at a time: pictures are described first; other files go straight in.
function useUploads(scope: Scope | null, onAdded: (asset: MediaAsset) => void) {
    const toast = useToast();
    const [queue, setQueue] = useState<File[]>([]);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const current = queue[0];

    const send = useCallback(
        async (file: File, about: { alt: string; decorative: boolean }) => {
            if (!scope) return;
            setBusy(true);
            try {
                onAdded(await scope.a.uploadMedia(scope.projectId, file, about));
                toast(`“${file.name}” was added.`);
            } catch (err) {
                toast(`“${file.name}” was not added: ${(err as Error).message}`, "error");
            } finally {
                setBusy(false);
                setQueue((q) => q.slice(1));
            }
        },
        [scope, onAdded, toast],
    );
    // Files that are not pictures need no description.
    useEffect(() => {
        if (current && !busy && !current.type.startsWith("image/")) void send(current, { alt: "", decorative: false });
    }, [current, busy, send]);

    const add = (files: FileList | File[] | null) => {
        // Copied now: a file input's list empties as soon as the input is cleared.
        const picked = Array.from(files ?? []);
        setQueue((q) => [...q, ...picked]);
    };
    const control = (
        <>
            <input
                ref={input}
                type="file"
                accept={ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                    add(e.target.files);
                    e.target.value = "";
                }}
            />
            {current?.type.startsWith("image/") && (
                <Describe
                    key={`${current.name}:${current.size}:${queue.length}`}
                    title={queue.length > 1 ? `Add “${current.name}” (${queue.length} left)` : `Add “${current.name}”`}
                    preview={<LocalPreview file={current} />}
                    initial={{ alt: "", decorative: false }}
                    action="Add to the library"
                    busy={busy}
                    onDone={(about) => void send(current, about)}
                    onClose={() => setQueue((q) => q.slice(1))}
                />
            )}
        </>
    );
    return { control, choose: () => input.current?.click(), add, busy: busy || queue.length > 0 };
}

function LocalPreview({ file }: { file: File }) {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        const made = URL.createObjectURL(file);
        setUrl(made);
        return () => URL.revokeObjectURL(made);
    }, [file]);
    return url ? <img src={url} alt="" /> : null;
}

const NotSetUp = () => (
    <div className="media-empty">
        <h3 className="display">Uploading files is not switched on yet.</h3>
        <p className="muted">Whoever runs this Atelier needs to connect file storage first. Until then, wording can still be edited.</p>
    </div>
);

// The library itself: everything uploaded for this website.
export function MediaLibrary() {
    const scope = useMedia();
    const toast = useToast();
    const { library, load } = useLibrary(scope);
    const uploads = useUploads(scope, () => void load());
    const [describing, setDescribing] = useState<MediaAsset | null>(null);
    const [removing, setRemoving] = useState<{ asset: MediaAsset; usedIn: string | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const [over, setOver] = useState(false);
    if (!scope) return null;
    if (!library) return <Dots />;
    if (!library.enabled) return <NotSetUp />;
    const { a, projectId, canEdit } = scope;

    const remove = async (asset: MediaAsset, anyway: boolean) => {
        setBusy(true);
        try {
            await a.removeMedia(projectId, asset.id, anyway);
            toast(`“${asset.name}” was removed from the library.`);
            setRemoving(null);
            await load();
        } catch (err) {
            // In use: say where, and let the person decide.
            if (err instanceof ApiError && err.status === 409) setRemoving({ asset, usedIn: err.message });
            else toast((err as Error).message, "error");
        } finally {
            setBusy(false);
        }
    };

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is an extra; the button does the same
        <div
            className={`media ${over ? "media-over" : ""}`}
            onDragOver={(e) => {
                if (!canEdit) return;
                e.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
                if (!canEdit) return;
                e.preventDefault();
                setOver(false);
                uploads.add(e.dataTransfer.files);
            }}
        >
            {uploads.control}
            <div className="media-head">
                <p className="muted">
                    Pictures, PDFs and short clips for this website. A file is private until you publish a page that uses it. To use one,
                    choose it in a picture field, or tell your assistant which one you mean.
                </p>
                {canEdit && (
                    <button type="button" className="btn btn-primary" onClick={uploads.choose} disabled={uploads.busy}>
                        <Upload /> Upload files
                    </button>
                )}
            </div>
            {library.assets.length === 0 ? (
                <div className="media-empty">
                    <h3 className="display">No files yet.</h3>
                    <p className="muted">
                        {canEdit
                            ? "Upload photographs, a logo or a menu, or drop them anywhere here."
                            : "Nothing has been uploaded for this website."}
                    </p>
                </div>
            ) : (
                <ul className="media-grid">
                    {library.assets.map((asset) => (
                        <li key={asset.id}>
                            <div className="media-thumb">
                                <Thumb asset={asset} />
                            </div>
                            <strong title={asset.name}>{asset.name}</strong>
                            <span className="muted">
                                {kindWord[asset.kind]}
                                {asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ""} · {megabytes(asset.bytes)}
                            </span>
                            {asset.kind === "image" && (
                                <span className={asset.alt || asset.decorative ? "media-alt" : "media-alt media-alt-missing"}>
                                    {asset.decorative ? "Decoration only" : asset.alt || "No description yet"}
                                </span>
                            )}
                            {canEdit && (
                                <span className="media-actions">
                                    {asset.kind === "image" && (
                                        <button type="button" className="btn btn-sm" onClick={() => setDescribing(asset)}>
                                            <PencilLine /> Change description
                                        </button>
                                    )}
                                    <button type="button" className="btn btn-sm" onClick={() => void remove(asset, false)} disabled={busy}>
                                        <Trash2 /> Remove
                                    </button>
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <p className="mono muted media-used">
                {library.assets.length} {library.assets.length === 1 ? "file" : "files"} · {megabytes(library.used)} of{" "}
                {megabytes(library.limits.libraryBytes)} used · up to {megabytes(library.limits.fileBytes)} each
            </p>

            {describing && (
                <Describe
                    title="Describe this picture"
                    preview={<Thumb asset={describing} />}
                    initial={{ alt: describing.alt, decorative: describing.decorative }}
                    action="Save description"
                    busy={busy}
                    onClose={() => setDescribing(null)}
                    onDone={async (about) => {
                        setBusy(true);
                        try {
                            await a.describeMedia(projectId, describing.id, about);
                            setDescribing(null);
                            await load();
                        } catch (err) {
                            toast((err as Error).message, "error");
                        } finally {
                            setBusy(false);
                        }
                    }}
                />
            )}
            {removing?.usedIn && (
                <Dialog onClose={() => setRemoving(null)}>
                    <h2 className="display">This file is in use.</h2>
                    <p>{removing.usedIn}.</p>
                    <p className="muted">
                        If you remove it, pages that use it will show a broken picture the next time you publish. The website that is live
                        now is not affected until then.
                    </p>
                    <div className="dialog-actions">
                        <button type="button" className="btn btn-primary" onClick={() => setRemoving(null)}>
                            Keep it
                        </button>
                        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(removing.asset, true)}>
                            Remove it anyway
                        </button>
                    </div>
                </Dialog>
            )}
        </div>
    );
}

// Choosing a picture for a field: one from the library, or a new upload.
export function MediaPicker({ current, onPick, onClose }: { current: string; onPick: (path: string) => void; onClose: () => void }) {
    const scope = useMedia();
    const { library, load } = useLibrary(scope);
    const uploads = useUploads(scope, (asset) => {
        void load();
        if (asset.kind === "image") onPick(asset.path);
    });
    const pictures = (library?.assets ?? []).filter((x) => x.kind === "image");
    return (
        <Dialog onClose={onClose} wide>
            <h2 className="display">Choose a picture</h2>
            {uploads.control}
            {!library ? (
                <Dots />
            ) : !library.enabled ? (
                <NotSetUp />
            ) : (
                <>
                    {pictures.length === 0 ? (
                        <p className="muted">There are no pictures in this website's library yet. Upload one to use it here.</p>
                    ) : (
                        <ul className="media-grid media-pick">
                            {pictures.map((asset) => (
                                <li key={asset.id}>
                                    <button type="button" className={asset.path === current ? "on" : ""} onClick={() => onPick(asset.path)}>
                                        <span className="media-thumb">
                                            <Thumb asset={asset} />
                                        </span>
                                        <strong>{asset.decorative ? asset.name : asset.alt || asset.name}</strong>
                                        {asset.path === current && <span className="chip chip-seal">In use here</span>}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="dialog-actions">
                        <button type="button" className="btn" onClick={onClose}>
                            Cancel
                        </button>
                        {scope?.canEdit && (
                            <button type="button" className="btn btn-primary" onClick={uploads.choose} disabled={uploads.busy}>
                                <ImagePlus /> Upload a new picture
                            </button>
                        )}
                    </div>
                </>
            )}
        </Dialog>
    );
}

// A picture field in the wording form: what is chosen now, and a way to change it.
export function PictureField({ value, onChange, readOnly }: { value: string; onChange: (path: string) => void; readOnly: boolean }) {
    const scope = useMedia();
    const { library } = useLibrary(scope);
    const [choosing, setChoosing] = useState(false);
    const asset = library?.assets.find((x) => x.path === value);
    return (
        <div className="picture-field">
            <div className="media-thumb">
                {asset ? (
                    <Thumb asset={asset} />
                ) : (
                    <span className="muted">{value ? "This picture is no longer in the library" : "No picture chosen"}</span>
                )}
            </div>
            <div>
                {asset && <p className="media-alt">{asset.decorative ? "Decoration only" : asset.alt || "No description yet"}</p>}
                {!readOnly && scope && (
                    <button type="button" className="btn btn-sm" onClick={() => setChoosing(true)}>
                        <ImagePlus /> {value ? "Choose a different picture" : "Choose a picture"}
                    </button>
                )}
            </div>
            {choosing && (
                <MediaPicker
                    current={value}
                    onClose={() => setChoosing(false)}
                    onPick={(path) => {
                        onChange(path);
                        setChoosing(false);
                    }}
                />
            )}
        </div>
    );
}
