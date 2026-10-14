/**
 * Model tier → Codex model.
 *
 * Agent Zero asks for a tier (`opus` / `sonnet` / `haiku`); Codex wants a concrete model slug.
 * The slugs churn between Codex releases and differ by what an account is entitled to, so nothing
 * here is hardcoded: `codex debug models` prints the catalog the installed Codex actually has, and
 * the tier picks from it by the catalog's own ranking. When the catalog cannot be read we pass no
 * model at all and let Codex use whatever the user configured, which is always a valid choice.
 */
import type { ModelTier } from "@agnt0/protocol";
import { runCapture } from "./spawn.js";

/** Only the fields we rely on; the catalog carries a lot more. */
interface CatalogModel {
  slug: string;
  /** `list` is user-selectable; `hide` is internal (auto-review, experimental programs). */
  visibility?: string;
  supported_in_api?: boolean;
  /** Lower is better: 1 is the flagship. */
  priority?: number;
  supported_reasoning_levels?: { effort?: string }[];
}

export interface CodexModelChoice {
  /** Passed as `--model`; null means "say nothing and let Codex decide". */
  model: string | null;
  /** Passed as `-c model_reasoning_effort=…`, when the model offers it. */
  reasoningEffort: string | null;
}

/** Reasoning depth per tier, in the order we would prefer it, best first. */
const EFFORT_BY_TIER: Record<ModelTier, string[]> = {
  opus: ["high", "xhigh", "medium"],
  sonnet: ["medium", "high", "low"],
  haiku: ["low", "medium"],
};

export function parseCatalog(stdout: string): CatalogModel[] {
  const parsed: unknown = JSON.parse(stdout);
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is CatalogModel => typeof (m as CatalogModel)?.slug === "string");
}

/** The models a user can actually be given, best first. */
export function selectable(models: CatalogModel[]): CatalogModel[] {
  return models
    .filter((m) => m.visibility === "list" && m.supported_in_api !== false)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Picks a model for a tier out of the catalog: `opus` takes the top-ranked model, `haiku` the
 * lowest-ranked, `sonnet` the middle. Ranking rather than names, so a new Codex release renames
 * everything and this still does something sensible.
 */
export function chooseModel(tier: ModelTier, models: CatalogModel[]): CodexModelChoice {
  const ranked = selectable(models);
  if (!ranked.length) return { model: null, reasoningEffort: null };
  const pick = tier === "opus" ? ranked[0]! : tier === "haiku" ? ranked[ranked.length - 1]! : ranked[Math.floor((ranked.length - 1) / 2)]!;
  const offered = new Set((pick.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is string => !!e));
  const effort = EFFORT_BY_TIER[tier].find((e) => offered.has(e)) ?? null;
  return { model: pick.slug, reasoningEffort: effort };
}

/**
 * Reads the installed Codex's model catalog. Cached for the life of the process: it shells out, and
 * a run leases many steps. A failure is not an error — it just means we name no model.
 */
let cached: Promise<CatalogModel[]> | null = null;
export function resetCatalogCache(): void {
  cached = null;
}

export async function loadCatalog(bin: string): Promise<CatalogModel[]> {
  cached ??= (async () => {
    try {
      const r = await runCapture(bin, ["debug", "models"], { timeoutMs: 20_000 });
      return r.exitCode === 0 ? parseCatalog(r.stdout) : [];
    } catch {
      return [];
    }
  })();
  return cached;
}

export async function modelForTier(bin: string, tier: ModelTier): Promise<CodexModelChoice> {
  return chooseModel(tier, await loadCatalog(bin));
}
