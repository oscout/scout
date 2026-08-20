import { laneToolArgSnippet } from "../../lib/lane-observe.ts";
import { laneAskHeadline, laneAskPreview } from "../../lib/lane-ask-display.ts";
import { splitCdPrefix, tildeShortenPath } from "../../lib/bash-format.ts";
import { observeToolIsEdit, observeToolIsRead } from "../../lib/tail-display.ts";
import type { Agent, ObserveData, ObserveEvent, ObserveFile } from "../../lib/types.ts";

export type AgentLanePreviewModel = {
  headline: string;
  /** The same headline without the display truncation — for a "show full" popover
   *  when the line is cut short. */
  headFull: string;
  /** Who the headline message is with: "user" = a prompt from the user (←),
   *  "agent" = a reply to the user (→), null = non-conversation fallback. */
  headlineFrom: "user" | "agent" | null;
  detail: string | null;
  model: string | null;
  branch: string | null;
  harness: string | null;
  stats: {
    tools: number;
    edits: number;
    reads: number;
    thinks: number;
    files: number;
  };
  files: ObserveFile[];
};

const PLACEHOLDER_MARKERS = [
  "transcript discovered",
  "waiting for events",
  "no session trace",
  "waiting for a live session",
];

function isSubstantiveEvent(event: ObserveEvent): boolean {
  if (event.kind === "tool" || event.kind === "think" || event.kind === "ask" || event.kind === "message") {
    return true;
  }
  if (event.kind === "note") return true;
  if (event.kind === "system" || event.kind === "boot") {
    const text = event.text.trim().toLowerCase();
    return !PLACEHOLDER_MARKERS.some((marker) => text.includes(marker));
  }
  return false;
}

function basename(path: string | null | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) return "file";
  // Split on both separators so Windows-style / escaped paths
  // (e.g. "openscout\\nbun") still resolve to the final segment.
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/** True when text carries an actual word — not just arrows/punctuation/blank.
 *  Guards the summary from headlines like a bare "→" and unnamed files. */
export function hasMeaningfulText(value: string | null | undefined): boolean {
  return !!value && /[\p{L}\p{N}]/u.test(value);
}

function isInActiveTurn(events: ObserveEvent[]): boolean {
  let lastStart = -1;
  let lastComplete = -1;
  for (const event of events) {
    if (event.kind !== "note") continue;
    const text = event.text.trim().toLowerCase();
    if (text === "turn started") lastStart = event.t;
    if (text === "turn complete") lastComplete = event.t;
  }
  return lastStart > lastComplete;
}

export function previewFocusEvent(
  events: ObserveEvent[],
  isLive: boolean,
): ObserveEvent | undefined {
  const substantive = events.filter(isSubstantiveEvent);
  if (substantive.length === 0) return undefined;

  const activeTurn = isLive && isInActiveTurn(events);

  // During an active turn, the lane should show the agent's current thinking
  // before falling back to older conversation text.
  if (activeTurn) {
    const latestThink = [...substantive]
      .reverse()
      .find((event) => event.kind === "think" && hasMeaningfulText(event.text));
    if (latestThink) return latestThink;
  }

  // The headline is usually the conversation, not the work. Prefer the last
  // user-level message — either a prompt from the user (kind "ask") or a reply
  // to the user (kind "message").
  const lastConversation = [...substantive]
    .reverse()
    .find(
      (event) =>
        (event.kind === "message" || event.kind === "ask") && hasMeaningfulText(event.text),
    );
  const latestTool = [...substantive].reverse().find((event) => event.kind === "tool");

  // If the session is still live, a newer tool after the last conversation is a
  // better signal than stale chat text from before the work began.
  if (isLive && latestTool && (!lastConversation || latestTool.t > lastConversation.t)) {
    return latestTool;
  }

  if (lastConversation) return lastConversation;

  // Nothing has been said yet → fall back to live activity so the card isn't blank.
  return latestTool ?? substantive[substantive.length - 1];
}

