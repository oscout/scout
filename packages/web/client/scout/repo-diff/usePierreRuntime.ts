import { useCallback, useEffect, useState } from "react";
import { useOptionalTheme } from "hudsonkit/theme";
import {
  loadPierre,
  warmupHighlighter,
  type PierreRuntime,
} from "./pierre.ts";
import {
  readScoutUiThemeMode,
  resolvePierreDiffTheme,
} from "./pierre-theme.ts";
import type { PierrePhase } from "./model.ts";
import type { ScoutRepoDiffSnapshot } from "./types.ts";

export type PierreRuntimeState = {
  pierre: PierreRuntime | null;
  pierrePhase: PierrePhase;
  pierreError: string | null;
  pierreTheme: string;
  retryPierre: () => void;
};

export function usePierreRuntime(
  snapshot: ScoutRepoDiffSnapshot | null,
): PierreRuntimeState {
  const hudsonTheme = useOptionalTheme();
  const [pierre, setPierre] = useState<PierreRuntime | null>(null);
  const [pierrePhase, setPierrePhase] = useState<PierrePhase>("loading");
  const [pierreError, setPierreError] = useState<string | null>(null);
  const pierreTheme = resolvePierreDiffTheme(
    snapshot?.render.preferredTheme,
    hudsonTheme?.resolvedTheme ?? readScoutUiThemeMode(),
  );

  const retryPierre = useCallback(() => {
    setPierrePhase("loading");
    setPierreError(null);
    loadPierre().then(
      (runtime) => {
        setPierre(runtime);
        setPierrePhase("ready");
      },
      (err) => {
        setPierreError(err instanceof Error ? err.message : String(err));
        setPierrePhase("error");
      },
    );
  }, []);

  useEffect(() => {
    let alive = true;
    loadPierre().then(
      (runtime) => {
        if (!alive) return;
        setPierre(runtime);
        setPierrePhase("ready");
      },
      (err) => {
        if (!alive) return;
        setPierreError(err instanceof Error ? err.message : String(err));
        setPierrePhase("error");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (pierre && snapshot) {
      void warmupHighlighter(pierre, pierreTheme);
    }
  }, [pierre, pierreTheme, snapshot]);

  return { pierre, pierrePhase, pierreError, pierreTheme, retryPierre };
}
