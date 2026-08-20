// OpenScout's feature-flag registry, built on the HudsonKit flags primitive
// (`hudsonkit/flags`). This is the single source of truth for which web
// surfaces are gated and how.
//
// Two families (originally docs/eng/web-launch-surface-triage.md, removed in
// the docs cleanup; see git history):
//   • surface.*  tier "everyone", default OFF — pure declutter. Flipped on
//                per-deploy/per-user as a surface matures.
//   • ops.*      tier "power", default ON but audience-gated — the ops /
//                observability cluster. Visible to power audiences, hidden for
//                a clean public launch. "Gated by who you are", not a URL flag.
// Core surfaces (Agents · Chat · Tail · Dispatch · Repos + Home/Settings) carry
// no flag — they always render.
//
// The nav is single-personality (Home · Projects · Sessions · Chat + System
// dropdown); the old `nav.clean` layout switch is gone. `ops.control` gates
// the ops section of that dropdown (replacing the old `isOpsEnabled()` URL
// boolean). The remaining surface.*/ops.* keys are declared so the dev panel +
// registry are complete; the per-surface gating that makes each one bite is
// follow-up work.

import {
  createFlagRegistry,
  createFlagResolver,
  parseFeatureFlagUrl,
  readFeatureFlagLocalState,
  type FeatureFlagAudience,
  type FeatureFlagLayerInput,
  type FeatureFlagLayers,
} from "hudsonkit/flags";

import { readScoutBootstrapFlagBundle } from "./runtime-config.ts";
import {
  SCOPE_FLAG_BUNDLE,
  SCOPE_FLAG_KEY,
  SCOPE_LEGACY_FLAG_KEY,
} from "../../shared/scope-integration.js";
import {
  SCOPE_FLAG_BUNDLE_ALIASES,
  legacyScopeSurfaceFlagDefinition,
  scopeInstrumentBundleLayer,
  scopeSurfaceFlagDefinition,
} from "../scope/flags.ts";
import {
  SCOUT_FLAG_BUNDLE_QUERY_KEYS,
  SCOUT_FLAG_GLOBAL_BUNDLE_QUERY_KEYS,
  SCOUT_FLAG_PERSIST_QUERY_KEYS,
} from "./scout-flag-query.ts";

export const SCOUT_AUDIENCE_ORDER = ["everyone", "internal", "power"] as const;
export type ScoutAudienceTier = (typeof SCOUT_AUDIENCE_ORDER)[number];

// localStorage / cookie key the Provider reads & writes local overrides under.
// Distinct from HudsonKit's default ("hudson.flags") so OpenScout owns its own
// override namespace.
export const SCOUT_FLAG_STORAGE_KEY = "openscout.flags";
export const SCOUT_FLAG_BUNDLE_STORAGE_KEY = "openscout.flagBundle";

// Default audience. "power" keeps the full ops surface visible, matching the
// pre-flag behavior where ops was on by default. Slice 2 flips this to
// "everyone" for the lean launch, at which point ops.* become audience-denied
// for the default operator and only power audiences (or local overrides) see
// them.
export const SCOUT_DEFAULT_AUDIENCE: FeatureFlagAudience<ScoutAudienceTier> = {
  tier: "power",
};

const OPS_FLAG_KEYS = [
  "ops.control",
  "ops.mesh",
  "ops.runtime",
  "ops.plans",
  "ops.terminal",
  "ops.lanes",
] as const;

const SURFACE_FLAG_KEYS = [
  "surface.search",
  "surface.sessions",
  "surface.briefings",
  "surface.work",
  "surface.activity",
  "surface.follow",
  "surface.mesh-ops",
  "surface.scoutbot",
  "surface.realtime-voice",
  "surface.workflows",
] as const;

