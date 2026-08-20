import { resolveScoutRoutePath } from "./runtime-config.ts";
import type { Agent, SessionCatalogEntry, SessionCatalogWithResume } from "./types.ts";

export type QueueTakeoverInput = {
  command: string;
  cwd?: string | null;
  agentId?: string | null;
};

export async function queueTakeover(input: QueueTakeoverInput): Promise<void> {
  clearPersistedTakeoverSession(input.agentId);
  const response = await fetch(resolveScoutRoutePath("terminalRunPath"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error("Failed to queue takeover");
  }
}

export function activeCatalogSession(
  catalog: SessionCatalogWithResume | null | undefined,
): SessionCatalogEntry | null {
  if (!catalog?.activeSessionId) return null;
  return catalog.sessions.find((session) => session.id === catalog.activeSessionId) ?? null;
}

export function canTakeoverTerminalSession(input: {
  agent?: Pick<Agent, "transport" | "harnessSessionId"> | null;
  catalog?: SessionCatalogWithResume | null;
  session?: SessionCatalogEntry | null;
}): boolean {
  const activeSessionId = input.catalog?.activeSessionId
    ?? (input.agent?.transport === "tmux" ? input.agent.harnessSessionId ?? null : null);
  const session = input.session ?? activeCatalogSession(input.catalog);
  if (input.agent?.transport === "tmux") {
    return Boolean(activeSessionId);
  }
  if (!session || session.id !== activeSessionId) {
    return false;
  }
  return Boolean(input.catalog?.resumeCommand && session.canTakeover);
}

function clearPersistedTakeoverSession(agentId?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("hudson.relay.scout-takeover");
    if (agentId) {
      window.localStorage.removeItem(`hudson.relay.scout-takeover-${agentId}`);
    }
  } catch {}
}
