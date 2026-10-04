/**
 * The bridge between Scout web pages and the Mac app's desktop companion.
 *
 * The companion is a native panel, so the Mac app owns its state: which work
 * items are pinned (in pin order), where the panel sits, whether it is shown
 * or minimized. That state lives in the app's preferences, never in the broker
 * — pins are operator chrome, not coordination records. Two pages talk to it:
 * the companion itself (`/embed/companion`) and the work page when the Mac app
 * hosts it. In a plain browser there is no handler, `companionHostAvailable()`
 * is false, and pages leave out every companion control.
 *
 * Wire format (same shape as host-settings-bridge)
 *   page → host   postMessage({ kind: "companion-request", id, method, params })
 *   host → page   window.__scoutCompanionReply(id, { ok: true, value } | { ok: false, error })
 *   host → page   window.dispatchEvent(new CustomEvent("scout:companion", { detail: CompanionHostState }))
 *                 whenever pins, placement, presence or visibility change.
 *
 * Methods
 *   state                                   → CompanionHostState
 *   pin        { workId, machineId? }       → CompanionHostState  (also shows the panel)
 *   unpin      { workId }                   → CompanionHostState
 *   reorder    { workIds }                  → CompanionHostState  (must be the same set)
 *   minimize   { minimized }                → CompanionHostState
 *   layout     { width, height }            → null   (companion only: size the panel to its content)
 *   drag       { source: "grip" | "mark" }  → null   (companion only: pointer went down; host tracks the
 *                                                    mouse, throws to a corner, and treats an unmoved press
 *                                                    on the mark as the click that expands it)
 *   open       { target, workId, machineId?, conversationId? } → null
 *   hide                                    → CompanionHostState
 *   preferences { restingOpacity?, alwaysOn?, preview?, mode?, originPins?, edgeAnchor? }
 *                                           → CompanionHostState  (companion only)
 *   regions    { regions: [{ id, x, y, width, height }] } → null  (companion only, edge mode: the
 *                                                    page rectangles that take the pointer; the
 *                                                    rest of the band passes through to the desktop)
 *   engage     { engaged }                  → null   (companion only: a menu is open; do not fade)
 *   allow      { kind, id, label? }         → CompanionHostState  (operator grant to surface work here)
 *   disallow   { kind, id }                 → CompanionHostState
 *
 * Surfacing grants are operator choices. They let matching broker work
 * appear in the companion's Surfaced list with a badge; they never show the
 * panel, focus it, or answer anything. Default: no grants.
 *
 * Edge mode only, host → page:
 *   window.dispatchEvent(new CustomEvent("scout:companion-pointer", { detail: { id, outside } }))
 *   — which reported region the pointer is over (WebKit runs no hover in a
 *   panel that is not key), or that a click landed outside every region.
 *
 * The host validates every field again; this module only keeps honest pages
 * from sending junk.
 */

export type CompanionCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type CompanionPin = {
  workId: string;
  machineId?: string | null;
};

export type CompanionScopeKind = "work" | "agent" | "project";

export type CompanionScope = {
  kind: CompanionScopeKind;
  /** Work id, agent id, or absolute project root. */
  id: string;
  label: string | null;
};

export type CompanionMode = "stack" | "edge";
export type CompanionEdgeAnchor = "left" | "right";
export type CompanionDockEdge = "bottom" | "left" | "right" | "hidden";

/**
 * Edge placement the Mac app read from macOS: the band's size, which edge the
 * Dock holds (from the screen's visible-frame insets), and spans of Scout's
 * own windows that reach the edge. Other apps' windows are never in here.
 */
export type CompanionEdgeGeometry = {
  width: number;
  height: number;
  anchor: CompanionEdgeAnchor;
  dock: CompanionDockEdge;
  obstacles: { start: number; end: number; label: string }[];
};

export type CompanionHitRegion = { id: string; x: number; y: number; width: number; height: number };