export const scoutFlags = createFlagRegistry({
  // ── nav.* — chrome ───────────────────────────────────────────────────
  "nav.sidebar": {
    label: "Nav · Sidebar",
    description:
      "Classic sidebar chrome (8 primary areas + icon rail). Default on since sco-083 soak; opt out with ?ff.nav.sidebar=off. Not included in max-pro.",
    defaultEnabled: true,
    tier: "everyone",
    owner: "scout-web",
    tags: ["nav", "chrome"],
  },

  // ── ops.* — power surfaces, audience-gated ────────────────────────────
  "ops.control": {
    label: "Ops · Control",
    description: "Mission control, issues, and the Ops section shell.",
    defaultEnabled: true,
    tier: "power",
    owner: "scout-web",
    tags: ["ops", "nav"],
  },
  "ops.mesh": {
    label: "Ops · Mesh",
    description: "Mesh topology and peer status.",
    defaultEnabled: true,
    tier: "power",
    owner: "scout-web",
    tags: ["ops"],
  },
  "ops.runtime": {
    label: "Ops · Runtime",
    description: "Runtime / atop process telemetry.",
    defaultEnabled: true,
    tier: "power",
    owner: "scout-web",
    tags: ["ops"],
  },
  "ops.plans": {
    label: "Ops · Plans",
    description: "Plan documents and plan-mode review.",
    defaultEnabled: true,
    tier: "power",
    owner: "scout-web",
    tags: ["ops"],
  },
  "ops.terminal": {
    label: "Ops · Terminal",
    description: "Observe / takeover terminal sessions.",
    defaultEnabled: true,
    tier: "power",
    owner: "scout-web",
    tags: ["ops"],
  },
  "ops.lanes": {
    label: "Ops · Agent Lanes",
    description: "One column per local agent — follow live harness work in power-user mode.",
    defaultEnabled: true,
    tier: "power",
    owner: "scout-web",
    tags: ["ops"],
  },

  // ── surface.* — entry declutter, default off ──────────────────────────
  "surface.search": {
    label: "Surface · Search",
    description: "Knowledge + indexer search as a top-level nav entry.",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface", "nav"],
  },
  "surface.sessions": {
    label: "Surface · Sessions",
    description: "Standalone top-level Sessions entry (still reachable under Agents).",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface", "nav"],
  },
  "surface.briefings": {
    label: "Surface · Briefings",
    description: "Briefings list + detail.",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface"],
  },
  "surface.work": {
    label: "Surface · Work",
    description: "Work item detail.",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface"],
  },
  "surface.activity": {
    label: "Surface · Activity",
    description: "Activity stream.",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface"],
  },
  "surface.follow": {
    label: "Surface · Follow",
    description: "Follow view.",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface"],
  },
  "surface.mesh-ops": {
    label: "Surface · Mesh Ops",
    description: "Mesh Ops — work-item triage over the mesh (hosts rail, item list, inspector).",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface", "ops"],
  },
  "surface.scoutbot": {
    label: "Surface · Scoutbot",
    description:
      "Scoutbot assistant — the inspector panel, the status-bar broadcast chip, and the Message-Scout command-palette actions.",
    // Default ON: this is a kill-switch / lean-launch toggle for an
    // always-present feature, not a default-off reveal like its surface.*
    // siblings. Not in a bundle yet — toggle via the panel or ?ff.surface.scoutbot.
    defaultEnabled: true,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface", "assistant"],
  },
  "surface.realtime-voice": {
    label: "Surface · Realtime voice",
    description:
      "Live WebRTC voice conversations with Scoutbot through OpenAI Realtime.",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface", "assistant", "voice"],
  },
  "surface.workflows": {
    label: "Surface · Workflows",
    description:
      "Observed harness families / workflow topology telemetry on the Agents directory. Off in the lean view — the directory is just the project-grouped agent board.",
    defaultEnabled: false,
    tier: "everyone",
    owner: "scout-web",
    tags: ["surface", "observability"],
  },
  [SCOPE_FLAG_KEY]: scopeSurfaceFlagDefinition,
  [SCOPE_LEGACY_FLAG_KEY]: legacyScopeSurfaceFlagDefinition,
});

export type ScoutFlagKey = keyof typeof scoutFlags;
export type ScoutFlagBundle = "light-prod" | "max-pro" | typeof SCOPE_FLAG_BUNDLE;
type ScoutFlagBundlePersistenceRequest =
  | { action: "set"; bundle: ScoutFlagBundle }
  | { action: "clear" };

const SCOUT_FLAG_BUNDLE_ALIASES: Record<string, ScoutFlagBundle> = {
  a: "light-prod",
  control: "light-prod",
  light: "light-prod",
  "light-prod": "light-prod",
  prod: "light-prod",
  production: "light-prod",
  b: "max-pro",
  max: "max-pro",
  "max-pro": "max-pro",
  pro: "max-pro",
  treatment: "max-pro",
  ...SCOPE_FLAG_BUNDLE_ALIASES,
};

const SCOUT_FLAG_BUNDLE_CLEAR_ALIASES = new Set(["clear", "default", "none", "reset", "unset"]);

function flagValues(keys: readonly string[], value: boolean): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, value]));
}

