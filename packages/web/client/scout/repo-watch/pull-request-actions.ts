/**
 * Shared actions for open-PR rows on Repos (and related surfaces).
 * Click opens a menu — never navigates straight to GitHub.
 *
 * "Assign for review" opens a launch form: project · harness · model · effort,
 * plus an optional existing agent. Without an agent, Scout starts a one-time
 * reviewer on the project path.
 */

import { api } from "../../lib/api.ts";
import { copyTextToClipboard } from "../../lib/clipboard.ts";
import type { MenuItem } from "../../components/ContextMenu.tsx";
import type { Agent } from "../../lib/types.ts";
import type { RepoPullRequestItem } from "./api.ts";

export type PullRequestActionHandlers = {
  /** Open the launch form for this PR. */
  onBeginAssign?: (pr: RepoPullRequestItem) => void;
  /** Select a matching local worktree when the PR head branch is checked out. */
  onSelectWorktreeId?: (worktreeId: string) => void;
  /** Optional: open local diff for a matched worktree path. */
  onOpenDiff?: (path: string) => void;
  /** Status line for the PR panel (success / failure of assign). */
  onStatus?: (message: string | null) => void;
};

export type PullRequestWorktreeMatch = {
  id: string;
  path: string;
  branch: string;
};

export type PullRequestReviewAgent = Pick<
  Agent,
  | "id"
  | "name"
  | "handle"
  | "state"
  | "projectRoot"
  | "cwd"
  | "project"
  | "branch"
  | "harness"
  | "model"
  | "harnessSessionId"
  | "retiredFromFleet"
>;

export type PullRequestLaunchProject = {
  path: string;
  label: string;
};

/** Session continuity when an existing agent is selected. */
export type AssignPullRequestSessionMode = "new" | "existing";

export type AssignPullRequestLaunch = {
  projectPath: string;
  harness?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  /** When set, target this existing agent. When null, start a one-time project session. */
  agent?: PullRequestReviewAgent | null;
  /**
   * Only applies when `agent` is set.
   * - new: fresh harness session for that agent
   * - existing: continue their current harness session when one is known
   */
  sessionMode?: AssignPullRequestSessionMode | null;
};

export const PR_REVIEW_HARNESSES = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "pi", label: "Grok" },
] as const;

export const PR_REVIEW_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
] as const;

export const PR_REVIEW_SESSION_MODES = [
  {
    value: "new" as const,
    label: "New session",
    hint: "Start a fresh harness session for this agent",
  },
  {
    value: "existing" as const,
    label: "Continue session",
    hint: "Resume this agent’s current harness session",
  },
];

export function pullRequestCheckoutCommand(pr: RepoPullRequestItem): string {
  return `gh pr checkout ${pr.number}`;
}

export function pullRequestReviewPrompt(pr: RepoPullRequestItem): string {
  return [
    `Please review pull request #${pr.number}: ${pr.title}`,
    "",
    `URL: ${pr.url}`,
    `Repo: ${pr.repo}`,
    `Branch: ${pr.headRefName || "head"} → ${pr.baseRefName || "base"}`,
    pr.path ? `Local path: ${pr.path}` : null,
    pr.author ? `Author: @${pr.author}` : null,
    pr.isDraft ? "Status: draft" : "Status: open",
    "",
    "Read the diff, summarize the change, call out risks or test gaps, and recommend ship / revise / hold.",
  ].filter((line): line is string => line != null).join("\n");
}

function agentLabel(agent: PullRequestReviewAgent): string {
  return agent.handle?.trim() || agent.name?.trim() || agent.id;
}

