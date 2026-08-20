import type * as ReactModule from "react";
import type { ReactNode } from "react";

// Keep Bun's runtime resolver away from this repo's React -> .d.ts tsconfig path.
// @ts-expect-error -- untyped relative .js import, cast back to React's public type.
const React = (await import("../../../node_modules/react/index.js")) as typeof ReactModule;
const { createContext, createElement, useContext, useEffect, useMemo, useState } = React;

export type FeatureFlagLayer = "local" | "url" | "sharedConfig" | "env" | "default";
export const FEATURE_FLAG_LAYER_ORDER = ["local", "url", "sharedConfig", "env"] as const;
export type FeatureFlagOverride = boolean | "on" | "off" | "default" | null | undefined;
export type FeatureFlagReason = "override" | "default" | "audience-denied" | "unknown-flag";

export interface FeatureFlagDefinition<TAudience extends string = string> {
  label: string;
  description?: string;
  defaultEnabled: boolean;
  tier?: TAudience;
  owner?: string;
  tags?: string[];
  expiresAt?: string;
}

export type FeatureFlagRegistry<TAudience extends string = string> =
  Record<string, FeatureFlagDefinition<TAudience>>;
export type FeatureFlagKey<R extends FeatureFlagRegistry = FeatureFlagRegistry> =
  Extract<keyof R, string>;

export interface FeatureFlagAudience<TAudience extends string = string> {
  tier: TAudience;
  traits?: Record<string, string | number | boolean | null | undefined>;
}

export type AudienceIncludes<TAudience extends string = string> =
  (active: FeatureFlagAudience<TAudience>, required: TAudience) => boolean;

export interface FeatureFlagLayerInput<TAudience extends string = string> {
  flags?: Record<string, FeatureFlagOverride>;
  audience?: TAudience | null;
}

export interface FeatureFlagLayers<TAudience extends string = string> {
  env?: FeatureFlagLayerInput<TAudience>;
  sharedConfig?: FeatureFlagLayerInput<TAudience>;
  url?: FeatureFlagLayerInput<TAudience>;
  local?: FeatureFlagLayerInput<TAudience>;
}

export interface FeatureFlagResolverInput<
  R extends FeatureFlagRegistry = FeatureFlagRegistry,
  TAudience extends string = string,
> {
  registry: R;
  audience: FeatureFlagAudience<TAudience>;
  audienceOrder?: readonly TAudience[];
  audienceIncludes?: AudienceIncludes<TAudience>;
  layers?: FeatureFlagLayers<TAudience>;
  warnOnUnknown?: boolean;
}

export interface FeatureFlagResolution<TAudience extends string = string> {
  key: string;
  enabled: boolean;
  layer: FeatureFlagLayer;
  value: boolean;
  audience: FeatureFlagAudience<TAudience>;
  requiredTier?: TAudience;
  reason: FeatureFlagReason;
  definition?: FeatureFlagDefinition<TAudience>;
}

export interface FeatureFlagResolver<
  R extends FeatureFlagRegistry = FeatureFlagRegistry,
  TAudience extends string = string,
> {
  registry: R;
  isEnabled<K extends FeatureFlagKey<R> | string>(key: K): boolean;
  explain<K extends FeatureFlagKey<R> | string>(key: K): FeatureFlagResolution<TAudience>;
  all(): FeatureFlagResolution<TAudience>[];
  audience(): FeatureFlagAudience<TAudience>;
}

export type FeatureFlagGate<R extends FeatureFlagRegistry = FeatureFlagRegistry> =
  | FeatureFlagKey<R>
  | {
      key: FeatureFlagKey<R> | string;
      when?: (resolver: FeatureFlagResolver<R>) => boolean;
      reason?: string;
    };

export interface FeatureFlagLocalState<TAudience extends string = string> {
  version: 1;
  audience?: TAudience | null;
  flags?: Record<string, boolean | null | undefined>;
}

export interface FeatureFlagsContextValue<
  R extends FeatureFlagRegistry = FeatureFlagRegistry,
  TAudience extends string = string,
> extends FeatureFlagResolver<R, TAudience> {
  layers: FeatureFlagLayers<TAudience>;
  storageKey: string;
  setLocalOverride(key: string, value: boolean | null): void;
  setLocalAudienceOverride(tier: TAudience | null): void;
  resetLocalOverrides(): void;
}

export interface FeatureFlagsProviderProps<
  R extends FeatureFlagRegistry = FeatureFlagRegistry,
  TAudience extends string = string,
> {
  registry: R;
  audience: FeatureFlagAudience<TAudience>;
  audienceOrder?: readonly TAudience[];
  audienceIncludes?: AudienceIncludes<TAudience>;
  initialLayers?: FeatureFlagLayers<TAudience>;
  storageKey?: string;
  warnOnUnknown?: boolean;
  children: ReactNode;
}

