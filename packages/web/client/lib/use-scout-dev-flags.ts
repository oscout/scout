import { useCallback, useMemo } from "react";
import { useFeatureFlags } from "hudsonkit/flags";

import { api } from "./api.ts";
import {
  readStoredScoutFlagBundle,
  resolveActiveScoutFlagBundle,
  scoutFlagBundleLayer,
  type ScoutFlagBundle,
  writeStoredScoutFlagBundle,
} from "./scout-flags.ts";
import { stripScoutFlagQueryParams } from "./scout-flag-query.ts";

type BuildMode = "dev" | "production";

let cachedBuildMode: BuildMode | null = null;

function readViteDevFlag(): boolean {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.trim().toLowerCase();
  return host === "localhost"
    || host === "127.0.0.1"
    || host === "[::1]"
    || host.endsWith(".local");
}

/** Prime build-mode detection for non-Vite dev servers (Bun serving a built client). */
export function primeScoutDevToolsDetection(): void {
  if (typeof window === "undefined" || cachedBuildMode !== null) return;
  void api<{ mode?: BuildMode }>("/api/build")
    .then((build) => {
      cachedBuildMode = build.mode === "production" ? "production" : "dev";
    })
    .catch(() => {
      cachedBuildMode = null;
    });
}

if (typeof window !== "undefined") {
  primeScoutDevToolsDetection();
}

/** True when local dev tooling (flag chip, ⌘⇧F) should be available. */
export function isScoutDevToolsAvailable(): boolean {
  if (readViteDevFlag()) return true;
  if (isLocalDevHost()) return true;
  if (cachedBuildMode === "dev") return true;
  return false;
}

/** @deprecated Prefer isScoutDevToolsAvailable — Vite-only check misses Bun-served builds. */
export function isScoutWebDevBuild(): boolean {
  return isScoutDevToolsAvailable();
}

function clearScoutFlagQueryParams(): void {
  const url = stripScoutFlagQueryParams(new URL(window.location.href));
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function useScoutDevFlagControls() {
  const flags = useFeatureFlags();

  const activeBundle = useMemo(
    () => readStoredScoutFlagBundle() ?? resolveActiveScoutFlagBundle(),
    [flags.layers],
  );

  const applyBundle = useCallback((bundle: ScoutFlagBundle) => {
    flags.resetLocalOverrides();
    const layer = scoutFlagBundleLayer(bundle);
    if (layer.audience) {
      flags.setLocalAudienceOverride(layer.audience);
    }
    for (const [key, value] of Object.entries(layer.flags ?? {})) {
      if (typeof value === "boolean") {
        flags.setLocalOverride(key, value);
      }
    }
    writeStoredScoutFlagBundle({ action: "set", bundle });
  }, [flags]);

  const toggleBundle = useCallback(() => {
    applyBundle(activeBundle === "max-pro" ? "light-prod" : "max-pro");
  }, [activeBundle, applyBundle]);

  const resetBundle = useCallback(() => {
    flags.resetLocalOverrides();
    writeStoredScoutFlagBundle({ action: "clear" });
    clearScoutFlagQueryParams();
    window.location.reload();
  }, [flags]);

  return {
    activeBundle,
    applyBundle,
    toggleBundle,
    resetBundle,
  };
}
