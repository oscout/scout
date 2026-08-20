import { legacyTerminalSurfaceKey, parseTerminalSurfaceId } from "@openscout/protocol";
import type { TerminalSessionRecord, TerminalSurface } from "@openscout/protocol";
import { surfaceKey } from "../../lib/terminal-sessions.ts";

export type ProjectSessionTmuxTarget = {
  terminalSessionId: string;
  terminalSurfaceKey: string;
  sessionName: string;
};

export type ProjectSessionTerminalHints = {
  agentId?: string | null;
  sessionRefs: Array<string | null | undefined>;
};

function cleanRef(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split(/[\\/]/u).filter(Boolean).at(-1) ?? trimmed;
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function tmuxSurfaces(session: TerminalSessionRecord): TerminalSurface[] {
  return session.surfaces.filter((surface) => surface.backend === "tmux");
}

function target(session: TerminalSessionRecord, surface: TerminalSurface): ProjectSessionTmuxTarget {
  return {
    terminalSessionId: session.id,
    terminalSurfaceKey: surfaceKey(surface),
    sessionName: surface.sessionName,
  };
}

/** Resolve a project-session identity to an exact live tmux surface. */
export function resolveProjectSessionTmuxTarget(
  sessions: TerminalSessionRecord[],
  hints: ProjectSessionTerminalHints,
): ProjectSessionTmuxTarget | null {
  const agentId = cleanRef(hints.agentId);
  const refs = new Set(hints.sessionRefs.map(cleanRef).filter((value): value is string => Boolean(value)));
  const definitionId = agentId?.split(".", 1)[0] ?? null;
  if (definitionId?.startsWith("session-")) refs.add(definitionId);

  // Nothing binds a registry record to an agent id yet, so matching happens on
  // session refs alone. Restore a direct agent lookup once the workspace record
  // carries that binding.
  for (const session of sessions) {
    const surface = tmuxSurfaces(session).find((candidate) => refs.has(candidate.sessionName));
    if (surface) return target(session, surface);
  }

  return null;
}

/**
 * `scout://terminal` link for the native app, or null when this target cannot
 * be expressed in a form that app understands.
 *
 * The surface travels as the LEGACY `backend:sessionName` key, not the opaque
 * handle the rest of the web now carries. This is the one boundary where the
 * two must differ: macOS's handler accepts only the legacy prefixes
 * (`ScoutTerminalDeepLink.swift`) and returns nil for anything else, so an
 * opaque handle here is a link that silently does nothing — and macOS is not
 * something a web release can update in step. `legacyTerminalSurfaceKey` exists
 * for exactly this and had no callers.
 *
 * The legacy form addresses a session, not a pane, which is all the native
 * handler routes on anyway. Null when the handle will not parse, so a caller
 * hides the link rather than rendering an href that goes nowhere.
 */
export function nativeTerminalDeepLink(
  target: ProjectSessionTmuxTarget,
  mode: "observe" | "takeover",
): string | null {
  const address = parseTerminalSurfaceId(target.terminalSurfaceKey);
  if (!address) return null;
  const params = new URLSearchParams({
    session: target.terminalSessionId,
    surface: legacyTerminalSurfaceKey(address),
    mode,
  });
  return `scout://terminal?${params.toString()}`;
}
