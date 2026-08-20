import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";
import {
  readScoutLabelFeed,
  readScoutLabelBrief,
  type ScoutLabelBrief,
  type ScoutLabelBriefFlight,
  type ScoutLabelBriefWorkItem,
  type ScoutLabelFeed,
  type ScoutLabelFeedEvent,
} from "../../core/broker/service.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);
const DEFAULT_LABEL_WATCH_INTERVAL_SECONDS = 5;
const MIN_LABEL_WATCH_INTERVAL_SECONDS = 1;
const DEFAULT_LABEL_FEED_LIMIT = 80;

type LabelSubcommand = "brief" | "feed" | "watch";

type ScoutLabelCommandOptions =
  | { command: "help" }
  | {
      command: LabelSubcommand;
      label: string;
      intervalSeconds?: number;
      limit?: number;
      since?: number;
      once?: boolean;
    };

export function renderLabelCommandHelp(): string {
  return [
    "Usage: scout label <command> <label> [options]",
    "",
    "Aggregate related Scout work by a lightweight label.",
    "",
    "Commands:",
    "  brief <label>                       Show matching flights and work items",
    "  feed <label> [--since <time>]       Show a normalized event backlog",
    `  watch <label> [--interval <sec>]    Stream new normalized events (default ${DEFAULT_LABEL_WATCH_INTERVAL_SECONDS}s)`,
    "",
    "Options:",
    "  --since <time>                      Unix ms or duration like 10m, 2h, 1d",
    `  --limit <n>                         Feed backlog limit (default ${DEFAULT_LABEL_FEED_LIMIT})`,
    "  --once                             With watch, print backlog once and exit",
    "",
    "Examples:",
    "  scout label brief release:0.2.66",
    "  scout label feed release:0.2.66 --since 10m",
    "  scout label watch goal:ios-shell --interval 2",
    '  scout ask --to hudson --label release:0.2.66 "review the bump"',
  ].join("\n");
}

export function parseLabelCommandOptions(args: string[]): ScoutLabelCommandOptions {
  if (args.length === 0 || args.some((arg) => HELP_FLAGS.has(arg))) {
    return { command: "help" };
  }

  let command: LabelSubcommand = "brief";
  let rest = args;
  if (args[0] === "brief" || args[0] === "feed" || args[0] === "watch") {
    command = args[0];
    rest = args.slice(1);
  }

  let label: string | undefined;
  let intervalSeconds: number | undefined;
  let limit: number | undefined;
  let since: number | undefined;
  let once = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--interval") {
      const rawValue = rest[index + 1];
      if (!rawValue) {
        throw new ScoutCliError("--interval requires a number of seconds");
      }
      intervalSeconds = parseLabelWatchInterval(rawValue);
      index += 1;
      continue;
    }
    if (arg.startsWith("--interval=")) {
      intervalSeconds = parseLabelWatchInterval(arg.slice("--interval=".length));
      continue;
    }
    if (arg === "--limit") {
      const rawValue = rest[index + 1];
      if (!rawValue) {
        throw new ScoutCliError("--limit requires a number");
      }
      limit = parseLabelFeedLimit(rawValue);
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseLabelFeedLimit(arg.slice("--limit=".length));
      continue;
    }
    if (arg === "--since") {
      const rawValue = rest[index + 1];
      if (!rawValue) {
        throw new ScoutCliError("--since requires a timestamp or duration");
      }
      since = parseLabelFeedSince(rawValue);
      index += 1;
      continue;
    }
    if (arg.startsWith("--since=")) {
      since = parseLabelFeedSince(arg.slice("--since=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ScoutCliError(`unknown label ${command} option: ${arg}`);
    }
    if (label) {
      throw new ScoutCliError(`unexpected extra argument: ${arg}`);
    }
    label = arg;
  }

  if (!label?.trim()) {
    throw new ScoutCliError(`label ${command} requires <label>`);
  }
  if (command === "brief" && intervalSeconds !== undefined) {
    throw new ScoutCliError("label brief does not accept --interval");
  }
  if (command === "brief" && since !== undefined) {
    throw new ScoutCliError("label brief does not accept --since");
  }
  if (command === "brief" && limit !== undefined) {
    throw new ScoutCliError("label brief does not accept --limit");
  }

  return {
    command,
    label: label.trim(),
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(once ? { once } : {}),
  };
}