function mergeFlagLayers(
  ...layers: FeatureFlagLayerInput<ScoutAudienceTier>[]
): FeatureFlagLayerInput<ScoutAudienceTier> {
  const merged: FeatureFlagLayerInput<ScoutAudienceTier> = {};
  for (const layer of layers) {
    if (layer.audience) {
      merged.audience = layer.audience;
    }
    if (layer.flags && Object.keys(layer.flags).length > 0) {
      merged.flags = { ...(merged.flags ?? {}), ...layer.flags };
    }
  }
  return merged;
}

export function scoutFlagBundleLayer(bundle: ScoutFlagBundle): FeatureFlagLayerInput<ScoutAudienceTier> {
  switch (bundle) {
    case "light-prod":
      return {
        audience: "everyone",
        flags: {
          ...flagValues(OPS_FLAG_KEYS, false),
          ...flagValues(SURFACE_FLAG_KEYS, false),
        },
      };
    case "max-pro":
      return {
        audience: "power",
        flags: {
          ...flagValues(OPS_FLAG_KEYS, true),
          ...flagValues(SURFACE_FLAG_KEYS, true),
        },
      };
    case SCOPE_FLAG_BUNDLE:
      return scopeInstrumentBundleLayer();
  }
}

function scoutFlagBundleFromValue(value: string | null | undefined): ScoutFlagBundle | null {
  if (!value) return null;
  return SCOUT_FLAG_BUNDLE_ALIASES[value.trim().toLowerCase()] ?? null;
}

function firstQueryValue(
  params: URLSearchParams,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null) return value;
  }
  return null;
}

function scoutFlagBundleFromUrl(params: URLSearchParams): ScoutFlagBundle | null {
  const raw = firstQueryValue(params, SCOUT_FLAG_BUNDLE_QUERY_KEYS);
  return scoutFlagBundleFromValue(raw);
}

function scoutFlagBundlePersistenceRequest(params: URLSearchParams): ScoutFlagBundlePersistenceRequest | null {
  const direct = firstQueryValue(params, SCOUT_FLAG_GLOBAL_BUNDLE_QUERY_KEYS);
  if (direct) {
    const normalized = direct.trim().toLowerCase();
    if (SCOUT_FLAG_BUNDLE_CLEAR_ALIASES.has(normalized)) return { action: "clear" };
    const bundle = scoutFlagBundleFromValue(direct);
    return bundle ? { action: "set", bundle } : null;
  }

  const persist = firstQueryValue(params, SCOUT_FLAG_PERSIST_QUERY_KEYS);
  if (!persist) return null;

  const normalized = persist.trim().toLowerCase();
  if (SCOUT_FLAG_BUNDLE_CLEAR_ALIASES.has(normalized)) return { action: "clear" };
  if (["0", "false", "no"].includes(normalized)) return null;

  const explicitBundle = scoutFlagBundleFromValue(persist);
  if (explicitBundle) return { action: "set", bundle: explicitBundle };

  const urlBundle = scoutFlagBundleFromUrl(params);
  return urlBundle ? { action: "set", bundle: urlBundle } : null;
}

