import { useEffect, useState, createElement } from "react";
import { useOptionalFlag } from "hudsonkit/flags";
import { useScout } from "../Provider.tsx";
import { MeshCanvasMinimap } from "./MeshCanvasMinimap.tsx";
import { projectJumpDockItems } from "../nav-destinations.ts";
import type { Route } from "../../lib/types.ts";
import "./global-jump-dock.css";

type DockMode = "jump" | "minimap";

const STORAGE_KEY = "openscout.globalJumpDock.mode.v1";

function readStoredMode(): DockMode | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "jump" || value === "minimap" ? value : null;
  } catch {
    return null;
  }
}

function persistMode(mode: DockMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore storage failures; mode stays in-memory.
  }
}

export function GlobalJumpDock() {
  const { route, navigate } = useScout();
  const minimapAvailable = route.view === "mesh";

  // Defaults: mesh → minimap, everywhere else → jump. Stored preference wins
  // when its target is currently available; otherwise fall back to the
  // context-appropriate default.
  const [mode, setMode] = useState<DockMode>(() => {
    const stored = readStoredMode();
    if (stored === "minimap" && minimapAvailable) return "minimap";
    if (stored === "jump") return "jump";
    return minimapAvailable ? "minimap" : "jump";
  });

  useEffect(() => {
    if (mode === "minimap" && !minimapAvailable) {
      setMode("jump");
    }
  }, [mode, minimapAvailable]);

  const selectMode = (next: DockMode) => {
    setMode(next);
    persistMode(next);
  };

  return (
    <div className="gjd">
      <div className="gjd-head">
        <span className="gjd-ear" aria-hidden />
        <div className="gjd-mode" role="group" aria-label="Bottom dock mode">
          <button
            type="button"
            className={`gjd-mode-btn${mode === "jump" ? " gjd-mode-btn--active" : ""}`}
            onClick={() => selectMode("jump")}
            aria-pressed={mode === "jump"}
          >
            jump
          </button>
          {minimapAvailable && (
            <button
              type="button"
              className={`gjd-mode-btn${mode === "minimap" ? " gjd-mode-btn--active" : ""}`}
              onClick={() => selectMode("minimap")}
              aria-pressed={mode === "minimap"}
            >
              minimap
            </button>
          )}
        </div>
        <span className="gjd-ear" aria-hidden />
      </div>
      <div className="gjd-body">
        {mode === "minimap" && minimapAvailable
          ? <MeshCanvasMinimap />
          : <JumpPanel navigate={navigate} />}
      </div>
    </div>
  );
}

const JUMPS = projectJumpDockItems();

function JumpPanel({ navigate }: { navigate: (route: Route) => void }) {
  const opsEnabled = useOptionalFlag("ops.control", true);
  const jumps = JUMPS.filter((j) => !j.opsGated || opsEnabled);
  return (
    <div className="gjd-jumps">
      {jumps.map((j) => {
        const Icon = j.icon;
        return (
          <button
            key={j.id}
            type="button"
            className="gjd-jump"
            onClick={() => navigate(j.route)}
          >
            <span className="gjd-jump-icon">
              {createElement(Icon, { size: 13, strokeWidth: 1.6 })}
            </span>
            <span className="gjd-jump-label">{j.label}</span>
          </button>
        );
      })}
    </div>
  );
}
