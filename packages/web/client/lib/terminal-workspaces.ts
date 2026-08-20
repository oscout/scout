import type {
  TerminalWorkspaceCell,
  TerminalWorkspaceRecord,
  TerminalWorkspaceRecordInput,
  TerminalWorkspaceResolution,
} from "@openscout/protocol";

import { api } from "./api.ts";

export type {
  TerminalWorkspaceCell,
  TerminalWorkspaceRecord,
  TerminalWorkspaceRecordInput,
  TerminalWorkspaceResolution,
};

export type TerminalWorkspacesPayload = {
  ok: true;
  count: number;
  workspaces: TerminalWorkspaceRecord[];
  resolutions: TerminalWorkspaceResolution[];
};

export async function fetchTerminalWorkspaces(): Promise<TerminalWorkspacesPayload> {
  return api<TerminalWorkspacesPayload>("/api/terminal-workspaces");
}

export async function saveTerminalWorkspace(
  input: TerminalWorkspaceRecordInput & { id: string },
): Promise<TerminalWorkspaceRecord> {
  const payload = await api<{ ok: true; workspace: TerminalWorkspaceRecord }>(
    `/api/terminal-workspaces/${encodeURIComponent(input.id)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return payload.workspace;
}

export type TerminalWorkspaceReviveResult = {
  ok: boolean;
  revived: boolean;
  /**
   * `started` is a session that came back WITHOUT the harness the cell asked
   * for — a bare shell where the agent used to be. It is deliberately not
   * `live`: an operator who saved an agent tile and got a shell has to be told
   * that, not shown a green tile.
   */
  status: "live" | "started" | "revivable" | "unavailable";
  /** Whether the saved resume command actually ran. Null when there was none. */
  resumed?: boolean | null;
  sessionName?: string;
  detail?: string;
};

/** Ask the server to start a saved cell's host session again. */
export async function reviveTerminalWorkspaceCell(
  workspaceId: string,
  cellId: string,
): Promise<TerminalWorkspaceReviveResult> {
  return api<TerminalWorkspaceReviveResult>(
    `/api/terminal-workspaces/${encodeURIComponent(workspaceId)}/cells/${encodeURIComponent(cellId)}/revive`,
    { method: "POST", body: "{}" },
  );
}

export async function removeTerminalWorkspace(id: string): Promise<boolean> {
  const payload = await api<{ ok: true; deleted: boolean }>(
    `/api/terminal-workspaces/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  return payload.deleted;
}

/**
 * Reconciliation status for one cell, keyed by cell id.
 *
 * The server decides live / revivable / unavailable, because that judgement
 * depends on the host inventory, which only the server can see. Clients render
 * the answer; they never re-derive it.
 */
export function terminalWorkspaceCellStatuses(
  resolution: TerminalWorkspaceResolution | null | undefined,
): Map<string, TerminalWorkspaceResolution["cells"][number]> {
  const statuses = new Map<string, TerminalWorkspaceResolution["cells"][number]>();
  for (const cell of resolution?.cells ?? []) statuses.set(cell.cellId, cell);
  return statuses;
}
