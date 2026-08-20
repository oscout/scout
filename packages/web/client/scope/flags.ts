import type { FeatureFlagLayerInput } from "hudsonkit/flags";
import {
  SCOPE_FLAG_BUNDLE,
  SCOPE_FLAG_BUNDLE_ALIASES,
  SCOPE_FLAG_KEY,
  SCOPE_LEGACY_FLAG_KEY,
  SCOPE_PATH_PREFIX,
} from "../../shared/scope-integration.js";

type ScopeFlagDefinition = {
  label: string;
  description: string;
  defaultEnabled: boolean;
  tier: "everyone";
  owner: string;
  tags: string[];
};

const OPS_FLAG_KEYS_EXCEPT_LANES = [
  "ops.control",
  "ops.mesh",
  "ops.runtime",
  "ops.plans",
  "ops.terminal",
] as const;

const SURFACE_FLAG_KEYS_EXCEPT_SCOPE = [
  "surface.search",
  "surface.sessions",
  "surface.briefings",
  "surface.work",
  "surface.activity",
  "surface.follow",
  "surface.scoutbot",
  "surface.workflows",
] as const;

function flagValues(keys: readonly string[], value: boolean): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, value]));
}

export const scopeSurfaceFlagDefinition: ScopeFlagDefinition = {
  label: "Surface · Scope",
  description:
    `Scope presentation on Scout infra — lean lanes/tail/sessions/agents at ${SCOPE_PATH_PREFIX}/*.`,
  defaultEnabled: false,
  tier: "everyone",
  owner: "scout-web",
  tags: ["surface", "scope", "observability"],
};

export const legacyScopeSurfaceFlagDefinition: ScopeFlagDefinition = {
  ...scopeSurfaceFlagDefinition,
  label: "Surface · Scope (legacy alias)",
  description:
    `Legacy alias for ${SCOPE_FLAG_KEY}. Prefer the primary flag; ${SCOPE_LEGACY_FLAG_KEY} remains for old dev links.`,
};

export const SCOPE_FLAG_REGISTRY_KEY = SCOPE_FLAG_KEY;

export { SCOPE_FLAG_BUNDLE_ALIASES };

export function scopeInstrumentBundleLayer(): FeatureFlagLayerInput<"everyone" | "internal" | "power"> {
  return {
    audience: "everyone",
    flags: {
      "ops.control": true,
      "ops.lanes": true,
      ...flagValues(OPS_FLAG_KEYS_EXCEPT_LANES, false),
      ...flagValues(SURFACE_FLAG_KEYS_EXCEPT_SCOPE, false),
    },
  };
}