export function readStoredScoutFlagBundle(): ScoutFlagBundle | null {
  if (typeof window === "undefined") return null;
  try {
    return scoutFlagBundleFromValue(window.localStorage.getItem(SCOUT_FLAG_BUNDLE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredScoutFlagBundle(request: ScoutFlagBundlePersistenceRequest): void {
  if (typeof window === "undefined") return;
  try {
    if (request.action === "clear") {
      window.localStorage.removeItem(SCOUT_FLAG_BUNDLE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SCOUT_FLAG_BUNDLE_STORAGE_KEY, request.bundle);
    }
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}

/** Resolve the active bundle from storage, bootstrap, or the lean default. */
export function resolveActiveScoutFlagBundle(): ScoutFlagBundle {
  return (
    readStoredScoutFlagBundle()
    ?? scoutFlagBundleFromValue(readScoutBootstrapFlagBundle())
    ?? SCOUT_DEFAULT_BUNDLE
  );
}

function scoutStoredBundleLayer(): FeatureFlagLayerInput<ScoutAudienceTier> {
  const bundle = readStoredScoutFlagBundle();
  return bundle ? scoutFlagBundleLayer(bundle) : {};
}

// The out-of-the-box experience. With nothing else set we serve the lean
// `light-prod` bundle (ops/surface extras off) as the baseline; the
// full experience is opt-in via `?ffBundle=max-pro` (one load), `?ffGlobal=max-pro`
// (pinned for the browser), or the dev panel. `OPENSCOUT_WEB_FLAG_BUNDLE` on the
// server still wins over this default. This is the lowest-priority layer —
// url/local always override it.
const SCOUT_DEFAULT_BUNDLE: ScoutFlagBundle = "light-prod";

function scoutSiteBundleLayer(): FeatureFlagLayerInput<ScoutAudienceTier> {
  const bundle = scoutFlagBundleFromValue(readScoutBootstrapFlagBundle()) ?? SCOUT_DEFAULT_BUNDLE;
  return scoutFlagBundleLayer(bundle);
}

function applyScoutFlagBundlePersistence(params: URLSearchParams): void {
  const request = scoutFlagBundlePersistenceRequest(params);
  if (request) writeStoredScoutFlagBundle(request);
}

// ── URL layer ───────────────────────────────────────────────────────────
// `OPENSCOUT_WEB_FLAG_BUNDLE=light-prod|max-pro` sets the served site's default
// bundle through `/api/bootstrap.js`. The aliases A/B, light/pro, and prod/max
// work there too.
// `?ffBundle=light-prod|max-pro` applies a named A/B-style flag bundle.
// `?ffVariant=A|B`, `?scoutExperience=light|pro`, and `?ab=A|B` are aliases.
// `?ffBundle=max-pro&ffPersist=1` or `?ffGlobal=max-pro` pins a bundle for
// this browser. `?ffGlobal=clear` clears it.
// Specific `?ff.<key>=on|off` overrides and `?ffAudience=<tier>` win over the
// bundle. The legacy `?no-ops` shortcut maps to `ops.control=off` so existing
// bookmarks keep working.
function scoutUrlLayer(params = new URLSearchParams(window.location.search)): FeatureFlagLayerInput<ScoutAudienceTier> {
  const explicitLayer = parseFeatureFlagUrl<ScoutAudienceTier>(window.location.href);
  const bundle = scoutFlagBundleFromUrl(params);
  const bundleLayer = bundle ? scoutFlagBundleLayer(bundle) : {};
  const layer: FeatureFlagLayerInput<ScoutAudienceTier> = {
    audience: explicitLayer.audience ?? bundleLayer.audience,
    flags: {
      ...(bundleLayer.flags ?? {}),
      ...(explicitLayer.flags ?? {}),
    },
  };
  if (params.has("no-ops")) {
    layer.flags = { ...layer.flags, "ops.control": false };
  }
  return layer;
}

// ── Local layer ───────────────────────────────────────────────────────────
// Reads the same `{ version, audience, flags }` state the Provider writes,
// using HudsonKit's published storage helper from the `hudsonkit/flags` entry,
// so the non-React shim stays consistent with
// the React tree. `readFeatureFlagLocalState` is SSR-safe (returns empty off-window).
function scoutLocalLayer(): FeatureFlagLayerInput<ScoutAudienceTier> {
  const state = readFeatureFlagLocalState<ScoutAudienceTier>(SCOUT_FLAG_STORAGE_KEY);
  return { flags: state.flags, audience: state.audience ?? undefined };
}

// Initial layers for `<FeatureFlagsProvider>`. The Provider rehydrates the
// local layer from storage itself in an effect; we seed the url layer here so
// `?ff.*` overrides take on the very first render.
export function scoutFlagInitialLayers(): FeatureFlagLayers<ScoutAudienceTier> {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  applyScoutFlagBundlePersistence(params);
  return {
    sharedConfig: mergeFlagLayers(scoutSiteBundleLayer(), scoutStoredBundleLayer()),
    url: scoutUrlLayer(params),
  };
}

// ── Non-React resolver shim ───────────────────────────────────────────────
// For route resolution / navigation guards (`lib/router.ts`) and anything else
// outside the React tree. Mirrors the Provider's resolution (site/shared config
// + url + local + registry defaults + audience).
export function isScoutFlagEnabled(key: ScoutFlagKey | string): boolean {
  const layers: FeatureFlagLayers<ScoutAudienceTier> =
    typeof window === "undefined"
      ? {}
      : {
          sharedConfig: mergeFlagLayers(scoutSiteBundleLayer(), scoutStoredBundleLayer()),
          url: scoutUrlLayer(),
          local: scoutLocalLayer(),
        };
  const resolver = createFlagResolver({
    registry: scoutFlags,
    audience: SCOUT_DEFAULT_AUDIENCE,
    audienceOrder: SCOUT_AUDIENCE_ORDER,
    layers,
    warnOnUnknown: false,
  });
  return resolver.isEnabled(key);
}
