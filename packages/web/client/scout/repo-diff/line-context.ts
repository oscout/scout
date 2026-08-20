import { fileDisplayPath } from "./model.ts";
import type {
  RepoDiffFile,
  RepoDiffLayer,
  RepoDiffLayerKind,
  ScoutRepoDiffSnapshot,
} from "./types.ts";

export type RepoDiffLineSide = "add" | "del" | "context";

export type RepoDiffLineContext = {
  layer: RepoDiffLayerKind;
  filePath: string;
  side: RepoDiffLineSide;
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type RepoDiffSelectionContext = {
  layer: RepoDiffLayerKind | null;
  filePath: string | null;
  text: string;
};

function stripPatchPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/dev/null") return null;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function matchesFilePath(linePath: string, file: RepoDiffFile): boolean {
  const candidates = [file.newPath, file.oldPath].filter((value): value is string => Boolean(value));
  return candidates.includes(linePath);
}

export function parseRepoDiffLineContexts(
  layer: RepoDiffLayer | null,
  file: RepoDiffFile | null,
): RepoDiffLineContext[] {
  if (!layer?.rawPatch) return [];
  const contexts: RepoDiffLineContext[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const rawLine of layer.rawPatch.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      oldPath = null;
      newPath = null;
      oldLine = null;
      newLine = null;
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      oldPath = stripPatchPath(rawLine.slice(4));
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      newPath = stripPatchPath(rawLine.slice(4));
      continue;
    }
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (oldLine == null || newLine == null) continue;
    const filePath = newPath ?? oldPath;
    if (!filePath) continue;
    if (file && !matchesFilePath(filePath, file)) continue;
    if (rawLine.startsWith("+")) {
      contexts.push({
        layer: layer.kind,
        filePath,
        side: "add",
        oldLine: null,
        newLine,
        text: rawLine.slice(1),
      });
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      contexts.push({
        layer: layer.kind,
        filePath,
        side: "del",
        oldLine,
        newLine: null,
        text: rawLine.slice(1),
      });
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      contexts.push({
        layer: layer.kind,
        filePath,
        side: "context",
        oldLine,
        newLine,
        text: rawLine.slice(1),
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return contexts;
}

function lineLabel(line: RepoDiffLineContext): string {
  if (line.newLine != null) return `L${line.newLine}`;
  if (line.oldLine != null) return `old L${line.oldLine}`;
  return "line";
}

function compactText(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function repoDiffLineContextSnippet(input: {
  snapshot: ScoutRepoDiffSnapshot;
  line: RepoDiffLineContext;
}): string {
  const { line } = input;
  const sign = line.side === "add" ? "+" : line.side === "del" ? "-" : " ";
  return `[Diff line: ${line.layer} · ${line.filePath}:${lineLabel(line)} · ${sign} ${compactText(line.text)}]`;
}

export function repoDiffSelectionContextSnippet(input: {
  snapshot: ScoutRepoDiffSnapshot;
  selection: RepoDiffSelectionContext;
}): string {
  const { selection } = input;
  const where = [
    selection.layer ?? "diff",
    selection.filePath,
  ].filter(Boolean).join(" · ");
  return [
    `[Diff selection: ${where || "diff"}]`,
    selection.text.trim(),
    "[/Diff selection]",
  ].join("\n");
}

export function selectionContextFromWindow(input: {
  activeLayer: RepoDiffLayerKind | null;
  selectedFile: RepoDiffFile | null;
  root: HTMLElement | null;
}): RepoDiffSelectionContext | null {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (!selection || !text || !input.root) return null;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (
    (anchor && !input.root.contains(anchor)) ||
    (focus && !input.root.contains(focus))
  ) {
    return null;
  }
  return {
    layer: input.activeLayer,
    filePath: input.selectedFile ? fileDisplayPath(input.selectedFile) : null,
    text,
  };
}
