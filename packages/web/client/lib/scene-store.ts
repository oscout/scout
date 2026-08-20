import { useSyncExternalStore } from "react";
import { api } from "./api.ts";

export type SceneSurface = "mission-control";

export type SceneMatcher =
  | { kind: "all" }
  | { kind: "harness"; value: string }
  | { kind: "project"; value: string }
  | { kind: "branch"; value: string }
  | { kind: "agentClass"; value: string }
  | { kind: "agentIds"; ids: string[] }
  | { kind: "and"; of: SceneMatcher[] }
  | { kind: "or"; of: SceneMatcher[] };

export type SceneZone = {
  id: string;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  layout: "auto-pack" | "manual";
  match: SceneMatcher;
  color?: string;
};

export type SceneAgentOverride = {
  agentId: string;
  zoneId: string | null;
  position?: { x: number; y: number };
};

export type SceneBody = {
  version: 1;
  viewport: { pan: { x: number; y: number }; zoom: number } | null;
  zones: SceneZone[];
  overrides: SceneAgentOverride[];
  fallback: "auto-pack" | "hide";
};

export type Scene = {
  id: string;
  surface: SceneSurface;
  name: string;
  createdAt: number;
  updatedAt: number;
  body: SceneBody;
};

export type ScenesEnvelope = {
  scenes: Scene[];
  activeSceneIdBySurface: Partial<Record<SceneSurface, string | null>>;
};

type SceneState = {
  loaded: boolean;
  scenes: Scene[];
  activeSceneIdBySurface: Partial<Record<SceneSurface, string | null>>;
  editMode: boolean;
};

let _state: SceneState = {
  loaded: false,
  scenes: [],
  activeSceneIdBySurface: {},
  editMode: false,
};

const _listeners = new Set<() => void>();
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _loadPromise: Promise<void> | null = null;

function _notify() {
  for (const fn of _listeners) fn();
}

function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void api<ScenesEnvelope>("/api/ui/scenes", {
      method: "PUT",
      body: JSON.stringify({
        scenes: _state.scenes,
        activeSceneIdBySurface: _state.activeSceneIdBySurface,
      }),
      headers: { "content-type": "application/json" },
    }).catch((err) => {
      console.warn("[scene-store] save failed", err);
    });
  }, 350);
}

export function loadScenes(): Promise<void> {
  if (_loadPromise) return _loadPromise;
  _loadPromise = api<ScenesEnvelope>("/api/ui/scenes")
    .then((envelope) => {
      _state = {
        ..._state,
        loaded: true,
        scenes: envelope.scenes ?? [],
        activeSceneIdBySurface: envelope.activeSceneIdBySurface ?? {},
      };
      _notify();
    })
    .catch((err) => {
      console.warn("[scene-store] load failed", err);
      _state = { ..._state, loaded: true };
      _notify();
    });
  return _loadPromise;
}

export function getActiveScene(surface: SceneSurface): Scene | null {
  const id = _state.activeSceneIdBySurface[surface] ?? null;
  if (!id) return null;
  return _state.scenes.find((s) => s.id === id && s.surface === surface) ?? null;
}

export function setActiveSceneId(surface: SceneSurface, id: string | null): void {
  if (_state.activeSceneIdBySurface[surface] === id) return;
  _state = {
    ..._state,
    activeSceneIdBySurface: { ..._state.activeSceneIdBySurface, [surface]: id },
  };
  _notify();
  _scheduleSave();
}

export function createScene(surface: SceneSurface, name: string, body?: Partial<SceneBody>): Scene {
  const now = Date.now();
  const scene: Scene = {
    id: `scene_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    surface,
    name: name.trim() || "Untitled scene",
    createdAt: now,
    updatedAt: now,
    body: {
      version: 1,
      viewport: body?.viewport ?? null,
      zones: body?.zones ?? [],
      overrides: body?.overrides ?? [],
      fallback: body?.fallback ?? "auto-pack",
    },
  };
  _state = {
    ..._state,
    scenes: [..._state.scenes, scene],
    activeSceneIdBySurface: { ..._state.activeSceneIdBySurface, [surface]: scene.id },
  };
  _notify();
  _scheduleSave();
  return scene;
}

export function updateScene(id: string, patch: Partial<Pick<Scene, "name">> & { body?: Partial<SceneBody> }): void {
  const idx = _state.scenes.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const current = _state.scenes[idx];
  const next: Scene = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    body: patch.body
      ? { ...current.body, ...patch.body }
      : current.body,
    updatedAt: Date.now(),
  };
  const scenes = _state.scenes.slice();
  scenes[idx] = next;
  _state = { ..._state, scenes };
  _notify();
  _scheduleSave();
}

export function deleteScene(id: string): void {
  const scene = _state.scenes.find((s) => s.id === id);
  if (!scene) return;
  const scenes = _state.scenes.filter((s) => s.id !== id);
  const active = { ..._state.activeSceneIdBySurface };
  if (active[scene.surface] === id) active[scene.surface] = null;
  _state = { ..._state, scenes, activeSceneIdBySurface: active };
  _notify();
  _scheduleSave();
}

export function setSceneEditMode(editMode: boolean): void {
  if (_state.editMode === editMode) return;
  _state = { ..._state, editMode };
  _notify();
}

function _subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

function _getSnapshot(): SceneState {
  return _state;
}

export function useSceneStore(): SceneState {
  return useSyncExternalStore(_subscribe, _getSnapshot);
}

/* ── Matcher engine ── */

export type MatcherAgent = {
  id: string;
  harness?: string | null;
  project?: string | null;
  branch?: string | null;
  agentClass?: string | null;
};

export function matchesZone(agent: MatcherAgent, matcher: SceneMatcher): boolean {
  switch (matcher.kind) {
    case "all":
      return true;
    case "harness":
      return (agent.harness ?? "") === matcher.value;
    case "project":
      return (agent.project ?? "") === matcher.value;
    case "branch":
      return (agent.branch ?? "") === matcher.value;
    case "agentClass":
      return (agent.agentClass ?? "") === matcher.value;
    case "agentIds":
      return matcher.ids.includes(agent.id);
    case "and":
      return matcher.of.every((m) => matchesZone(agent, m));
    case "or":
      return matcher.of.some((m) => matchesZone(agent, m));
  }
}

export const UNASSIGNED_ZONE_ID = "__unassigned__";

export function assignAgentsToZones(
  agents: MatcherAgent[],
  zones: SceneZone[],
  overrides: SceneAgentOverride[],
): Map<string, string> {
  const result = new Map<string, string>();
  const overrideMap = new Map(overrides.map((o) => [o.agentId, o]));
  for (const agent of agents) {
    const override = overrideMap.get(agent.id);
    if (override && override.zoneId) {
      result.set(agent.id, override.zoneId);
      continue;
    }
    // First-match precedence
    let assigned: string | null = null;
    for (const zone of zones) {
      if (matchesZone(agent, zone.match)) {
        assigned = zone.id;
        break;
      }
    }
    result.set(agent.id, assigned ?? UNASSIGNED_ZONE_ID);
  }
  return result;
}
