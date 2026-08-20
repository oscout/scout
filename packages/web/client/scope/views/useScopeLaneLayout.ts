import { useCallback, useEffect, useState } from "react";

import { updateLocation } from "../../lib/router.ts";

export type ScopeLaneLayoutMode = "swim" | "grid" | "floor";

import { scopeStorageKey } from "../../../shared/scope-integration.js";

const STORAGE_KEY = scopeStorageKey("lanes-layout");

function isLayoutMode(value: string | null | undefined): value is ScopeLaneLayoutMode {
  return value === "swim" || value === "grid" || value === "floor";
}

function readStoredLayout(): ScopeLaneLayoutMode {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (isLayoutMode(stored)) return stored;
  } catch {
    // ignore storage failures
  }
  return "swim";
}

function readUrlLayout(): ScopeLaneLayoutMode | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("layout")?.trim().toLowerCase();
  return isLayoutMode(value) ? value : null;
}

export function useScopeLaneLayout(): {
  layoutMode: ScopeLaneLayoutMode;
  setLayoutMode: (mode: ScopeLaneLayoutMode) => void;
} {
  const [layoutMode, setLayoutModeState] = useState<ScopeLaneLayoutMode>(() => (
    readUrlLayout() ?? readStoredLayout()
  ));

  const setLayoutMode = useCallback((mode: ScopeLaneLayoutMode) => {
    setLayoutModeState(mode);
    try {
      sessionStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore storage failures
    }
    if (typeof window === "undefined") return;
    updateLocation({
      searchPatch: { layout: mode === "swim" ? null : mode },
      replace: true,
    });
  }, []);

  useEffect(() => {
    const fromUrl = readUrlLayout();
    if (fromUrl && fromUrl !== layoutMode) {
      setLayoutModeState(fromUrl);
      try {
        sessionStorage.setItem(STORAGE_KEY, fromUrl);
      } catch {
        // ignore storage failures
      }
    }
  }, [layoutMode]);

  return { layoutMode, setLayoutMode };
}