export async function runLabelCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  const options = parseLabelCommandOptions(args);
  if (options.command === "help") {
    context.output.writeText(renderLabelCommandHelp());
    return;
  }

  if (options.command === "brief") {
    const brief = await loadRequiredLabelBrief(options.label);
    context.output.writeValue(brief, renderLabelBrief);
    return;
  }

  if (options.command === "feed") {
    const feed = await loadRequiredLabelFeed(options.label, {
      since: options.since,
      limit: options.limit ?? DEFAULT_LABEL_FEED_LIMIT,
    });
    context.output.writeValue(feed, renderLabelFeed);
    return;
  }

  const seen = new Set<string>();
  let pollSince = options.since;
  const advancePollSince = (event: ScoutLabelFeedEvent): void => {
    pollSince = Math.max(pollSince ?? 0, Math.max(0, event.at - 1));
  };
  const initialFeed = await loadRequiredLabelFeed(options.label, {
    since: options.since,
    limit: options.limit ?? DEFAULT_LABEL_FEED_LIMIT,
  });
  for (const event of initialFeed.events) {
    seen.add(event.id);
    advancePollSince(event);
    context.output.writeValue(event, renderLabelFeedEvent);
  }
  if (options.once) {
    return;
  }

  const intervalSeconds = options.intervalSeconds ?? DEFAULT_LABEL_WATCH_INTERVAL_SECONDS;
  while (true) {
    const feed = await loadRequiredLabelFeed(options.label, {
      since: pollSince,
      limit: options.limit ?? DEFAULT_LABEL_FEED_LIMIT,
    });
    for (const event of feed.events) {
      advancePollSince(event);
      if (seen.has(event.id)) {
        continue;
      }
      seen.add(event.id);
      context.output.writeValue(event, renderLabelFeedEvent);
    }
    await delay(intervalSeconds * 1000);
  }
}

