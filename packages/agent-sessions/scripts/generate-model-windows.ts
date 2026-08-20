/**
 * Regenerates src/model-windows.generated.ts from models.dev.
 *
 *   bun scripts/generate-model-windows.ts
 *
 * models.dev (https://models.dev/api.json) is a community catalog of per-model
 * metadata — including context windows — aggregated across ~140 providers. We
 * mirror it (like the `pi` harness does) so our fallback windows come from real,
 * auto-updatable data rather than hand-kept constants. Harness-specific caps
 * (e.g. Codex's reduced budget) and a learned registry layer OVER this catalog;
 * see model-catalog.ts.
 *
 * We keep only the model families our harnesses actually surface (Claude, GPT/o,
 * Codex, Grok, Gemini, MiniMax, Mistral) plus everything under those native
 * providers, so the generated map stays small enough to ride the browser bundle.
 */
const SOURCE = "https://models.dev/api.json";

// Authoritative native providers ONLY. Aggregator/reseller providers carry
// inconsistent or wrong windows (e.g. listing Sonnet 4.5 at 1M when Anthropic
// says 200k), so taking a max across all 144 providers corrupts the data. The
// model's own provider is the source of truth.
const NATIVE_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "xai",
  "google",
  "google-vertex",
  "minimax",
  "minimax-coding-plan",
  "mistral",
]);

// Canonicalize a model id for stable matching: lower-case and fold the version
// separators "." and "_" to "-" (models.dev mixes "gpt-5.5" / "gpt-5-5").
function canonical(id: string): string {
  return id.trim().toLowerCase().replace(/[._]/gu, "-");
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
const data = (await res.json()) as Record<string, { models?: Record<string, { limit?: { context?: number } }> }>;

const windows = new Map<string, number>();
let providerCount = 0;
for (const [providerId, provider] of Object.entries(data)) {
  providerCount += 1;
  if (!NATIVE_PROVIDERS.has(providerId)) continue;
  const models = provider.models ?? {};
  for (const [id, model] of Object.entries(models)) {
    const ctx = model?.limit?.context;
    if (typeof ctx !== "number" || ctx <= 0) continue;
    const key = canonical(id);
    windows.set(key, Math.max(windows.get(key) ?? 0, ctx));
  }
}

const sorted = [...windows.entries()].sort(([a], [b]) => a.localeCompare(b));
const body = sorted.map(([k, v]) => `  ${JSON.stringify(k)}: ${v},`).join("\n");
const out = `// AUTO-GENERATED — do not edit by hand.
// Source: ${SOURCE} (community model-metadata catalog, ~${providerCount} providers)
// Regenerate: bun scripts/generate-model-windows.ts
//
// Raw per-model context windows, keyed by lower-cased model id. This is the
// FALLBACK catalog; a transcript-logged window, the learned registry, and
// harness-specific caps (Codex) all take precedence — see model-catalog.ts.
// ${sorted.length} models.
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
${body}
};
`;

await Bun.write("src/model-windows.generated.ts", out);
console.log(`wrote ${sorted.length} models from ${providerCount} providers`);