export type CompanionHostState = {
  pins: CompanionPin[];
  corner: CompanionCorner;
  minimized: boolean;
  /** Whether the companion panel is on screen. */
  visible: boolean;
  /** Panel opacity at rest, 0.25–1. */
  restingOpacity: number;
  /** Keep the mark on screen across launches even with nothing pinned. */
  alwaysOn: boolean;
  scopes: CompanionScope[];
  mode: CompanionMode;
  /** Edge mode: group characters by the conversation that launched them. */
  originPins: boolean;
  edgeAnchor: CompanionEdgeAnchor;
  /** Native-read placement while in edge mode; null otherwise. */
  edge: CompanionEdgeGeometry | null;
};

export const COMPANION_MAX_PINS = 200;
/** Room for every figure (200 pins + surfaced), every origin pin, the
 *  controls and the popover, with headroom. The host enforces the same cap. */
export const COMPANION_MAX_REGIONS = 512;
/** Regions that must survive any trim: what the operator is reading or using. */
const PRIORITY_REGIONS = new Set(["popover", "home"]);
export const DEFAULT_RESTING_OPACITY = 0.55;
export const RESTING_OPACITY_MIN = 0.25;

export type CompanionOpenTarget = "work" | "thread";

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

type HandlerWindow = Window & {
  webkit?: { messageHandlers?: { scoutCompanion?: { postMessage: (body: unknown) => void } } };
  __scoutCompanionReply?: (id: string, reply: Reply) => void;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CORNERS: readonly CompanionCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const SCOPE_KINDS: readonly CompanionScopeKind[] = ["work", "agent", "project"];
export const COMPANION_EVENT = "scout:companion";
export const COMPANION_POINTER_EVENT = "scout:companion-pointer";
const DOCK_EDGES: readonly CompanionDockEdge[] = ["bottom", "left", "right", "hidden"];

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** Narrow the host's edge geometry; anything malformed becomes null. */
export function parseCompanionEdgeGeometry(value: unknown): CompanionEdgeGeometry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const width = finite(raw.width, 1, 20_000);
  const height = finite(raw.height, 1, 20_000);
  if (width === null || height === null) return null;
  const obstacles: CompanionEdgeGeometry["obstacles"] = [];
  for (const entry of Array.isArray(raw.obstacles) ? raw.obstacles.slice(0, 12) : []) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const start = finite(o.start, 0, width);
    const end = finite(o.end, 0, width);
    if (start === null || end === null || end <= start) continue;
    obstacles.push({ start, end, label: typeof o.label === "string" ? o.label.slice(0, 80) : "Scout window" });
  }
  return {
    width,
    height,
    anchor: raw.anchor === "left" ? "left" : "right",
    dock: DOCK_EDGES.includes(raw.dock as CompanionDockEdge) ? raw.dock as CompanionDockEdge : "hidden",
    obstacles,
  };
}

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let sequence = 0;

export function isCompanionId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function handler() {
  if (typeof window === "undefined") return null;
  return (window as HandlerWindow).webkit?.messageHandlers?.scoutCompanion ?? null;
}

