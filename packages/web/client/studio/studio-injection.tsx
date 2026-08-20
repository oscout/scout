import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { updateLocation } from "../lib/router.ts";
import {
  resolveStudioInjectionState,
  type StudioInjectionMode,
  type StudioInjectionState,
} from "./studio-injection-state.ts";
import "./studio-injection.css";

export interface StudioInjectionController extends StudioInjectionState {
  renderedMode: StudioInjectionMode;
  peeking: boolean;
  setEnabled: (enabled: boolean) => void;
  setMode: (mode: StudioInjectionMode) => void;
}

interface StudioInjectionFrameProps {
  studyId: string;
  aliases?: string[];
  anchor: string;
  title: string;
  children: ReactNode;
  renderStudy: () => ReactNode;
}

const ENABLED_STORAGE_PREFIX = "openscout.studio.inject.";
const MODE_STORAGE_PREFIX = "openscout.studio.mode.";

function enabledStorageKey(studyId: string): string {
  return `${ENABLED_STORAGE_PREFIX}${studyId}`;
}

function modeStorageKey(studyId: string): string {
  return `${MODE_STORAGE_PREFIX}${studyId}`;
}

function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage can be unavailable in locked-down browser contexts.
  }
}

function viteDev(): boolean {
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

function oppositeMode(mode: StudioInjectionMode): StudioInjectionMode {
  return mode === "before" ? "after" : "before";
}

function clearStudioUrlParams(studyId: string): void {
  if (typeof window === "undefined") return;
  updateLocation({
    searchPatch: {
      studio: null,
      [`studio.${studyId}`]: null,
      studioInjection: null,
      studioMode: null,
      [`studioMode.${studyId}`]: null,
    },
    replace: true,
  });
}

export function useStudioInjection(studyId: string, aliases: string[] = []): StudioInjectionController {
  const [state, setState] = useState<StudioInjectionState>(() =>
    resolveStudioInjectionState({
      studyId,
      aliases,
      href: typeof window === "undefined" ? undefined : window.location.href,
      storedEnabled: readStoredValue(enabledStorageKey(studyId)),
      storedMode: readStoredValue(modeStorageKey(studyId)),
      dev: viteDev(),
    }),
  );
  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    if (!state.enabled) {
      setAltHeld(false);
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) setAltHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.altKey) setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [state.enabled]);

  const setEnabled = useCallback((enabled: boolean) => {
    writeStoredValue(enabledStorageKey(studyId), enabled ? "1" : "0");
    setState((current) => ({ ...current, enabled }));
  }, [studyId]);

  const setMode = useCallback((mode: StudioInjectionMode) => {
    writeStoredValue(modeStorageKey(studyId), mode);
    setState((current) => ({ ...current, mode }));
  }, [studyId]);

  const renderedMode = altHeld ? oppositeMode(state.mode) : state.mode;

  return useMemo(
    () => ({
      ...state,
      renderedMode,
      peeking: renderedMode !== state.mode,
      setEnabled,
      setMode,
    }),
    [renderedMode, setEnabled, setMode, state],
  );
}

export function StudioInjectionFrame({
  studyId,
  aliases,
  anchor,
  title,
  children,
  renderStudy,
}: StudioInjectionFrameProps) {
  const studio = useStudioInjection(studyId, aliases);

  if (!studio.enabled) return <>{children}</>;

  return (
    <div className="s-studio-injection" data-studio-anchor={anchor}>
      <div className="s-studio-injection-bar">
        <div className="s-studio-injection-label">
          <span className="s-studio-injection-kicker">Studio injection</span>
          <span className="s-studio-injection-title">{title}</span>
          <span className="s-studio-injection-anchor">{anchor}</span>
        </div>
        <div className="s-studio-injection-controls" role="group" aria-label={`${title} mode`}>
          <button
            type="button"
            className="s-studio-injection-mode"
            data-active={studio.mode === "before"}
            aria-pressed={studio.mode === "before"}
            onClick={() => studio.setMode("before")}
          >
            Before
          </button>
          <button
            type="button"
            className="s-studio-injection-mode"
            data-active={studio.mode === "after"}
            aria-pressed={studio.mode === "after"}
            onClick={() => studio.setMode("after")}
          >
            After
          </button>
        </div>
        <span className="s-studio-injection-state">
          {studio.peeking ? `Option: ${studio.renderedMode}` : studio.renderedMode}
        </span>
        <button
          type="button"
          className="s-studio-injection-close"
          onClick={() => {
            clearStudioUrlParams(studyId);
            studio.setEnabled(false);
          }}
        >
          Close
        </button>
      </div>
      <div className="s-studio-injection-body" data-studio-mode={studio.renderedMode}>
        {studio.renderedMode === "before" ? children : renderStudy()}
      </div>
    </div>
  );
}