/** Build the current-state headline. With `full`, the text/arg is left
 *  untruncated (for the "show full" popover); otherwise it's clipped to a tidy
 *  single-glance length. The tidying (tilde paths, dropped boilerplate `cd …&&`)
 *  is applied either way so the popover reads as the same line, just complete. */
function buildHeadline(event: ObserveEvent, full = false): string {
  const text = hasMeaningfulText(event.text) ? event.text!.trim() : undefined;
  const clip = (value: string | undefined): string | undefined =>
    value == null ? undefined : full ? value : value.slice(0, 72);
  switch (event.kind) {
    case "tool": {
      // Tidy the command the same way the trace does: tilde-shorten paths and
      // drop a leading boilerplate `cd …&&` so the headline shows the real
      // action (`gh pr create …`), not codex's cd-to-root noise.
      let arg = event.arg ? tildeShortenPath(event.arg) : null;
      if (arg) arg = splitCdPrefix(arg).rest || arg;
      const argText = arg ? (full ? arg : laneToolArgSnippet(arg, 72)) : null;
      return [event.tool, argText].filter(Boolean).join(" · ").trim() || "Running tool";
    }
    case "think":
      return clip(text) || "Thinking";
    case "ask":
      return full ? laneAskHeadline(event, true) : laneAskHeadline(event);
    case "message":
      return clip(text) || `Message → ${event.to ?? "operator"}`;
    case "note":
      return clip(text) || "Turn update";
    default:
      return clip(text) || event.kind;
  }
}

function previewHeadline(event: ObserveEvent): string {
  return buildHeadline(event);
}

function previewDetail(event: ObserveEvent): string | null {
  if (event.kind === "ask") {
    return laneAskPreview(event);
  }

  const text = hasMeaningfulText(event.text) ? event.text!.trim() : null;
  if (text) return text.slice(0, 220);

  if (event.kind === "tool" && event.diff?.preview) {
    return event.diff.preview.split("\n").slice(0, 4).join("\n");
  }

  if (event.kind === "tool" && event.stream?.length) {
    return event.stream.join("\n").slice(0, 220);
  }

  if (event.kind === "tool" && event.result) {
    return Object.entries(event.result)
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${value}`)
      .join(" · ");
  }

  return hasMeaningfulText(event.detail) ? event.detail!.trim() : null;
}

export function buildAgentLanePreview(
  observe: ObserveData | null | undefined,
  agent: Agent,
  options?: { isLive?: boolean },
): AgentLanePreviewModel | null {
  if (!observe || observe.events.length === 0) return null;

  const latest = previewFocusEvent(observe.events, options?.isLive ?? observe.live === true)
    ?? observe.events[observe.events.length - 1];
  if (!latest) return null;

  const session = observe.metadata?.session;
  const tools = observe.events.filter((event) => event.kind === "tool").length;
  const edits = observe.events.filter(
    (event) => event.kind === "tool" && observeToolIsEdit(event.tool),
  ).length;
  const reads = observe.events.filter(
    (event) => event.kind === "tool" && observeToolIsRead(event.tool),
  ).length;
  const thinks = observe.events.filter((event) => event.kind === "think").length;

  const files = [...observe.files].sort((left, right) => {
    const leftChanged = left.state === "read" ? 0 : 1;
    const rightChanged = right.state === "read" ? 0 : 1;
    if (leftChanged !== rightChanged) return rightChanged - leftChanged;
    return right.lastT - left.lastT;
  }).slice(0, 5);

  return {
    headline: previewHeadline(latest),
    headFull: buildHeadline(latest, true),
    headlineFrom: latest.kind === "ask" ? "user" : latest.kind === "message" ? "agent" : null,
    detail: previewDetail(latest),
    model: session?.model ?? agent.model ?? null,
    branch: session?.gitBranch ?? agent.branch ?? null,
    harness: agent.harness ?? session?.adapterType ?? null,
    stats: {
      tools,
      edits,
      reads,
      thinks,
      files: observe.files.length,
    },
    files,
  };
}

export function filePreviewLabel(file: ObserveFile | string | null | undefined): string {
  if (!file) return "file";
  return basename(typeof file === "string" ? file : file.path);
}
