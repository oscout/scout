import { resolve } from "node:path";

import { epochMs } from "@openscout/protocol";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  loadScoutAttentionReport,
  type ScoutAttentionEvidence,
  type ScoutAttentionProject,
  type ScoutAttentionReport,
} from "../../core/broker/attention.ts";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const DEFAULT_ATTENTION_SINCE_MS = 2 * 24 * 60 * 60 * 1000;
const DEFAULT_ATTENTION_LIMIT = 8;

export type ScoutAttentionCommandOptions =
  | { command: "help" }
  | {
      command: "report";
      since: number;
      limit: number;
      projectRoots: string[];
      includeGit: boolean;
      json: boolean;
    };

export function renderAttentionCommandHelp(): string {
  return [
    "Usage: scout attention [--since <time>] [--project <path>] [--limit <count>] [--no-git] [--json]",
    "",
    "Show an on-demand attention report for recent unfinished Scout work and local git diffs.",
    "",
    "Signals:",
    "  Scout-owned open questions and work items",
    "  Active, waiting, failed, cancelled, or risky completed flights",
    "  Recent Scout messages that mention blockers, failed checks, approvals, or unrun tests",
    "  Local git dirty worktrees and branches ahead of upstream",
    "",
    "Options:",
    "  --since <time>        Unix time, date, or duration like 2d, 12h, 30m (default 2d)",
    "  --project <path>      Limit to one project path; repeatable",
    `  --limit <count>       Maximum projects to print (default ${DEFAULT_ATTENTION_LIMIT})`,
    "  --no-git              Skip local git probes",
    "",
    "Examples:",
    "  scout attention",
    "  scout attention --since 12h",
    "  scout attention --project ~/dev/openscout --json",
  ].join("\n");
}

export function parseAttentionCommandOptions(
  args: string[],
  input: { cwd: string; now?: number },
): ScoutAttentionCommandOptions {
  if (args.length === 0) {
    return {
      command: "report",
      since: (input.now ?? Date.now()) - DEFAULT_ATTENTION_SINCE_MS,
      limit: DEFAULT_ATTENTION_LIMIT,
      projectRoots: [],
      includeGit: true,
      json: false,
    };
  }
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    return { command: "help" };
  }

  const projectRoots: string[] = [];
  let since = (input.now ?? Date.now()) - DEFAULT_ATTENTION_SINCE_MS;
  let limit = DEFAULT_ATTENTION_LIMIT;
  let includeGit = true;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--no-git") {
      includeGit = false;
      continue;
    }
    if (arg === "--since") {
      const value = args[index + 1];
      if (!value) throw new ScoutCliError("--since requires a timestamp or duration");
      since = parseAttentionSince(value, input.now);
      index += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      since = parseAttentionSince(arg.slice("--since=".length), input.now);
      continue;
    }
    if (arg === "--project") {
      const value = args[index + 1];
      if (!value) throw new ScoutCliError("--project requires a path");
      projectRoots.push(resolveProjectPath(input.cwd, value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      projectRoots.push(resolveProjectPath(input.cwd, arg.slice("--project=".length)));
      continue;
    }
    if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) throw new ScoutCliError("--limit requires a count");
      limit = parseAttentionLimit(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseAttentionLimit(arg.slice("--limit=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ScoutCliError(`unknown attention option: ${arg}`);
    }
    throw new ScoutCliError(`unexpected argument for attention: ${arg}`);
  }

  return {
    command: "report",
    since,
    limit,
    projectRoots,
    includeGit,
    json,
  };
}

export async function runAttentionCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  const options = parseAttentionCommandOptions(args, { cwd: context.cwd });
  if (options.command === "help") {
    context.output.writeText(renderAttentionCommandHelp());
    return;
  }

  const report = await loadScoutAttentionReport({
    since: options.since,
    currentDirectory: context.cwd,
    projectRoots: options.projectRoots,
    includeGit: options.includeGit,
  });
  const limitedReport = limitAttentionReport(report, options.limit);
  if (options.json && context.output.mode !== "json") {
    context.stdout(JSON.stringify(limitedReport, null, 2));
    return;
  }
  context.output.writeValue(limitedReport, renderAttentionReport);
}