/** Same rule as `ScoutCompanionRequest.isValidProjectRoot`. */
export function isCompanionProjectRoot(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && value.length >= 2
    && new TextEncoder().encode(value).length <= 512
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isCompanionScopeId(kind: CompanionScopeKind, id: unknown): id is string {
  return kind === "project" ? isCompanionProjectRoot(id) : isCompanionId(id);
}

export function companionHostAvailable(): boolean {
  return handler() !== null;
}

/** Narrow an untrusted host payload; anything malformed becomes null. */
export function parseCompanionHostState(value: unknown): CompanionHostState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.pins)) return null;
  const pins: CompanionPin[] = [];
  const seen = new Set<string>();
  for (const entry of raw.pins) {
    if (!entry || typeof entry !== "object") continue;
    const pin = entry as Record<string, unknown>;
    if (!isCompanionId(pin.workId) || seen.has(pin.workId)) continue;
    seen.add(pin.workId);
    pins.push({ workId: pin.workId, machineId: isCompanionId(pin.machineId) ? pin.machineId : null });
  }
  const corner = CORNERS.includes(raw.corner as CompanionCorner) ? raw.corner as CompanionCorner : "bottom-right";
  const opacity = typeof raw.restingOpacity === "number" && Number.isFinite(raw.restingOpacity)
    ? Math.min(1, Math.max(RESTING_OPACITY_MIN, raw.restingOpacity))
    : DEFAULT_RESTING_OPACITY;
  const scopes: CompanionScope[] = [];
  const seenScopes = new Set<string>();
  for (const entry of Array.isArray(raw.scopes) ? raw.scopes : []) {
    if (!entry || typeof entry !== "object") continue;
    const scope = entry as Record<string, unknown>;
    const kind = scope.kind as CompanionScopeKind;
    if (!SCOPE_KINDS.includes(kind) || !isCompanionScopeId(kind, scope.id)) continue;
    const key = `${kind}:${scope.id}`;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);
    scopes.push({ kind, id: scope.id, label: typeof scope.label === "string" && scope.label.trim() ? scope.label.trim().slice(0, 80) : null });
  }
  return {
    pins,
    corner,
    minimized: raw.minimized === true,
    visible: raw.visible !== false,
    restingOpacity: opacity,
    alwaysOn: raw.alwaysOn === true,
    scopes,
    mode: raw.mode === "edge" ? "edge" : "stack",
    originPins: raw.originPins !== false,
    edgeAnchor: raw.edgeAnchor === "left" ? "left" : "right",
    edge: raw.mode === "edge" ? parseCompanionEdgeGeometry(raw.edge) : null,
  };
}

function installReply() {
  const w = window as HandlerWindow;
  if (w.__scoutCompanionReply) return;
  w.__scoutCompanionReply = (id, reply) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (reply?.ok) entry.resolve(reply.value);
    else entry.reject(new Error(reply?.error || "The Scout app could not do that."));
  };
}