export function renderLabelBrief(brief: ScoutLabelBrief): string {
  const lines = [
    `Label: ${brief.label}`,
    `Last activity: ${brief.lastActivityAt ? timeAgo(brief.lastActivityAt, brief.generatedAt) : "none"}`,
    `Flights: ${brief.counts.activeFlights} active / ${brief.counts.flights} total`,
    `Work items: ${brief.counts.workItems}`,
  ];

  if (brief.participants.length > 0) {
    lines.push(`Participants: ${brief.participants.join(", ")}`);
  }

  const stateSummary = Object.entries(brief.flightsByState)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state} ${count}`)
    .join(", ");
  if (stateSummary) {
    lines.push(`States: ${stateSummary}`);
  }

  if (brief.activeFlights.length > 0) {
    lines.push("", "Active flights:");
    for (const flight of brief.activeFlights) {
      lines.push(`- ${renderBriefFlight(flight, brief.generatedAt)}`);
    }
  }

  const recentCompleted = brief.recentFlights.filter((flight) => !isActiveBriefFlight(flight));
  if (recentCompleted.length > 0) {
    lines.push("", "Recent flights:");
    for (const flight of recentCompleted.slice(0, 6)) {
      lines.push(`- ${renderBriefFlight(flight, brief.generatedAt)}`);
    }
  }

  if (brief.workItems.length > 0) {
    lines.push("", "Work items:");
    for (const workItem of brief.workItems.slice(0, 6)) {
      lines.push(`- ${renderBriefWorkItem(workItem, brief.generatedAt)}`);
    }
  }

  if (brief.counts.flights === 0 && brief.counts.workItems === 0) {
    lines.push("", "No Scout records found for this label yet.");
  }

  return lines.join("\n");
}

export function renderLabelFeed(feed: ScoutLabelFeed): string {
  const lines = [
    `Label: ${feed.label}`,
    `Events: ${feed.counts.events}`,
    `Cursor: ${feed.cursor ?? "none"}`,
  ];
  if (feed.events.length === 0) {
    lines.push("", "No Scout events found for this label yet.");
    return lines.join("\n");
  }
  lines.push("");
  for (const event of feed.events) {
    lines.push(renderLabelFeedEvent(event));
  }
  return lines.join("\n");
}

export function renderLabelFeedEvent(event: ScoutLabelFeedEvent): string {
  const pieces = [
    `[${formatEventTime(event.at)}]`,
    event.kind,
    event.actorId ? `actor ${event.actorId}` : null,
    event.targetAgentId ? `target ${event.targetAgentId}` : null,
    event.state ? `state ${event.state}` : null,
    event.workId ? `work ${event.workId}` : null,
    event.flightId ? `flight ${event.flightId}` : null,
    event.messageId ? `message ${event.messageId}` : null,
    `- ${event.summary}`,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.join(" ");
}

async function loadRequiredLabelBrief(label: string): Promise<ScoutLabelBrief> {
  const brief = await readScoutLabelBrief(label);
  if (!brief) {
    throw new ScoutCliError("broker is not reachable");
  }
  return brief;
}

async function loadRequiredLabelFeed(
  label: string,
  options: {
    since?: number;
    limit?: number;
  },
): Promise<ScoutLabelFeed> {
  const feed = await readScoutLabelFeed(label, options);
  if (!feed) {
    throw new ScoutCliError("broker is not reachable");
  }
  return feed;
}

function renderBriefFlight(flight: ScoutLabelBriefFlight, now: number): string {
  const pieces = [
    flight.id,
    flight.state,
    `target ${flight.targetAgentId}`,
    flight.lastActivityAt ? timeAgo(flight.lastActivityAt, now) : null,
    flight.summary,
    flight.workId ? `work ${flight.workId}` : null,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.join(" - ");
}

function renderBriefWorkItem(workItem: ScoutLabelBriefWorkItem, now: number): string {
  const pieces = [
    workItem.id,
    workItem.state,
    workItem.ownerId ? `owner ${workItem.ownerId}` : null,
    timeAgo(workItem.updatedAt, now),
    workItem.summary ?? workItem.title,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.join(" - ");
}

function isActiveBriefFlight(flight: ScoutLabelBriefFlight): boolean {
  return flight.state === "queued" || flight.state === "waking" || flight.state === "running" || flight.state === "waiting";
}

function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function parseLabelWatchInterval(value: string): number {
  const intervalSeconds = Number(value);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_LABEL_WATCH_INTERVAL_SECONDS) {
    throw new ScoutCliError(`--interval must be at least ${MIN_LABEL_WATCH_INTERVAL_SECONDS} seconds`);
  }
  return intervalSeconds;
}

function parseLabelFeedLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new ScoutCliError("--limit must be an integer between 1 and 1000");
  }
  return limit;
}

function parseLabelFeedSince(value: string): number {
  const trimmed = value.trim();
  const epochMs = Number(trimmed);
  if (Number.isFinite(epochMs) && epochMs >= 0) {
    return epochMs;
  }
  const match = /^(\d+)(s|m|h|d)$/i.exec(trimmed);
  if (!match) {
    throw new ScoutCliError("--since must be a Unix ms timestamp or duration like 10m, 2h, 1d");
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "s" ? 1000
    : unit === "m" ? 60_000
    : unit === "h" ? 3_600_000
    : 86_400_000;
  return Date.now() - amount * multiplier;
}

function formatEventTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
