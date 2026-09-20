/**
 * "Hop into terminal" — the shared model behind every surface that shows an
 * agent/session.
 *
 * Three destinations, all resolved from the same inventory
 * (`/api/terminal-sessions?includeDiscovered=1`):
 *
 * - **web**: the embedded terminal route (`view: "terminal"`), takeover mode.
 * - **native**: the `scout://terminal` deep link — the macOS app's embedded
 *   terminal. The surface key must be the LEGACY `backend:name` form; the
 *   app's handler rejects opaque ids (see ScoutTerminalDeepLink.swift).
 * - **local**: the surface's own attach argv spawned in the operator's real
 *   terminal app via `/api/terminal-sessions/open-local` — or, for a herdr
 *   pane, a focus call into the running herdr client.
 */

import {
  legacyTerminalSurfaceKey,
  parseTerminalSurfaceId,
  resolveSessionTerminalSurface,
  type SessionTerminalHints,
  type TerminalSessionRecord,
  type TerminalSurface,
  type TerminalSurfaceId,
} from "@openscout/protocol";

import { api, peekApiGet } from "./api.ts";
import { fetchTerminalSessions, surfaceKey } from "./terminal-sessions.ts";
import type { Route } from "./types.ts";

export type { SessionTerminalHints };

export type SessionTerminalTarget = {
  session: TerminalSessionRecord;
  surface: TerminalSurface;
  surfaceKey: TerminalSurfaceId;
  via: "sourceSessionId" | "metadata" | "sessionName";
};

const INVENTORY_PATH = "/api/terminal-sessions?includeDiscovered=1";
const INVENTORY_TTL_MS = 15_000;

let inventorySnapshot: { at: number; sessions: TerminalSessionRecord[] } | null = null;
const inventoryListeners = new Set<() => void>();
export function subscribeTerminalSessionInventory(listener: () => void): () => void {
  inventoryListeners.add(listener);
  return () => { inventoryListeners.delete(listener); };
}

let inventoryFlight: Promise<TerminalSessionRecord[]> | null = null;

/** Warm inventory if the cache is fresh; null when a fetch is still needed. */
export function peekTerminalSessionInventory(): TerminalSessionRecord[] | null {
  if (inventorySnapshot && Date.now() - inventorySnapshot.at < INVENTORY_TTL_MS) {
    return inventorySnapshot.sessions;
  }
  return peekApiGet<{ sessions: TerminalSessionRecord[] }>(INVENTORY_PATH, INVENTORY_TTL_MS)?.sessions ?? null;
}

/** One fetch coalesced across every hop control on the screen. */
export function getTerminalSessionInventory(): Promise<TerminalSessionRecord[]> {
  const peeked = peekTerminalSessionInventory();
  if (peeked) return Promise.resolve(peeked);
  inventoryFlight ??= fetchTerminalSessions({ includeDiscovered: true })
    .then((sessions) => {
      inventorySnapshot = { at: Date.now(), sessions };
      for (const listener of inventoryListeners) listener();
      return sessions;
    })
    .finally(() => {
      inventoryFlight = null;
    });
  return inventoryFlight;
}

/** Best-effort prefetch; call on hover so a click resolves instantly. */
export function warmTerminalSessionInventory(): void {
  void getTerminalSessionInventory().catch(() => {});
}

export function resolveSessionTerminalTarget(
  sessions: readonly TerminalSessionRecord[],
  hints: SessionTerminalHints,
): SessionTerminalTarget | null {
  const hit = resolveSessionTerminalSurface(sessions, hints);
  if (!hit) return null;
  return {
    session: hit.session,
    surface: hit.surface,
    surfaceKey: surfaceKey(hit.surface),
    via: hit.via,
  };
}

/**
 * `scout://terminal` link for the native app, or null when the surface id
 * cannot be expressed in the legacy form the app's handler accepts. Callers
 * hide the action rather than render a link that opens nothing.
 */
export function terminalHopDeepLink(
  target: SessionTerminalTarget,
  mode: "observe" | "takeover" = "takeover",
): string | null {
  const address = parseTerminalSurfaceId(target.surfaceKey);
  if (!address) return null;
  const params = new URLSearchParams({
    session: target.session.id,
    surface: legacyTerminalSurfaceKey(address),
    mode,
  });
  return `scout://terminal?${params.toString()}`;
}

/**
 * The embedded-terminal route for a hop. Falls back to the agentId takeover
 * route when no surface resolved — the terminal screen's bootstrap resolves
 * or creates the agent's terminal there.
 */
export function terminalHopRoute(
  target: SessionTerminalTarget | null,
  agentId: string | null | undefined,
): Route | null {
  if (target) {
    return {
      view: "terminal",
      terminalSessionId: target.session.id,
      terminalSurfaceKey: target.surfaceKey,
      mode: "takeover",
    };
  }
  if (agentId) return { view: "terminal", agentId, mode: "takeover" };
  return null;
}

/** Spawn the surface's attach argv in the operator's real terminal app. */
export async function requestLocalTerminalOpen(target: SessionTerminalTarget): Promise<{ app: string }> {
  return api<{ ok: boolean; app: string }>("/api/terminal-sessions/open-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ surface: target.surfaceKey }),
  });
}

/**
 * Focus a pane inside the running herdr client — the sharpest hop a herdr
 * surface supports. Only callable with a pane target; session-level herdr hops
 * use the attach argv like every other backend.
 */
export async function requestHerdrPaneFocus(target: SessionTerminalTarget): Promise<void> {
  await api<{ ok: boolean; error?: string }>(
    `/api/terminal-hosts/herdr/sessions/${encodeURIComponent(target.surface.sessionName)}/focus`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: target.surface.paneId ?? target.surface.sessionName }),
    },
  );
}

/** Whether a surface can hand off to the running herdr client. */
export function herdrFocusableSurface(target: SessionTerminalTarget): boolean {
  return target.surface.backend === "herdr" && Boolean(target.surface.paneId);
}