export function renderAttentionReport(report: ScoutAttentionReport): string {
  const windowLabel = formatDuration(report.generatedAt - report.since);
  const lines = [
    `Attention Report - last ${windowLabel}`,
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
  ];

  if (!report.brokerReachable) {
    lines.push("Scout broker: unavailable; showing local git signals only.");
  }

  if (report.projects.length === 0) {
    lines.push("");
    lines.push("No open loops found for this window.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(
    `Projects: ${report.counts.projects} - Evidence: ${report.counts.evidence} - Git: ${report.counts.gitProjects}`,
  );

  report.projects.forEach((project, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${project.projectName}`);
    lines.push(`   Status: ${project.status.replace("_", " ")} - score ${project.score}`);
    lines.push(`   Path: ${project.projectRoot ?? "unscoped"}`);
    lines.push(`   Last activity: ${formatAge(project.lastActivityAt, report.generatedAt)}`);
    if (project.reasons.length > 0) {
      lines.push(`   Why: ${project.reasons.slice(0, 4).join("; ")}`);
    }
    if (project.agents.length > 0) {
      lines.push(`   Agents: ${project.agents.slice(0, 5).join(", ")}`);
    }
    if (project.git) {
      lines.push(`   Git: ${renderGitLine(project)}`);
    }
    lines.push("   Evidence:");
    for (const evidence of project.evidence.slice(0, 6)) {
      lines.push(`   - ${renderEvidenceLine(evidence, report.generatedAt)}`);
    }
    if (project.evidence.length > 6) {
      lines.push(`   - ${project.evidence.length - 6} more signals`);
    }
    lines.push(`   Next: ${project.nextAction}`);
  });

  return lines.join("\n");
}

function limitAttentionReport(
  report: ScoutAttentionReport,
  limit: number,
): ScoutAttentionReport {
  if (report.projects.length <= limit) return report;
  const projects = report.projects.slice(0, limit);
  return {
    ...report,
    projects,
    counts: {
      ...report.counts,
      projects: projects.length,
      evidence: projects.reduce((total, project) => total + project.evidence.length, 0),
      gitProjects: projects.filter((project) => project.git).length,
    },
  };
}

function parseAttentionSince(value: string, now = Date.now()): number {
  const trimmed = value.trim();
  const duration = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (duration) {
    const amount = Number.parseFloat(duration[1] ?? "");
    const unit = (duration[2] ?? "").toLowerCase();
    const unitMs = unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
    return now - amount * unitMs;
  }

  const parsedEpoch = epochMs(trimmed);
  if (parsedEpoch !== null) {
    return parsedEpoch;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return parsedDate;
  }

  throw new ScoutCliError(`invalid since value: ${value}`);
}

function parseAttentionLimit(value: string): number {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    throw new ScoutCliError("--limit must be between 1 and 100");
  }
  return count;
}

function resolveProjectPath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? `${process.env.HOME ?? ""}${value.slice(1)}`
    : value;
  return resolve(cwd, expanded);
}

function renderGitLine(project: ScoutAttentionProject): string {
  const git = project.git;
  if (!git) return "";
  const parts = [
    git.branch ? `branch ${git.branch}` : "branch unknown",
    git.changedFiles > 0 ? `${git.changedFiles} changed` : null,
    git.stagedFiles > 0 ? `${git.stagedFiles} staged` : null,
    git.unstagedFiles > 0 ? `${git.unstagedFiles} unstaged` : null,
    git.untrackedFiles > 0 ? `${git.untrackedFiles} untracked` : null,
    git.ahead > 0 ? `ahead ${git.ahead}` : null,
    git.behind > 0 ? `behind ${git.behind}` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

function renderEvidenceLine(evidence: ScoutAttentionEvidence, now: number): string {
  const pieces = [
    evidence.kind,
    evidence.id ? evidence.id : null,
    evidence.state ? `(${evidence.state})` : null,
  ].filter(Boolean);
  const age = evidence.at !== null ? ` - ${formatAge(evidence.at, now)}` : "";
  return `${pieces.join(" ")}: ${evidence.summary}${age}`;
}

function formatAge(timestamp: number | null, now: number): string {
  if (timestamp === null) return "unknown";
  return `${formatDuration(Math.max(0, now - timestamp))} ago`;
}

function formatDuration(ms: number): string {
  const abs = Math.max(0, Math.floor(ms));
  if (abs < 1_000) return "now";
  const seconds = Math.floor(abs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