function pathMatches(agentPath: string | null | undefined, prPath: string | null | undefined): boolean {
  const left = agentPath?.trim();
  const right = prPath?.trim();
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function agentStateScore(state: string | null | undefined): number {
  switch (state?.trim().toLowerCase()) {
    case "available":
    case "idle":
    case "callable":
      return 40;
    case "active":
    case "working":
    case "running":
    case "in_turn":
    case "in_flight":
      return 20;
    case "queued":
    case "waiting":
    case "waking":
      return 10;
    case "offline":
    case "retired":
    case "stale":
    case "blocked":
      return -50;
    default:
      return 0;
  }
}

/** Rank fleet agents so project/branch matches float first for this PR. */
export function rankAgentsForPullRequest(
  pr: RepoPullRequestItem,
  agents: readonly PullRequestReviewAgent[],
  projectPath?: string | null,
): PullRequestReviewAgent[] {
  const scopePath = projectPath?.trim() || pr.path?.trim() || null;
  const repoLeaf = pr.repo.split("/").pop()?.toLowerCase() ?? "";
  const head = pr.headRefName?.trim() ?? "";

  return agents
    .filter((agent) => !agent.retiredFromFleet)
    .map((agent) => {
      let score = agentStateScore(agent.state);
      if (pathMatches(agent.projectRoot, scopePath) || pathMatches(agent.cwd, scopePath)) {
        score += 1_000;
      }
      if (repoLeaf && agent.project?.trim().toLowerCase() === repoLeaf) {
        score += 400;
      }
      if (head && agent.branch?.trim() === head) {
        score += 200;
      }
      return { agent, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return agentLabel(left.agent).localeCompare(agentLabel(right.agent));
    })
    .map((entry) => entry.agent);
}

/** Project options for the launch form: PR path + repo-watch projects. */
export function projectOptionsForPullRequest(
  pr: RepoPullRequestItem,
  projects: readonly { root: string; name: string }[],
): PullRequestLaunchProject[] {
  const options = new Map<string, string>();
  const prPath = pr.path?.trim();
  if (prPath) {
    const leaf = prPath.split("/").filter(Boolean).at(-1) ?? prPath;
    options.set(prPath, pr.repo || leaf);
  }
  for (const project of projects) {
    const root = project.root?.trim();
    if (!root) continue;
    if (!options.has(root)) {
      options.set(root, project.name?.trim() || root.split("/").filter(Boolean).at(-1) || root);
    }
  }
  return [...options.entries()].map(([path, label]) => ({ path, label }));
}

export function defaultHarnessForLaunch(
  agent: PullRequestReviewAgent | null | undefined,
  prHarnessHint?: string | null,
): string {
  return agent?.harness?.trim()
    || prHarnessHint?.trim()
    || "claude";
}

export function defaultModelForLaunch(agent: PullRequestReviewAgent | null | undefined): string {
  return agent?.model?.trim() || "";
}

export function modelOptionsForLaunch(
  agents: readonly PullRequestReviewAgent[],
  selected: PullRequestReviewAgent | null | undefined,
): string[] {
  const options = new Set<string>();
  const selectedModel = selected?.model?.trim();
  if (selectedModel) options.add(selectedModel);
  for (const agent of agents) {
    const model = agent.model?.trim();
    if (model) options.add(model);
  }
  return [...options];
}

export type AssignPullRequestResult = {
  message: string;
  flightId: string | null;
  conversationId: string | null;
  targetAgentId: string | null;
  targetLabel: string;
};

function compactExecution(launch: AssignPullRequestLaunch): {
  harness?: string;
  model?: string;
  reasoningEffort?: string;
} {
  const harness = launch.harness?.trim() || undefined;
  const model = launch.model?.trim() || undefined;
  const reasoningEffort = launch.reasoningEffort?.trim() || undefined;
  return {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * Dispatch a PR review via session initiation so we can control
 * project · harness · model · effort · new/existing session.
 *
 * - With agent + existing: continue their harness session when known
 * - With agent + new: fresh session on that agent
 * - Without agent: one-time session on the project path
 */
export async function assignPullRequestForReview(
  pr: RepoPullRequestItem,
  launch: AssignPullRequestLaunch,
): Promise<AssignPullRequestResult> {
  const instructions = pullRequestReviewPrompt(pr);
  const projectPath = launch.projectPath.trim();
  if (!projectPath) {
    throw new Error("Pick a project path for the review.");
  }
  const execution = compactExecution(launch);
  const agent = launch.agent ?? null;
  const sessionMode: AssignPullRequestSessionMode = agent
    ? (launch.sessionMode === "existing" ? "existing" : "new")
    : "new";

  if (agent && sessionMode === "existing") {
    const existingSessionId = agent.harnessSessionId?.trim();
    if (!existingSessionId) {
      throw new Error(
        `@${agentLabel(agent)} has no live harness session to continue. Pick “New session” instead.`,
      );
    }
  }

  const result = await api<{
    conversationId?: string | null;
    flight?: { id?: string | null; targetAgentId?: string | null } | null;
    flightId?: string | null;
    targetAgentId?: string | null;
    targetLabel?: string | null;
    agentId?: string | null;
  }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      target: agent
        ? {
            agentId: agent.id,
            projectPath,
          }
        : { projectPath },
      execution: {
        session: sessionMode,
        ...(sessionMode === "existing" && agent?.harnessSessionId?.trim()
          ? { targetSessionId: agent.harnessSessionId.trim() }
          : {}),
        ...execution,
      },
      agent: {
        persistence: agent ? "sticky" : "one_time",
        ...(agent?.handle?.trim() ? { handle: agent.handle.trim() } : {}),
      },
      seed: { instructions },
    }),
  });

  const flightId = result.flightId ?? result.flight?.id ?? null;
  const targetAgentId = result.targetAgentId
    ?? result.flight?.targetAgentId
    ?? result.agentId
    ?? agent?.id
    ?? null;
  const resolvedLabel = result.targetLabel?.trim()
    || (agent ? agentLabel(agent) : null)
    || (targetAgentId ? targetAgentId : "one-time reviewer");
  const sessionLabel = agent
    ? (sessionMode === "existing" ? "continue" : "new session")
    : "one-time";

  return {
    message: [
      `Assigned #${pr.number} for review → ${resolvedLabel.startsWith("@") ? resolvedLabel : `@${resolvedLabel}`}`,
      `· ${sessionLabel}`,
      execution.harness ? `· ${execution.harness}` : null,
      execution.model ? `· ${execution.model}` : null,
      execution.reasoningEffort ? `· ${execution.reasoningEffort}` : null,
      flightId ? `· ${flightId}` : null,
    ].filter(Boolean).join(" "),
    flightId,
    conversationId: result.conversationId ?? null,
    targetAgentId,
    targetLabel: resolvedLabel,
  };
}