export function createFlagRegistry<const R extends FeatureFlagRegistry>(registry: R): R {
  return registry;
}

export function createFlagResolver<
  R extends FeatureFlagRegistry,
  TAudience extends string = string,
>(input: FeatureFlagResolverInput<R, TAudience>): FeatureFlagResolver<R, TAudience> {
  const audience = resolveAudience(input);
  const includes = input.audienceIncludes ?? createAudienceIncludes(input.audienceOrder);
  const warned = new Set<string>();
  const registry = input.registry as unknown as Record<string, FeatureFlagDefinition<TAudience>>;

  function warnUnknown(key: string) {
    if (!input.warnOnUnknown || warned.has(key)) return;
    warned.add(key);
    console.warn(`[hudsonkit/flags] Unknown feature flag "${key}" resolved false.`);
  }

  function explain(key: string): FeatureFlagResolution<TAudience> {
    const definition = registry[key];
    if (!definition) {
      warnUnknown(key);
      return {
        key,
        enabled: false,
        value: false,
        layer: "default",
        audience,
        reason: "unknown-flag",
      };
    }

    const override = findWinningOverride(input.layers, key);
    if (override) {
      return {
        key,
        enabled: override.value,
        value: override.value,
        layer: override.layer,
        audience,
        requiredTier: definition.tier,
        reason: "override",
        definition,
      };
    }

    if (!definition.defaultEnabled) {
      return {
        key,
        enabled: false,
        value: false,
        layer: "default",
        audience,
        requiredTier: definition.tier,
        reason: "default",
        definition,
      };
    }

    if (definition.tier && !includes(audience, definition.tier)) {
      return {
        key,
        enabled: false,
        value: false,
        layer: "default",
        audience,
        requiredTier: definition.tier,
        reason: "audience-denied",
        definition,
      };
    }

    return {
      key,
      enabled: true,
      value: true,
      layer: "default",
      audience,
      requiredTier: definition.tier,
      reason: "default",
      definition,
    };
  }

  return {
    registry: input.registry,
    isEnabled: (key) => explain(String(key)).enabled,
    explain: (key) => explain(String(key)),
    all: () => Object.keys(input.registry).sort().map(explain),
    audience: () => audience,
  };
}

export function isFlagEnabled<R extends FeatureFlagRegistry>(
  resolver: FeatureFlagResolver<R> | null | undefined,
  key: string,
): boolean {
  return resolver ? resolver.isEnabled(key) : true;
}

export function isGateEnabled<R extends FeatureFlagRegistry>(
  gate: FeatureFlagGate<R> | null | undefined,
  resolver: FeatureFlagResolver<R> | null | undefined,
): boolean {
  if (!gate || !resolver) return true;
  const gateObject = typeof gate === "string" ? { key: gate } : gate;
  if (!resolver.isEnabled(gateObject.key)) return false;
  return gateObject.when ? gateObject.when(resolver) : true;
}

export function filterFlaggedItems<T extends { flag?: FeatureFlagGate }>(
  items: readonly T[],
  resolver: FeatureFlagResolver | null | undefined,
): T[] {
  if (!resolver) return [...items];
  return items.filter((item) => isGateEnabled(item.flag, resolver));
}

function resolveAudience<TAudience extends string>(
  input: FeatureFlagResolverInput<FeatureFlagRegistry, TAudience>,
): FeatureFlagAudience<TAudience> {
  let tier = input.audience.tier;
  for (const layer of FEATURE_FLAG_LAYER_ORDER.slice().reverse()) {
    const override = input.layers?.[layer]?.audience;
    if (override) tier = override;
  }
  return { ...input.audience, tier };
}

function createAudienceIncludes<TAudience extends string>(
  order?: readonly TAudience[],
): AudienceIncludes<TAudience> {
  return (active, required) => {
    if (active.tier === required) return true;
    if (!order || order.length === 0) return false;
    const activeIndex = order.indexOf(active.tier);
    const requiredIndex = order.indexOf(required);
    if (activeIndex < 0 || requiredIndex < 0) return false;
    return activeIndex >= requiredIndex;
  };
}

function findWinningOverride<TAudience extends string>(
  layers: FeatureFlagResolverInput<FeatureFlagRegistry, TAudience>["layers"],
  key: string,
): { layer: FeatureFlagLayer; value: boolean } | null {
  for (const layer of FEATURE_FLAG_LAYER_ORDER) {
    const value = normalizeOverride(layers?.[layer]?.flags?.[key]);
    if (value !== null) return { layer, value };
  }
  return null;
}

