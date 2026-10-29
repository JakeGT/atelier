import { ChevronsUpDown, KeyRound, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CatalogModel, ModelList, OrgApi } from "../lib/api";
import { navigate } from "../lib/hooks";
import { Dots, keepTabInside } from "./kit";

interface Props {
    api: OrgApi;
    orgSlug: string;
    // "<provider>/<model>", or null for `automatic`.
    value: string | null;
    onChange: (value: string | null) => void;
    // What "no choice" means here: the studio's default, or the assistant's own.
    automatic: string;
    automaticHint: string;
    disabled?: boolean;
    // Owners and admins are offered a way to connect a provider; others are told who can.
    mayManage: boolean;
    // Bumped by the caller when providers were connected or removed.
    refresh?: number;
}

const perMillion = (n: number): string => (n === 0 ? "free" : n >= 10 ? `$${Math.round(n)}` : `$${Number(n.toFixed(2))}`);
const windowSize = (n: number): string => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}K`);
// A reference typed by hand: provider/model, for a model the catalog doesn't list yet.
// (Some providers' own names for models have a "/" in them, so the model part may too.)
const TYPED = /^[a-z0-9-]+\/[\w.:\-/@]+$/;
// The most matches listed for a search.
const MOST = 60;
// The provider's part of "<provider>/<model>", and the model's.
const providerOf = (ref: string): string => ref.slice(0, Math.max(0, ref.indexOf("/")));
const modelOf = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

// The model setting: shows the current choice and opens a searchable picker.
// With nothing typed the picker shows the recommended models (the newest from
// each lab); typing searches every model from every provider.
export function ModelPicker({ api, orgSlug, value, onChange, automatic, automaticHint, disabled, mayManage, refresh = 0 }: Props) {
    const [list, setList] = useState<ModelList | null>(null);
    const [open, setOpen] = useState(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is the caller's signal to load again
    useEffect(() => {
        let live = true;
        api.models().then(
            (l) => live && setList(l),
            () => live && setList({ providers: [], models: [], unavailable: true }),
        );
        return () => {
            live = false;
        };
    }, [api, refresh]);

    const chosen = value ? list?.models.find((m) => m.ref === value) : undefined;
    const provider = value ? list?.providers.find((p) => p.id === providerOf(value)) : undefined;
    return (
        <>
            <button type="button" className="model-trigger" onClick={() => setOpen(true)} disabled={disabled} aria-haspopup="dialog">
                <span className="model-trigger-main">
                    {value ? (
                        <>
                            <strong>{chosen?.name ?? modelOf(value)}</strong>
                            <span className="muted">{provider?.name ?? providerOf(value)}</span>
                        </>
                    ) : (
                        <strong className="model-auto">{automatic}</strong>
                    )}
                </span>
                {value && provider && !provider.connected && <span className="chip chip-draft">No key</span>}
                <ChevronsUpDown />
            </button>
            {open && (
                <Picker
                    list={list}
                    value={value}
                    automatic={automatic}
                    automaticHint={automaticHint}
                    mayManage={mayManage}
                    orgSlug={orgSlug}
                    onClose={() => setOpen(false)}
                    onPick={(v) => {
                        onChange(v);
                        setOpen(false);
                    }}
                />
            )}
        </>
    );
}

interface PickerProps {
    list: ModelList | null;
    value: string | null;
    automatic: string;
    automaticHint: string;
    mayManage: boolean;
    orgSlug: string;
    onClose: () => void;
    onPick: (value: string | null) => void;
}

type Row = { kind: "auto" } | { kind: "typed"; ref: string } | { kind: "model"; model: CatalogModel };

function Picker({ list, value, automatic, automaticHint, mayManage, orgSlug, onClose, onPick }: PickerProps) {
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<string>("all");
    const [cursor, setCursor] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    // Nothing at all could be fetched, so which providers there are is not known: a model
    // typed out is taken as it is, and the server says if it cannot be used.
    const blind = list?.unavailable === true && list.providers.length === 0;

    const providers = useMemo(() => new Map((list?.providers ?? []).map((p) => [p.id, p])), [list]);
    const connected = useMemo(() => (list?.providers ?? []).filter((p) => p.connected), [list]);
    const q = query.trim().toLowerCase();

    const { rows, groups, total } = useMemo(() => {
        const usable = (m: CatalogModel) => providers.get(m.provider)?.connected === true;
        const inScope = (m: CatalogModel) => scope === "all" || (scope === "connected" ? usable(m) : m.provider === scope);
        const all = (list?.models ?? []).filter(inScope);
        // Connected providers first, then recommended, then newest.
        const order = (a: CatalogModel, b: CatalogModel) =>
            Number(usable(b)) - Number(usable(a)) ||
            Number(b.recommended) - Number(a.recommended) ||
            (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
        const out: Row[] = [];
        const heads = new Map<number, string>();
        if (!q) {
            if (scope === "all" || scope === "connected") out.push({ kind: "auto" });
            // Nothing typed: the recommended models, a provider at a time. Within a
            // single provider, everything it has.
            const single = scope !== "all" && scope !== "connected";
            const shown = all.filter((m) => single || m.recommended).sort(order);
            const byProvider = new Map<string, CatalogModel[]>();
            for (const m of shown) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
            for (const [id, models] of byProvider) {
                heads.set(out.length, providers.get(id)?.name ?? id);
                const tierRank = (m: CatalogModel) => (m.tier === "best" ? 0 : m.tier === "fast" ? 2 : 1);
                const sorted = single
                    ? models
                    : [...models].sort((a, b) => tierRank(a) - tierRank(b) || (b.costOut ?? 0) - (a.costOut ?? 0));
                for (const model of sorted.slice(0, single ? 80 : 4)) out.push({ kind: "model", model });
            }
            return { rows: out, groups: heads, total: all.length };
        }
        const words = q.split(/\s+/);
        const hay = (m: CatalogModel) => `${m.name} ${m.id} ${providers.get(m.provider)?.name ?? ""} ${m.provider}`.toLowerCase();
        const matches = all.filter((m) => {
            const h = hay(m);
            return words.every((w) => h.includes(w));
        });
        // A name that starts with what was typed beats one that merely contains it.
        const starts = (m: CatalogModel) => Number(m.name.toLowerCase().startsWith(q) || m.id.toLowerCase().startsWith(q));
        matches.sort((a, b) => starts(b) - starts(a) || order(a, b));
        for (const model of matches.slice(0, MOST)) out.push({ kind: "model", model });
        const typed = query.trim();
        if (TYPED.test(typed) && (blind || providers.has(providerOf(typed))) && !matches.some((m) => m.ref === typed)) {
            out.push({ kind: "typed", ref: typed });
        }
        return { rows: out, groups: heads, total: matches.length };
    }, [list, providers, q, query, scope, blind]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new search or scope starts again from the top
    useEffect(() => setCursor(0), [q, scope]);
    useEffect(() => {
        listRef.current?.querySelector(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
    }, [cursor]);

    const usable = (row: Row): boolean => {
        if (row.kind === "auto") return true;
        if (row.kind === "typed" && blind) return true;
        return providers.get(row.kind === "model" ? row.model.provider : providerOf(row.ref))?.connected === true;
    };
    const toKeys = () => {
        onClose();
        navigate(`/o/${orgSlug}/settings/models`);
    };
    // Choosing a row, by click or by Enter: a model that can be used is chosen; one whose
    // provider has no key yet leads to where the key is added, for those who may add it.
    const pick = (row: Row | undefined) => {
        if (!row) return;
        if (!usable(row)) {
            if (mayManage) toKeys();
            return;
        }
        if (row.kind === "auto") onPick(null);
        else onPick(row.kind === "typed" ? row.ref : row.model.ref);
    };

    // Rendered at the top of the document: an ancestor with a transform (an animated
    // panel, a dialog) would otherwise become what "fixed" is measured from.
    return createPortal(
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only dismisses; Escape does the same for keyboards
        <div
            className="scrim scrim-top"
            role="presentation"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    // Only this picker closes, not a dialog it was opened from.
                    e.stopPropagation();
                    onClose();
                } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    // Never below the first row, even while there are no rows yet.
                    setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + 1)));
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCursor((c) => Math.max(0, c - 1));
                } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
                    // From the search box, Enter chooses the marked row. On a button it presses that button.
                    e.preventDefault();
                    pick(rows[Math.min(cursor, rows.length - 1)]);
                } else {
                    keepTabInside(e, boxRef.current);
                }
            }}
        >
            <div className="picker" role="dialog" aria-modal="true" aria-label="Choose a model" ref={boxRef}>
                <div className="picker-search">
                    <Search />
                    <input
                        // biome-ignore lint/a11y/noAutofocus: the picker exists to be typed into
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={list?.models.length ? `Search ${list.models.length} models` : "Search models"}
                        aria-label="Search models"
                        spellCheck={false}
                    />
                    {query && (
                        <button type="button" className="btn btn-ghost btn-icon" onClick={() => setQuery("")} aria-label="Clear search">
                            <X />
                        </button>
                    )}
                </div>

                {list && list.providers.length > 0 && (
                    <div className="picker-scopes">
                        {[
                            { id: "all", name: "All" },
                            ...(connected.length ? [{ id: "connected", name: "Connected" }] : []),
                            ...list.providers,
                        ].map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                className={`scope ${scope === p.id ? "on" : ""} ${"connected" in p && p.connected ? "scope-live" : ""}`}
                                onClick={() => setScope(p.id)}
                            >
                                {p.name}
                            </button>
                        ))}
                    </div>
                )}

                <div className="picker-list" ref={listRef}>
                    {list === null ? (
                        <div className="panel-loading">
                            <Dots />
                        </div>
                    ) : (
                        <>
                            {list.unavailable && (
                                <p className="picker-note">
                                    The model list couldn't be loaded just now. You can still type a model as provider/model, for example{" "}
                                    <span className="mono">anthropic/claude-sonnet-5-5</span>.
                                </p>
                            )}
                            {!q && connected.length === 0 && !list.unavailable && (
                                <p className="picker-note picker-note-key">
                                    <KeyRound />
                                    <span>
                                        To choose a model, connect a provider with your own API key.{" "}
                                        {mayManage ? (
                                            <button type="button" className="link" onClick={toKeys}>
                                                Connect a provider
                                            </button>
                                        ) : (
                                            "An owner or admin of this studio can do that in its settings."
                                        )}
                                    </span>
                                </p>
                            )}
                            {rows.map((row, i) => {
                                const head = groups.get(i);
                                const ok = usable(row);
                                const key = row.kind === "model" ? row.model.ref : row.kind;
                                const selected =
                                    row.kind === "auto" ? value === null : (row.kind === "model" ? row.model.ref : row.ref) === value;
                                return (
                                    <div key={key}>
                                        {head && (
                                            <p className="picker-head">
                                                <Sparkles /> {head}
                                                {scope === "all" || scope === "connected" ? (
                                                    <span className="muted"> · recommended</span>
                                                ) : null}
                                            </p>
                                        )}
                                        <button
                                            type="button"
                                            data-i={i}
                                            className={`model-row ${i === cursor ? "cursor" : ""} ${selected ? "selected" : ""} ${ok ? "" : "locked"}`}
                                            onMouseMove={() => setCursor(i)}
                                            onClick={() => pick(row)}
                                            title={ok ? undefined : "Connect this provider with an API key to use its models"}
                                        >
                                            {row.kind === "auto" ? (
                                                <span className="model-name">
                                                    <strong>{automatic}</strong>
                                                    <span className="muted model-hint">{automaticHint}</span>
                                                </span>
                                            ) : row.kind === "typed" ? (
                                                <span className="model-name">
                                                    <strong>Use “{row.ref}”</strong>
                                                    <span className="muted">A model that isn't in the list yet, exactly as typed</span>
                                                </span>
                                            ) : (
                                                <ModelLine
                                                    model={row.model}
                                                    provider={providers.get(row.model.provider)?.name ?? row.model.provider}
                                                    showProvider={!head && !groups.size}
                                                />
                                            )}
                                            {!ok && (
                                                <span className="chip chip-plain">
                                                    <KeyRound /> {mayManage ? "Add key" : "No key"}
                                                </span>
                                            )}
                                        </button>
                                    </div>
                                );
                            })}
                            {q && rows.length === 0 && <p className="picker-note">No model matches “{query.trim()}”.</p>}
                            {q && total > MOST && (
                                <p className="picker-note">
                                    Showing the first {MOST} of {total}. Keep typing to narrow it down.
                                </p>
                            )}
                        </>
                    )}
                </div>
                <div className="picker-foot">
                    <span>
                        <kbd>↑</kbd>
                        <kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>Esc</kbd> to close
                    </span>
                    <span>Prices are per million tokens, in and out</span>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function ModelLine({ model, provider, showProvider }: { model: CatalogModel; provider: string; showProvider: boolean }) {
    return (
        <>
            <span className="model-name">
                <strong>
                    {model.name}
                    {model.tier === "best" && <span className="chip chip-seal chip-plain">Most capable</span>}
                    {model.tier === "fast" && <span className="chip chip-live chip-plain">Fast &amp; cheap</span>}
                </strong>
                <span className="mono muted">
                    {showProvider ? `${provider} · ` : ""}
                    {model.id}
                </span>
            </span>
            <span className="model-facts mono">
                {model.costIn !== null && model.costOut !== null && (
                    <span>
                        {perMillion(model.costIn)} · {perMillion(model.costOut)}
                    </span>
                )}
                {model.contextWindow ? <span className="muted">{windowSize(model.contextWindow)} context</span> : null}
                {/* Whether the assistant can see the pages it builds with this model. */}
                <span className="muted">{model.vision ? "can look at your pages" : "cannot look at pages"}</span>
            </span>
        </>
    );
}
