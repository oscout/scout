/**
 * Terminal sessions hosted in herdr that are blocked on a prompt.
 *
 * herdr reports each pane's agent status itself (`blocked` = the agent stopped
 * for input or a permission prompt), so this does not guess from timing. The
 * pane's visible text is read — never written to — to say what it is asking.
 * Answering stays with the operator at the terminal: Scout does not type into
 * a pane it does not own.
 */

import type { HerdrPaneProjection } from "@openscout/protocol";
import { readHerdrSessions, readHerdrTopology } from "@openscout/runtime/system-probes";

import { herdrTerminalHost } from "../../terminal-hosts/herdr.ts";
import { detectClaudeTmuxHostAttention } from "./tmux-host-attention.ts";

export type HerdrHostAttentionItem = {
  id: string;
  /** The harness's own session id when herdr knows it, else the pane id. */
  sessionId: string;
  sessionName: string;
  harness: string;
  title: string;
  summary: string;
  detail: string | null;
  /** Where the prompt is: `<herdr session> · <pane>`. */
  location: string;
  updatedAt: number;
};

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/gu;
const PROMPT_TAIL_LINES = 8;
const MAX_PANES = 16;

export async function collectHerdrHostAttention(
  options: { now?: number } = {},
): Promise<HerdrHostAttentionItem[]> {
  const now = options.now ?? Date.now();
  const sessions = await readHerdrSessions().catch(() => []);
  const blocked: Array<{ session: string; pane: HerdrPaneProjection }> = [];
  for (const session of sessions) {
    if (!session.running) continue;
    const topology = await readHerdrTopology(session.name).catch(() => null);
    if (!topology?.running) continue;
    for (const workspace of topology.workspaces) {
      for (const tab of workspace.tabs) {
        for (const pane of tab.panes) {
          if (pane.agentStatus === "blocked") blocked.push({ session: session.name, pane });
        }
      }
    }
  }

  const items = await Promise.all(blocked.slice(0, MAX_PANES).map(async ({ session, pane }) => {
    const text = await herdrTerminalHost.capture?.({ sessionName: session, paneId: pane.paneId })
      .catch(() => null) ?? null;
    return herdrAttentionItem(session, pane, text, now);
  }));
  return items;
}

export function herdrAttentionItem(
  session: string,
  pane: HerdrPaneProjection,
  paneText: string | null,
  now: number,
): HerdrHostAttentionItem {
  const harness = pane.agent ?? pane.agentSession?.agent ?? "terminal";
  const sessionId = pane.agentSession?.value ?? `${session}:${pane.paneId}`;
  const sessionName = pane.name ?? pane.label ?? pane.paneId;
  const location = `${session} · ${pane.paneId}`;
  const base = { sessionId, sessionName, harness, location, updatedAt: now };

  const claude = paneText && harness === "claude"
    ? detectClaudeTmuxHostAttention(paneText, { agentId: sessionId, agentName: sessionName, sessionId, now })
    : null;
  if (claude) {
    return {
      ...base,
      id: `herdr-permission:${session}:${pane.paneId}:${sessionId}`,
      title: claude.title,
      summary: claude.summary,
      detail: claude.detail,
    };
  }

  return {
    ...base,
    id: `herdr-blocked:${session}:${pane.paneId}:${sessionId}`,
    title: `${capitalize(harness)} is waiting for input`,
    summary: promptTail(paneText) ?? "The terminal is waiting for input.",
    detail: null,
  };
}

/** The last few non-empty lines — where a terminal prompt puts its question. */
function promptTail(text: string | null): string | null {
  if (!text) return null;
  const lines = text.replace(ANSI, "").replaceAll("\r", "").split("\n")
    .map((line) => line.replace(/[│┃╭╮╰╯─━]+/gu, " ").trimEnd())
    .filter((line) => line.trim().length > 0);
  const tail = lines.slice(-PROMPT_TAIL_LINES).map((line) => line.trim()).join("\n");
  return tail || null;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