export function normalizeOverride(value: FeatureFlagOverride): boolean | null {
  if (value === true || value === "on") return true;
  if (value === false || value === "off") return false;
  return null;
}

export function normalizeFeatureFlagLayer<TAudience extends string = string>(
  input: unknown,
): FeatureFlagLayerInput<TAudience> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const flags: Record<string, FeatureFlagOverride> = {};
  const rawFlags = raw.flags && typeof raw.flags === "object"
    ? raw.flags as Record<string, unknown>
    : raw;

  for (const [key, value] of Object.entries(rawFlags)) {
    if (key === "audience" || key === "version" || key === "featureFlags") continue;
    const parsed = parseOverrideValue(value);
    if (parsed !== undefined) flags[key] = parsed;
  }

  const audience = typeof raw.audience === "string" && raw.audience.trim()
    ? raw.audience.trim() as TAudience
    : undefined;
  return { flags, audience };
}

export function parseOverrideValue(value: unknown): FeatureFlagOverride {
  if (value === true || value === false) return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes", "enabled", "enable"].includes(normalized)) return true;
  if (["0", "false", "off", "no", "disabled", "disable"].includes(normalized)) return false;
  if (["default", "null", "unset", "clear"].includes(normalized)) return "default";
  return undefined;
}

export interface FeatureFlagUrlParseOptions {
  paramPrefix?: string;
  audienceParam?: string;
}

export function parseFeatureFlagUrl<TAudience extends string = string>(
  input: string | URL,
  options: FeatureFlagUrlParseOptions = {},
): FeatureFlagLayerInput<TAudience> {
  const prefix = options.paramPrefix ?? "ff.";
  const audienceParam = options.audienceParam ?? "ffAudience";
  const url = typeof input === "string" ? new URL(input, "http://hudson.local") : input;
  const flags: Record<string, FeatureFlagOverride> = {};
  let audience: TAudience | undefined;

  for (const [key, value] of url.searchParams.entries()) {
    if (key === audienceParam && value.trim()) audience = value.trim() as TAudience;
    if (!key.startsWith(prefix)) continue;
    const flagKey = key.slice(prefix.length);
    const parsed = parseOverrideValue(value);
    if (flagKey && parsed !== undefined) flags[flagKey] = parsed;
  }

  return { flags, audience };
}

export interface FeatureFlagEnvParseOptions {
  singlePrefix?: string;
  listKey?: string;
  audienceKey?: string;
}

export function parseFeatureFlagEnv<TAudience extends string = string>(
  env: Record<string, string | undefined>,
  options: FeatureFlagEnvParseOptions = {},
): FeatureFlagLayerInput<TAudience> {
  const singlePrefix = options.singlePrefix ?? "HUDSON_FLAG_";
  const listKey = options.listKey ?? "HUDSON_FLAGS";
  const audienceKey = options.audienceKey ?? "HUDSON_FLAG_AUDIENCE";
  const flags: Record<string, FeatureFlagOverride> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(singlePrefix)) continue;
    const flagKey = key.slice(singlePrefix.length).toLowerCase().replace(/__/g, ":").replace(/_/g, ".");
    const parsed = parseOverrideValue(value);
    if (flagKey && parsed !== undefined) flags[flagKey] = parsed;
  }

  const list = env[listKey];
  if (list) {
    for (const part of list.split(",")) {
      const [rawKey, rawValue = "on"] = part.split(":");
      const flagKey = rawKey?.trim();
      const parsed = parseOverrideValue(rawValue);
      if (flagKey && parsed !== undefined) flags[flagKey] = parsed;
    }
  }

  const audience = env[audienceKey]?.trim() as TAudience | undefined;
  return { flags, audience: audience || undefined };
}

const VERSION = 1;

export function readFeatureFlagLocalState<TAudience extends string = string>(
  storageKey: string,
): FeatureFlagLocalState<TAudience> {
  if (typeof window === "undefined") return { version: VERSION };
  try {
    return parseFeatureFlagLocalState<TAudience>(window.localStorage?.getItem(storageKey));
  } catch {
    return { version: VERSION };
  }
}

export function writeFeatureFlagLocalState<TAudience extends string = string>(
  storageKey: string,
  state: FeatureFlagLocalState<TAudience>,
): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeLocalState(state);
  const body = JSON.stringify(normalized);
  try {
    window.localStorage?.setItem(storageKey, body);
  } catch {
    /* ignore */
  }
  writeCookie(storageKey, body);
}

export function parseFeatureFlagLocalState<TAudience extends string = string>(
  raw: string | null | undefined,
): FeatureFlagLocalState<TAudience> {
  if (!raw) return { version: VERSION };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { version: VERSION };
    return normalizeLocalState(parsed as FeatureFlagLocalState<TAudience>);
  } catch {
    return { version: VERSION };
  }
}

