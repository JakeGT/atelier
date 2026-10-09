import { PROVIDERS, type Provider } from "./providers.ts";

// The model catalog behind the model picker. It comes from models.dev (the same
// open catalog OpenCode uses), so new models appear without a release of Atelier,
// and "recommended" is computed from it rather than typed in by hand and left to rot.

export interface CatalogModel {
    // "<provider>/<model>": what a studio or website's model setting holds.
    ref: string;
    provider: string;
    id: string;
    name: string;
    family: string | null;
    releaseDate: string | null;
    contextWindow: number | null;
    // US dollars per million tokens, when the catalog knows.
    costIn: number | null;
    costOut: number | null;
    reasoning: boolean;
    vision: boolean;
    // One of the newest models from a lab, chosen by `recommend` below.
    recommended: boolean;
    // Among a lab's recommended models: the most capable, the cheapest, or neither.
    tier: "best" | "fast" | null;
}

export interface Catalog {
    models: CatalogModel[];
    fetchedAt: string | null;
    // True when the catalog could not be fetched (the picker then offers typing a model by hand).
    unavailable: boolean;
}

interface RawModel {
    id?: string;
    name?: string;
    family?: string | null;
    release_date?: string;
    tool_call?: boolean;
    reasoning?: boolean;
    status?: string | null;
    cost?: { input?: number; output?: number } | null;
    limit?: { context?: number } | null;
    modalities?: { input?: string[]; output?: string[] } | null;
}
type RawCatalog = Record<string, { models?: Record<string, RawModel> } | undefined>;

// Not what you build a website with, whatever their release date.
const NOT_FOR_BUILDING =
    /embed|tts|whisper|audio|realtime|image|vision-only|moderation|safeguard|guard|research|transcri|rerank|ocr|search/i;
const RECOMMENDED_PER_LAB = 4;
const RECENT_DAYS = 400;

// The assistant edits files with tools, so a model must support tool calls and
// produce text. Deprecated and alpha models are left out.
function usable(m: RawModel): boolean {
    if (!m.id || !m.tool_call) return false;
    if (m.status === "deprecated" || m.status === "alpha") return false;
    const out = m.modalities?.output;
    if (out && !(out.length === 1 && out[0] === "text")) return false;
    return !NOT_FOR_BUILDING.test(m.id);
}

export function buildCatalog(raw: RawCatalog, providers: readonly Provider[] = PROVIDERS, now = new Date()): CatalogModel[] {
    const models: CatalogModel[] = [];
    for (const provider of providers) {
        const list = Object.values(raw[provider.id]?.models ?? {}).filter(usable);
        const mine: CatalogModel[] = list.map((m) => ({
            ref: `${provider.id}/${m.id}`,
            provider: provider.id,
            id: m.id ?? "",
            name: m.name ?? m.id ?? "",
            family: m.family ?? null,
            releaseDate: m.release_date?.slice(0, 10) ?? null,
            contextWindow: m.limit?.context ?? null,
            costIn: m.cost?.input ?? null,
            costOut: m.cost?.output ?? null,
            reasoning: m.reasoning === true,
            vision: m.modalities?.input?.includes("image") === true,
            recommended: false,
            tier: null,
        }));
        if (provider.lab) recommend(mine, provider.ownFamilies, now);
        models.push(...mine);
    }
    return models;
}

// For a lab: the newest model of each family (its current Opus, Sonnet, Haiku…),
// released recently, newest first, capped. "-latest" aliases and previews lose to
// a dated release of the same family. Among those, the dearest is marked "best"
// and the cheapest "fast".
function recommend(models: CatalogModel[], ownFamilies: RegExp | undefined, now: Date): void {
    const stable = (m: CatalogModel) => !/preview|latest|exp\b|experimental|beta/i.test(m.id);
    const newestByFamily = new Map<string, CatalogModel>();
    for (const m of models) {
        if (!m.releaseDate) continue;
        // The lab's own lines only, and only models with a price: a free or unpriced
        // model may be useful, but it is not what "top model" means.
        if (ownFamilies && !ownFamilies.test(m.family ?? m.id)) continue;
        if (!m.costOut) continue;
        const key = m.family ?? m.id;
        const current = newestByFamily.get(key);
        const better =
            !current ||
            (stable(m) && !stable(current)) ||
            (stable(m) === stable(current) &&
                (m.releaseDate > (current.releaseDate ?? "") || (m.releaseDate === current.releaseDate && m.id < current.id)));
        if (better) newestByFamily.set(key, m);
    }
    const cutoff = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
    const picks = [...newestByFamily.values()]
        .filter((m) => stable(m) && (m.releaseDate ?? "") >= cutoff)
        .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
        .slice(0, RECOMMENDED_PER_LAB);
    for (const m of picks) m.recommended = true;
    const priced = picks.filter((m) => m.costOut !== null);
    if (priced.length >= 2) {
        const byCost = [...priced].sort((a, b) => (a.costOut ?? 0) - (b.costOut ?? 0));
        const fast = byCost[0];
        const best = byCost.at(-1);
        if (fast && best && fast.costOut !== best.costOut) {
            fast.tier = "fast";
            best.tier = "best";
        }
    }
}

const SOURCE = "https://models.dev/api.json";
const FRESH_MS = 6 * 3_600_000;
const RETRY_MS = 5 * 60_000;

// Fetched on first use and every few hours after. If models.dev is unreachable the
// last good copy keeps being served; with no copy at all the catalog is marked
// unavailable rather than failing the page.
export class ModelCatalog {
    private models: CatalogModel[] = [];
    private fetchedAt = 0;
    private lastAttempt = 0;
    private inflight: Promise<void> | null = null;
    private readonly fetch: typeof fetch;

    constructor(fetchImpl: typeof fetch = fetch) {
        this.fetch = fetchImpl;
    }

    async get(): Promise<Catalog> {
        const now = Date.now();
        const stale = now - this.fetchedAt > FRESH_MS;
        if (stale && now - this.lastAttempt > RETRY_MS) {
            this.lastAttempt = now;
            this.inflight ??= this.refresh().finally(() => {
                this.inflight = null;
            });
        }
        // Wait only when there is nothing to show yet.
        if (this.fetchedAt === 0 && this.inflight) await this.inflight;
        return {
            models: this.models,
            fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
            unavailable: this.fetchedAt === 0,
        };
    }

    private async refresh(): Promise<void> {
        try {
            const res = await this.fetch(SOURCE, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
            if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
            const models = buildCatalog((await res.json()) as RawCatalog);
            if (models.length === 0) throw new Error("models.dev returned no usable models");
            this.models = models;
            this.fetchedAt = Date.now();
        } catch (err) {
            console.warn(`Could not refresh the model catalog: ${(err as Error).message}`);
        }
    }
}
