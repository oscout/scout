import type { HerdrSessionTopology } from "@openscout/protocol";

import { isAgentInTurn } from "../../lib/agent-state.ts";
import type { TerminalListItem } from "../../lib/terminal-sessions.ts";
import type { Agent } from "../../lib/types.ts";
import { isStoppedHostItem } from "./terminal-nav-model.ts";

/**
 * What one rail row says. The row stops describing how a terminal is hosted
 * (session name, full path, backend badge) and says what is there: who is
 * working in it, what they last did, and where. Pure, so the wording rules are
 * testable without a React runtime.
 */
export type TerminalNavRowMark =
  | { kind: "herdr" }
  | { kind: "harness"; harness: string }
  | { kind: "shell" };

export type TerminalNavPaneGroup = {
  harness: string;
  count: number;
  working: number;
};

export type TerminalNavHerdrSummary = {
  panes: TerminalNavPaneGroup[];
  paneCount: number;
  working: number;
  /** Leaf of the directory most panes are in, when any report one. */
  project: string | null;
};

export type TerminalNavRowModel = {
  mark: TerminalNavRowMark;
  title: string;
  /** Short name that still matches `tmux ls` / `herdr session list`. */
  handle: string;
  working: boolean;
  panes: TerminalNavHerdrSummary | null;
};

/**
 * Harnesses the rail has a mark for, by the names hosts report them under
 * (herdr says "claude", a registry record may say "claude-code"). Anything
 * else — "tmux", "zsh", a backend name standing in for a harness — is a plain
 * terminal. Kept local rather than importing HarnessMark's normalizer so this
 * module stays free of JSX for bun tests.
 */
const MARKED_HARNESS_ALIASES: Record<string, string> = {
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  openai: "codex",
  grok: "grok",
  xai: "grok",
  opencode: "opencode",
  oc: "opencode",
  pi: "pi",
  omp: "pi",
  gemini: "gemini",
  kimi: "kimi",
  cursor: "cursor",
  amp: "amp",
};

export function markedHarness(harness: string | null | undefined): string | null {
  const raw = harness?.trim().toLowerCase();
  if (!raw) return null;
  const base = raw.replace(/[\s(].*$/u, "").replace(/[_-].*$/u, "");
  return MARKED_HARNESS_ALIASES[base] ?? null;
}

/**
 * Generated session names carry one readable part: `session-mulg1xl0-bvteeb`
 * is known by `mulg1xl0`, `relay-call-clean-232702-arts-mini-claude` by
 * `call-clean-232702`. Operator-chosen names are already short.
 */
export function terminalNavHandle(sessionName: string): string {
  const generated = /^session-([a-z0-9]{6,})-[a-z0-9]+$/iu.exec(sessionName);
  if (generated?.[1]) return generated[1];
  const relay = /^relay-(.+?)(?:-[a-z0-9]+-mini)?-(?:claude|codex|grok|opencode)$/iu.exec(sessionName);
  if (relay?.[1]) return relay[1];
  return sessionName;
}

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  const end = trimmed.search(/[.!?](?:\s|$)/u);
  return end > 0 ? trimmed.slice(0, end + 1) : trimmed;
}

/** An agent named after its session ("Session Mulg1xl0 Bvteeb") says nothing new. */
function meaningfulName(name: string, sessionName: string): string | null {
  const flatten = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  return flatten(name) === flatten(sessionName) ? null : name;
}

/** The agent's latest broker activity, as one line. */
function latestActivitySummary(agent: Agent): string | null {
  const latest = [...(agent.brokerActivity ?? [])]
    .filter((entry) => entry.summary?.trim())
    .sort((left, right) => right.at - left.at)[0];
  return latest ? firstSentence(latest.summary) : null;
}

/**
 * One herdr session's panes, grouped by harness in order of first appearance.
 * Plain shells are counted in the pane total but get no harness chip.
 */
export function summarizeHerdrTopology(topology: HerdrSessionTopology | null | undefined): TerminalNavHerdrSummary | null {
  if (!topology?.running) return null;
  const groups = new Map<string, TerminalNavPaneGroup>();
  const directories = new Map<string, number>();
  let paneCount = 0;
  let working = 0;
  for (const workspace of topology.workspaces) {
    for (const tab of workspace.tabs) {
      for (const pane of tab.panes) {
        paneCount += 1;
        const isWorking = pane.agentStatus === "working";
        if (isWorking) working += 1;
        const directory = pane.foregroundCwd ?? pane.cwd;
        if (directory) directories.set(directory, (directories.get(directory) ?? 0) + 1);
        const harness = markedHarness(pane.agent);
        if (!harness) continue;
        const group = groups.get(harness) ?? { harness, count: 0, working: 0 };
        group.count += 1;
        if (isWorking) group.working += 1;
        groups.set(harness, group);
      }
    }
  }
  const topDirectory = [...directories.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  const project = topDirectory?.replace(/\/+$/u, "").split("/").pop() || null;
  return { panes: [...groups.values()], paneCount, working, project };
}

export function terminalNavRow(
  item: TerminalListItem,
  owner: Agent | null,
  herdr: TerminalNavHerdrSummary | null,
): TerminalNavRowModel {
  const handle = terminalNavHandle(item.surface.sessionName);
  const harness = markedHarness(owner?.harness) ?? markedHarness(item.session.harness);
  const mark: TerminalNavRowMark = item.surface.backend === "herdr"
    ? { kind: "herdr" }
    : harness
      ? { kind: "harness", harness }
      : { kind: "shell" };
  const working = Boolean((owner && isAgentInTurn(owner.state, owner)) || (herdr && herdr.working > 0));

  // A herdr session's name is the operator's own and says what it is for;
  // its panes say who is in it. Everything else leads with what happened.
  if (item.surface.backend === "herdr") {
    const handle = isStoppedHostItem(item) ? "herdr · stopped" : "herdr";
    return { mark, title: item.surface.sessionName, handle, working, panes: herdr };
  }
  // Claude Code sets its process title to its version, so a pane running it
  // reports "2.1.280" as the current command; that is never a useful title.
  const reportedCommand = typeof item.session.metadata?.currentCommand === "string"
    ? item.session.metadata.currentCommand.trim()
    : "";
  const currentCommand = /^\d+(?:\.\d+)+$/u.test(reportedCommand) ? "" : reportedCommand;
  const told = owner?.pendingAsk?.trim()
    ? firstSentence(owner.pendingAsk)
    : (owner ? latestActivitySummary(owner) ?? meaningfulName(owner.name, item.surface.sessionName) : null)
      ?? (currentCommand && !markedHarness(currentCommand) ? currentCommand : null);
  if (told) return { mark, title: told, handle, working, panes: null };
  // Nothing says what happened here. A generated name reads better as its
  // short handle ("mulg1xl0", not "Session Mulg1xl0 Bvteeb"), and the detail
  // line names the harness instead of repeating it.
  if (handle !== item.surface.sessionName) {
    return { mark, title: handle, handle: harness ?? item.surface.backend, working, panes: null };
  }
  return { mark, title: item.title, handle, working, panes: null };
}