function normalizeLocalState<TAudience extends string>(
  state: FeatureFlagLocalState<TAudience>,
): FeatureFlagLocalState<TAudience> {
  const out: FeatureFlagLocalState<TAudience> = { version: VERSION };
  if (state.audience) out.audience = state.audience;
  if (state.flags && typeof state.flags === "object") {
    out.flags = {};
    for (const [key, value] of Object.entries(state.flags)) {
      if (value === true || value === false) out.flags[key] = value;
    }
    if (Object.keys(out.flags).length === 0) delete out.flags;
  }
  return out;
}

function writeCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=31536000`;
  } catch {
    /* ignore */
  }
}

const DEFAULT_STORAGE_KEY = "hudson.flags";
const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

export function FeatureFlagsProvider<
  R extends FeatureFlagRegistry,
  TAudience extends string = string,
>({
  registry,
  audience,
  audienceOrder,
  audienceIncludes,
  initialLayers,
  storageKey = DEFAULT_STORAGE_KEY,
  warnOnUnknown = false,
  children,
}: FeatureFlagsProviderProps<R, TAudience>) {
  const [localState, setLocalState] = useState<FeatureFlagLocalState<TAudience>>(() => {
    const initialLocal = initialLayers?.local;
    return {
      version: 1,
      audience: initialLocal?.audience ?? undefined,
      flags: flagsFromLayer(initialLocal),
    };
  });

  useEffect(() => {
    const stored = readFeatureFlagLocalState<TAudience>(storageKey);
    if (stored.audience || Object.keys(stored.flags ?? {}).length > 0) {
      setLocalState(stored);
    }
  }, [storageKey]);

  const layers = useMemo<FeatureFlagLayers<TAudience>>(() => ({
    ...initialLayers,
    local: {
      ...initialLayers?.local,
      audience: localState.audience ?? initialLayers?.local?.audience,
      flags: { ...(initialLayers?.local?.flags ?? {}), ...(localState.flags ?? {}) },
    },
  }), [initialLayers, localState]);

  const resolver = useMemo(() => createFlagResolver({
    registry,
    audience,
    audienceOrder,
    audienceIncludes,
    layers,
    warnOnUnknown,
  }), [audience, audienceIncludes, audienceOrder, layers, registry, warnOnUnknown]);

  const value = useMemo<FeatureFlagsContextValue<R, TAudience>>(() => ({
    ...resolver,
    layers,
    storageKey,
    setLocalOverride: (key, flagValue) => {
      setLocalState((previous) => {
        const flags = { ...(previous.flags ?? {}) };
        if (flagValue === null) delete flags[key];
        else flags[key] = flagValue;
        const next = { ...previous, version: 1 as const, flags };
        writeFeatureFlagLocalState(storageKey, next);
        return next;
      });
    },
    setLocalAudienceOverride: (tier) => {
      setLocalState((previous) => {
        const next = { ...previous, version: 1 as const, audience: tier ?? undefined };
        writeFeatureFlagLocalState(storageKey, next);
        return next;
      });
    },
    resetLocalOverrides: () => {
      const next = { version: 1 as const };
      writeFeatureFlagLocalState(storageKey, next);
      setLocalState(next);
    },
  }), [layers, resolver, storageKey]);

  return createElement(FeatureFlagsContext.Provider, { value }, children);
}

export function useOptionalFeatureFlags(): FeatureFlagsContextValue | null {
  return useContext(FeatureFlagsContext);
}

export function useFeatureFlags(): FeatureFlagsContextValue {
  const context = useOptionalFeatureFlags();
  if (!context) throw new Error("useFeatureFlags must be used within FeatureFlagsProvider");
  return context;
}

export function useFlag(key: string): boolean {
  return useFeatureFlags().isEnabled(key);
}

export function useOptionalFlag(key: string, fallback = true): boolean {
  return useOptionalFeatureFlags()?.isEnabled(key) ?? fallback;
}

export function useFlagResolution(key: string): FeatureFlagResolution {
  return useFeatureFlags().explain(key);
}

export function createFeatureFlagBootstrap<TAudience extends string = string>(
  input: { audience: FeatureFlagAudience<TAudience>; layers?: FeatureFlagLayers<TAudience> },
) {
  return input;
}

function flagsFromLayer<TAudience extends string>(
  layer?: FeatureFlagLayerInput<TAudience>,
): Record<string, boolean> | undefined {
  if (!layer?.flags) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(layer.flags)) {
    if (value === true || value === false) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export type FeatureFlagPanelProps = {
  resolver?: FeatureFlagResolver | null;
};

export function FeatureFlagPanel(_props: FeatureFlagPanelProps) {
  return null;
}