function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const h = handler();
  if (!h) return Promise.reject(new Error("The desktop companion needs the Scout app."));
  installReply();
  const id = `c${++sequence}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error("The Scout app did not answer."));
    }, 8000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    h.postMessage({ kind: "companion-request", id, method, params: params ?? {} });
  });
}

async function callState(method: string, params?: Record<string, unknown>): Promise<CompanionHostState> {
  const state = parseCompanionHostState(await call<unknown>(method, params));
  if (!state) throw new Error("The Scout app sent an unreadable companion state.");
  return state;
}

export function readCompanionState(): Promise<CompanionHostState> {
  return callState("state");
}

export function pinToCompanion(workId: string, machineId?: string | null): Promise<CompanionHostState> {
  if (!isCompanionId(workId)) return Promise.reject(new Error("That work id cannot be pinned."));
  return callState("pin", isCompanionId(machineId) ? { workId, machineId } : { workId });
}

export function unpinFromCompanion(workId: string): Promise<CompanionHostState> {
  if (!isCompanionId(workId)) return Promise.reject(new Error("That work id cannot be unpinned."));
  return callState("unpin", { workId });
}

export function reorderCompanion(workIds: readonly string[]): Promise<CompanionHostState> {
  return callState("reorder", { workIds: workIds.filter(isCompanionId) });
}

export function setCompanionMinimized(minimized: boolean): Promise<CompanionHostState> {
  return callState("minimize", { minimized });
}

export function hideCompanion(): Promise<CompanionHostState> {
  return callState("hide");
}

export function reportCompanionLayout(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  void call("layout", { width: Math.ceil(width), height: Math.ceil(height) }).catch(() => {});
}

export function beginCompanionDrag(source: "grip" | "mark" = "grip"): void {
  void call("drag", { source }).catch(() => {});
}

export type CompanionPreferences = {
  restingOpacity?: number;
  alwaysOn?: boolean;
  preview?: boolean;
  mode?: CompanionMode;
  originPins?: boolean;
  edgeAnchor?: CompanionEdgeAnchor;
};

export function setCompanionPreferences(prefs: CompanionPreferences): Promise<CompanionHostState> {
  const params: Record<string, unknown> = {};
  if (prefs.mode === "stack" || prefs.mode === "edge") params.mode = prefs.mode;
  if (typeof prefs.originPins === "boolean") params.originPins = prefs.originPins;
  if (prefs.edgeAnchor === "left" || prefs.edgeAnchor === "right") params.edgeAnchor = prefs.edgeAnchor;
  if (typeof prefs.restingOpacity === "number" && Number.isFinite(prefs.restingOpacity)) {
    params.restingOpacity = Math.min(1, Math.max(RESTING_OPACITY_MIN, prefs.restingOpacity));
  }
  if (typeof prefs.alwaysOn === "boolean") params.alwaysOn = prefs.alwaysOn;
  if (prefs.preview) params.preview = true;
  return callState("preferences", params);
}

/**
 * Edge mode: the rectangles that take the pointer, in page points. Anything
 * outside them passes through to the desktop. Invalid entries are dropped
 * here; the host refuses the whole report if one slips through.
 */
export function reportCompanionHitRegions(regions: readonly CompanionHitRegion[]): void {
  const clean = budgetHitRegions(regions)
    .map((r) => ({ id: r.id, x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }));
  void call("regions", { regions: clean }).catch(() => {});
}

/**
 * Valid regions, at most `max`, in their original order (the host treats a
 * later region as drawn on top). Over budget, the popover and home always
 * stay; the rest are kept first to last.
 */
export function budgetHitRegions(regions: readonly CompanionHitRegion[], max = COMPANION_MAX_REGIONS): CompanionHitRegion[] {
  const valid = regions.filter((r) => isCompanionId(r.id)
    && [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n) && Math.abs(n) <= 20_000)
    && r.width > 0 && r.height > 0);
  if (valid.length <= max) return valid;
  const priority = valid.filter((r) => PRIORITY_REGIONS.has(r.id)).slice(0, max);
  let room = max - priority.length;
  return valid.filter((r) => {
    if (PRIORITY_REGIONS.has(r.id)) return priority.includes(r);
    if (room <= 0) return false;
    room -= 1;
    return true;
  });
}

/** Edge mode: the host's pointer reports. Returns the unsubscribe function. */
export function onCompanionPointer(listener: (event: { id: string | null; outside: boolean }) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail as { id?: unknown; outside?: unknown } | null;
    if (!detail || typeof detail !== "object") return;
    listener({ id: isCompanionId(detail.id) ? detail.id : null, outside: detail.outside === true });
  };
  window.addEventListener(COMPANION_POINTER_EVENT, onEvent);
  return () => window.removeEventListener(COMPANION_POINTER_EVENT, onEvent);
}

/** Tell the host a menu or sheet is open, so the panel does not fade under it. */
export function setCompanionEngaged(engaged: boolean): void {
  void call("engage", { engaged }).catch(() => {});
}

export function allowCompanionScope(kind: CompanionScopeKind, id: string, label?: string | null): Promise<CompanionHostState> {
  if (!isCompanionScopeId(kind, id)) return Promise.reject(new Error("That source cannot be allowed."));
  const params: Record<string, unknown> = { kind, id };
  if (label?.trim()) params.label = label.trim().slice(0, 80);
  return callState("allow", params);
}

export function disallowCompanionScope(kind: CompanionScopeKind, id: string): Promise<CompanionHostState> {
  if (!isCompanionScopeId(kind, id)) return Promise.reject(new Error("That source cannot be removed."));
  return callState("disallow", { kind, id });
}

export function openFromCompanion(
  target: CompanionOpenTarget,
  ids: { workId: string; machineId?: string | null; conversationId?: string | null },
): Promise<unknown> {
  if (!isCompanionId(ids.workId)) return Promise.reject(new Error("That work id cannot be opened."));
  const params: Record<string, unknown> = { target, workId: ids.workId };
  if (isCompanionId(ids.machineId)) params.machineId = ids.machineId;
  if (isCompanionId(ids.conversationId)) params.conversationId = ids.conversationId;
  return call("open", params);
}

/** Subscribe to host-pushed state. Returns the unsubscribe function. */
export function onCompanionState(listener: (state: CompanionHostState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onEvent = (event: Event) => {
    const state = parseCompanionHostState((event as CustomEvent).detail);
    if (state) listener(state);
  };
  window.addEventListener(COMPANION_EVENT, onEvent);
  return () => window.removeEventListener(COMPANION_EVENT, onEvent);
}