export function openPullRequestOnGitHub(pr: RepoPullRequestItem): void {
  window.open(pr.url, "_blank", "noopener,noreferrer");
}

export function buildPullRequestMenuItems(
  pr: RepoPullRequestItem,
  options: PullRequestActionHandlers & {
    matchingWorktree?: PullRequestWorktreeMatch | null;
  } = {},
): MenuItem[] {
  const { matchingWorktree, onBeginAssign, onSelectWorktreeId, onOpenDiff, onStatus } = options;
  const items: MenuItem[] = [];

  if (onBeginAssign) {
    items.push({
      kind: "action",
      label: "Assign for review…",
      onSelect: () => onBeginAssign(pr),
    });
  }

  items.push({
    kind: "action",
    label: "Open on GitHub",
    onSelect: () => openPullRequestOnGitHub(pr),
  });

  if (matchingWorktree && onSelectWorktreeId) {
    items.push({
      kind: "action",
      label: `Select worktree · ${matchingWorktree.branch}`,
      onSelect: () => onSelectWorktreeId(matchingWorktree.id),
    });
  }
  if (matchingWorktree && onOpenDiff) {
    items.push({
      kind: "action",
      label: "Open local diff",
      onSelect: () => onOpenDiff(matchingWorktree.path),
    });
  }

  items.push(
    { kind: "separator" },
    {
      kind: "action",
      label: "Copy link",
      onSelect: () => {
        void copyTextToClipboard(pr.url).then((ok) => {
          onStatus?.(ok ? `Copied link for #${pr.number}` : `Could not copy link for #${pr.number}`);
        });
      },
    },
    {
      kind: "action",
      label: "Copy checkout command",
      onSelect: () => {
        void copyTextToClipboard(pullRequestCheckoutCommand(pr)).then((ok) => {
          onStatus?.(ok
            ? `Copied: ${pullRequestCheckoutCommand(pr)}`
            : `Could not copy checkout command for #${pr.number}`);
        });
      },
    },
    {
      kind: "action",
      label: "Copy title",
      onSelect: () => {
        void copyTextToClipboard(`#${pr.number} ${pr.title}`).then((ok) => {
          onStatus?.(ok ? `Copied title for #${pr.number}` : `Could not copy title for #${pr.number}`);
        });
      },
    },
  );

  return items;
}
