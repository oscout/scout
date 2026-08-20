import {
  isStrReplaceTool,
  laneDisplayPath,
  strReplaceEditFromObserveEvent,
} from "./lane-edit-display.ts";
import type { ObserveEvent } from "./types.ts";

export type LaneToolDetailField = {
  label: string;
  value: string;
};

export type LaneToolDetailSection = {
  title: string;
  content: string;
};

export type LaneToolDetailModel = {
  command: string;
  hoverFields: LaneToolDetailField[];
  sections: LaneToolDetailSection[];
  copyText: string;
};

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim();
}

const SHELL_TOOL_NAMES = new Set([
  "bash", "shell", "terminal", "exec", "run", "command",
  "exec_command", "shell_command", "local_shell", "container_exec", "container.exec",
]);

/** Best-effort full command line for a lane tool row. */
export function laneToolCommandLine(event: Pick<ObserveEvent, "tool" | "arg" | "text">): string {
  const tool = normalized(event.tool);
  const arg = normalized(event.arg);
  const text = normalized(event.text);

  if (tool && SHELL_TOOL_NAMES.has(tool.toLowerCase()) && arg && arg !== "started" && arg !== "completed") {
    return arg;
  }
  if (tool && isStrReplaceTool(tool) && arg && arg !== "started" && arg !== "completed" && arg !== "patch") {
    const slash = arg.lastIndexOf("/");
    return slash >= 0 ? arg.slice(slash + 1) : arg;
  }
  if (tool && arg && arg !== "started" && arg !== "completed" && arg !== tool) {
    return `${tool} · ${arg}`;
  }
  if (arg && (!tool || arg === tool)) return arg;
  if (tool) return tool;
  return text || "command";
}

function laneToolCopyText(event: ObserveEvent): string {
  const lines: string[] = [];
  const head = laneToolCommandLine(event);
  if (head) lines.push(head);
  if (event.detail?.trim()) lines.push(event.detail.trim());
  if (event.text?.trim() && event.text.trim() !== head) lines.push(event.text.trim());
  if (event.result) {
    lines.push(
      Object.entries(event.result)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
    );
  }
  if (event.diff) {
    lines.push(`+${event.diff.add}${event.diff.del > 0 ? ` -${event.diff.del}` : ""}`);
    if (event.diff.preview) lines.push(event.diff.preview);
  }
  if (event.stream?.length) {
    lines.push(event.stream.join("\n"));
  }
  return lines.join("\n\n");
}

export function buildLaneToolDetailModel(
  event: ObserveEvent,
  options?: {
    wallLabel?: string;
    wallTitle?: string;
    sessionOffset?: string;
  },
): LaneToolDetailModel | null {
  if (event.kind !== "tool") return null;

  const command = laneToolCommandLine(event);
  const hoverFields: LaneToolDetailField[] = [];

  if (options?.wallLabel) {
    hoverFields.push({
      label: "when",
      value: options.wallTitle ? `${options.wallLabel} · ${options.wallTitle}` : options.wallLabel,
    });
  }
  if (options?.sessionOffset) {
    hoverFields.push({ label: "offset", value: options.sessionOffset });
  }

  const tool = normalized(event.tool);
  const arg = normalized(event.arg);
  const strReplace = isStrReplaceTool(event.tool);
  const strReplaceEdit = strReplace ? strReplaceEditFromObserveEvent(event) : null;

  if (strReplace && strReplaceEdit?.path) {
    hoverFields.push({ label: "file", value: laneDisplayPath(strReplaceEdit.path) });
  } else {
    if (tool && tool !== command) hoverFields.push({ label: "tool", value: tool });
    if (arg && arg !== tool && arg !== command) hoverFields.push({ label: "arg", value: arg });
  }

  const outcome = event.result?.outcome;
  if (outcome != null && String(outcome).length > 0) {
    hoverFields.push({ label: "outcome", value: String(outcome) });
  }

  const sections: LaneToolDetailSection[] = [];
  const detail = normalized(event.detail);
  const text = normalized(event.text);

  if (detail) sections.push({ title: "detail", content: detail });
  if (text && text !== command && text !== detail) {
    sections.push({ title: "trace", content: text });
  }
  if (event.result && Object.keys(event.result).length > 0) {
    sections.push({
      title: "result",
      content: Object.entries(event.result)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
    });
  }
  if (event.diff?.preview) {
    sections.push({
      title: isStrReplaceTool(event.tool) ? "change" : "diff",
      content: event.diff.preview,
    });
  }
  if (event.stream?.length) {
    sections.push({ title: "output", content: event.stream.join("\n") });
  }

  return {
    command,
    hoverFields,
    sections,
    copyText: laneToolCopyText(event),
  };
}

export function fmtLaneSessionOffset(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "at start";
  if (seconds < 60) return `+${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `+${minutes}m ${remainder}s` : `+${minutes}m`;
}

/** Compact preview for hover cards — first useful lines only. */
export function laneToolHoverPreview(model: LaneToolDetailModel, maxLines = 4): string[] {
  const lines: string[] = [model.command];
  for (const field of model.hoverFields) {
    if (field.label === "when" || field.label === "offset") continue;
    lines.push(`${field.label}: ${field.value}`);
  }
  for (const section of model.sections) {
    const chunk = section.content.split("\n").filter(Boolean).slice(0, 2).join("\n");
    if (chunk) lines.push(chunk);
  }
  return lines.slice(0, maxLines);
}