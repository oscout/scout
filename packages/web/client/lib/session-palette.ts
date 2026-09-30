import type { CommandOption } from "@hudsonkit";

import { timeAgoWithSuffix } from "./time.ts";
import type { Route, TailDiscoveredTranscript } from "./types.ts";

/** How far back a session stays jumpable from the palette. */
export const SESSION_PALETTE_WINDOW_MS = 48 * 60 * 60_000;
export const SESSION_PALETTE_LIMIT = 40;

function lastActivity(transcript: TailDiscoveredTranscript): number {
  return transcript.lastEventAt ?? transcript.mtimeMs;
}

function shortSessionId(sessionId: string): string {
  return sessionId.replace(/\.jsonl$/u, "").slice(0, 8);
}

/**
 * ⌘K "Go to session" entries: every top-level harness session touched in the
 * last two days, newest first. The registered-agent entries only reach agents
 * Scout knows by name; most live work is a bare Claude/Codex session, and
 * without these the palette cannot find it.
 */
export function sessionPaletteCommands(
  transcripts: TailDiscoveredTranscript[],
  navigate: (route: Route) => void,
  nowMs: number = Date.now(),
): CommandOption[] {
  const seen = new Set<string>();
  return transcripts
    .filter((transcript) => transcript.sessionId && !transcript.parentSessionId && !transcript.subagentId)
    .filter((transcript) => nowMs - lastActivity(transcript) <= SESSION_PALETTE_WINDOW_MS)
    .sort((left, right) => lastActivity(right) - lastActivity(left))
    .filter((transcript) => {
      const id = transcript.sessionId!;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, SESSION_PALETTE_LIMIT)
    .map((transcript) => {
      const sessionId = transcript.sessionId!;
      const harness = transcript.source?.trim() || "session";
      const project = transcript.project?.trim();
      const parts = [`${harness} ${shortSessionId(sessionId)}`];
      if (project) parts.push(project);
      parts.push(timeAgoWithSuffix(lastActivity(transcript), nowMs));
      return {
        id: `session:open:${sessionId}`,
        label: `Go to session: ${parts.filter(Boolean).join(" · ")}`,
        action: () => navigate({ view: "sessions", sessionId }),
      };
    });
}
