import type { ObserveEvent } from "./types.ts";

const STR_REPLACE_TOOLS = new Set([
  "strreplace",
  "str_replace",
  "str_replace_editor",
  "multiedit",
]);

export type StrReplaceEdit = {
  path: string;
  oldText: string;
  newText: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function isStrReplaceTool(tool: string | undefined): boolean {
  const key = (tool ?? "").trim().toLowerCase();
  return STR_REPLACE_TOOLS.has(key);
}

/** Parse a structured replace payload (Grok rawInput, codex JSON args, etc.). */
/** Collapse absolute home paths for lane display. */
export function laneDisplayPath(path: string): string {
  const trimmed = path.trim();
  return trimmed
    .replace(/^\/Users\/[^/]+\//u, "~/")
    .replace(/^\/home\/[^/]+\//u, "~/");
}

const GROK_STR_REPLACE_EDIT_SUMMARY =
  /^StrReplace · (.+?) · edit: (.*?)(?: · (success|error|failed))?$/i;

function parseGrokEditClause(clause: string): Pick<StrReplaceEdit, "oldText" | "newText"> {
  const trimmed = clause.trim();
  const oldMatch = trimmed.match(/^-(.+?)(?: · \+(.+))?$/u);
  if (!oldMatch) return { oldText: "", newText: "" };
  return {
    oldText: oldMatch[1]?.trim() ?? "",
    newText: oldMatch[2]?.trim() ?? "",
  };
}

/** Parse Grok tail summaries that embed a compact replace preview. */
export function strReplaceFromGrokSummary(summary: string): (StrReplaceEdit & { outcome?: string }) | null {
  const match = summary.trim().match(GROK_STR_REPLACE_EDIT_SUMMARY);
  if (!match?.[1] || !match[2]) return null;
  const { oldText, newText } = parseGrokEditClause(match[2]);
  if (!oldText && !newText) return null;
  return {
    path: match[1].trim(),
    oldText,
    newText,
    outcome: match[3]?.trim().toLowerCase(),
  };
}

export function strReplaceFromObject(input: unknown): StrReplaceEdit | null {
  const obj = asRecord(input);
  if (!obj) return null;

  const path = firstString(obj, ["path", "file_path", "filePath", "filename", "file"]);
  const oldText = firstString(obj, ["old_string", "oldString", "old_str", "replace_old", "search"]);
  const newText = firstString(obj, ["new_string", "newString", "new_str", "replace_new", "replace"]);
  if (!path || (!oldText && !newText)) return null;

  return {
    path,
    oldText: oldText ?? "",
    newText: newText ?? "",
  };
}

export function strReplaceSnippet(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function strReplaceDiffFromEdit(edit: StrReplaceEdit): ObserveEvent["diff"] {
  const oldLines = edit.oldText.split(/\r?\n/).filter((line) => line.length > 0);
  const newLines = edit.newText.split(/\r?\n/).filter((line) => line.length > 0);
  const previewLines: string[] = [];

  for (const line of oldLines.slice(0, 6)) {
    previewLines.push(`-${line}`);
  }
  for (const line of newLines.slice(0, 6)) {
    previewLines.push(`+${line}`);
  }

  if (previewLines.length === 0) return undefined;

  return {
    add: Math.max(newLines.length, edit.newText ? 1 : 0),
    del: Math.max(oldLines.length, edit.oldText ? 1 : 0),
    preview: previewLines.join("\n"),
  };
}

export function strReplaceDetailText(edit: StrReplaceEdit): string {
  const parts: string[] = [`file: ${edit.path}`];
  if (edit.oldText) parts.push(`old:\n${edit.oldText}`);
  if (edit.newText) parts.push(`new:\n${edit.newText}`);
  return parts.join("\n\n");
}

/** Read old/new strings previously folded into observe detail text. */
export function strReplaceFromDetail(detail: string | undefined): Pick<StrReplaceEdit, "oldText" | "newText"> | null {
  const text = detail?.trim();
  if (!text) return null;

  const oldMatch = text.match(/\bold:\s*\n([\s\S]*?)(?:\n\nnew:|\s*$)/i);
  const newMatch = text.match(/\bnew:\s*\n([\s\S]*)$/i);
  const oldText = oldMatch?.[1]?.trim() ?? "";
  const newText = newMatch?.[1]?.trim() ?? "";
  if (!oldText && !newText) return null;
  return { oldText, newText };
}

export function strReplaceEditFromObserveEvent(
  event: Pick<ObserveEvent, "tool" | "arg" | "detail" | "diff">,
): StrReplaceEdit | null {
  if (!isStrReplaceTool(event.tool)) return null;

  const path = event.arg?.trim();
  if (!path || path === "started" || path === "completed" || path === "patch") return null;

  const fromDetail = strReplaceFromDetail(event.detail);
  if (fromDetail) {
    return { path, oldText: fromDetail.oldText, newText: fromDetail.newText };
  }

  if (event.diff?.preview) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of event.diff.preview.split("\n")) {
      if (line.startsWith("-")) oldLines.push(line.slice(1));
      if (line.startsWith("+")) newLines.push(line.slice(1));
    }
    if (oldLines.length > 0 || newLines.length > 0) {
      return {
        path,
        oldText: oldLines.join("\n"),
        newText: newLines.join("\n"),
      };
    }
  }

  const arg = event.arg?.trim();
  if (arg?.startsWith("{")) {
    try {
      const fromArg = strReplaceFromObject(JSON.parse(arg));
      if (fromArg) return fromArg;
    } catch {
      // truncated JSON in tail summaries — fall through to path-only row
    }
  }

  return null;
}