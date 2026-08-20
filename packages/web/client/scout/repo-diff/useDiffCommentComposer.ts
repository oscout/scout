import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api } from "../../lib/api.ts";
import {
  buildRepoDiffCommentBody,
  defaultRepoDiffCommentTarget,
  repoDiffContextSnippet,
  repoDiffCommentTargets,
  type RepoDiffCommentTarget,
} from "./comment-context.ts";
import {
  repoDiffLineContextSnippet,
  repoDiffSelectionContextSnippet,
  type RepoDiffLineContext,
  type RepoDiffSelectionContext,
} from "./line-context.ts";
import { fileDisplayPath } from "./model.ts";
import type {
  RepoDiffFile,
  RepoDiffLayerKind,
  ScoutRepoDiffSnapshot,
} from "./types.ts";

export type DiffCommentComposerState = {
  targets: RepoDiffCommentTarget[];
  targetId: string;
  setTargetId: (targetId: string) => void;
  draft: string;
  setDraft: (value: string) => void;
  contextItems: DiffCommentContextItem[];
  removeContextItem: (id: string) => void;
  pending: boolean;
  status: string | null;
  error: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  submit: () => Promise<void>;
  includeFileInComment: (file: RepoDiffFile, key: string) => void;
  includeLineInComment: (line: RepoDiffLineContext) => void;
  includeSelectionInComment: (selection: RepoDiffSelectionContext) => void;
};

export type DiffCommentContextKind = "file" | "line" | "selection";

export type DiffCommentContextItem = {
  id: string;
  kind: DiffCommentContextKind;
  label: string;
  detail: string;
  preview: string | null;
  snippet: string;
};

function compactText(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function codePreview(text: string, maxLines = 7): string {
  const lines = text.trimEnd().split("\n");
  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;
  return hidden > 0 ? `${visible.join("\n")}\n... ${hidden} more line${hidden === 1 ? "" : "s"}` : visible.join("\n");
}

function lineLabel(line: RepoDiffLineContext): string {
  if (line.newLine != null) return `L${line.newLine}`;
  if (line.oldLine != null) return `old L${line.oldLine}`;
  return "line";
}

function lineSign(line: RepoDiffLineContext): string {
  if (line.side === "add") return "+";
  if (line.side === "del") return "-";
  return " ";
}

function fileContextItem(input: {
  snapshot: ScoutRepoDiffSnapshot;
  activeLayer: RepoDiffLayerKind | null;
  file: RepoDiffFile;
}): DiffCommentContextItem {
  const { snapshot, activeLayer, file } = input;
  const path = fileDisplayPath(file);
  const churn = file.binary
    ? "binary"
    : `+${file.additions ?? 0} -${file.deletions ?? 0}`;
  return {
    id: `file:${activeLayer ?? "diff"}:${path}`,
    kind: "file",
    label: path,
    detail: `${activeLayer ?? "diff"} · ${file.status} · ${churn}`,
    preview: null,
    snippet: repoDiffContextSnippet({ snapshot, activeLayer, file }),
  };
}

function lineContextItem(input: {
  snapshot: ScoutRepoDiffSnapshot;
  line: RepoDiffLineContext;
}): DiffCommentContextItem {
  const { snapshot, line } = input;
  const sign = lineSign(line);
  return {
    id: `line:${line.layer}:${line.filePath}:${line.side}:${line.oldLine ?? ""}:${line.newLine ?? ""}`,
    kind: "line",
    label: `${line.filePath}:${lineLabel(line)}`,
    detail: `${line.layer} · ${sign}`,
    preview: `${sign} ${compactText(line.text, 180)}`,
    snippet: repoDiffLineContextSnippet({ snapshot, line }),
  };
}

function selectionContextItem(input: {
  snapshot: ScoutRepoDiffSnapshot;
  selection: RepoDiffSelectionContext;
}): DiffCommentContextItem {
  const { snapshot, selection } = input;
  const filePath = selection.filePath ?? "diff selection";
  const lineCount = selection.text.trim().split("\n").filter(Boolean).length;
  return {
    id: `selection:${selection.layer ?? "diff"}:${filePath}:${selection.text}`,
    kind: "selection",
    label: filePath,
    detail: `${selection.layer ?? "diff"} · ${lineCount} line${lineCount === 1 ? "" : "s"}`,
    preview: codePreview(selection.text),
    snippet: repoDiffSelectionContextSnippet({ snapshot, selection }),
  };
}

export function useDiffCommentComposer({
  snapshot,
  activeLayer,
  selectedFile,
  setSelectedFileKey,
  resetKey,
}: {
  snapshot: ScoutRepoDiffSnapshot | null;
  activeLayer: RepoDiffLayerKind | null;
  selectedFile: RepoDiffFile | null;
  setSelectedFileKey: (key: string | null) => void;
  resetKey: string;
}): DiffCommentComposerState {
  const [draft, setDraftState] = useState("");
  const [contextItems, setContextItems] = useState<DiffCommentContextItem[]>([]);
  const [targetId, setTargetIdState] = useState("scout");
  const [targetManual, setTargetManual] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const targets = useMemo(
    () => snapshot ? repoDiffCommentTargets(snapshot) : [],
    [snapshot],
  );
  const defaultTarget = useMemo(
    () => snapshot ? defaultRepoDiffCommentTarget(snapshot) : null,
    [snapshot],
  );

  useEffect(() => {
    setDraftState("");
    setContextItems([]);
    setTargetManual(false);
    setStatus(null);
    setError(null);
  }, [resetKey]);

  useEffect(() => {
    setTargetIdState((current) => {
      if (targetManual && current === "scout") return current;
      if (targets.some((target) => target.id === current)) return current;
      return defaultTarget?.id ?? "scout";
    });
  }, [targetManual, targets, defaultTarget?.id]);

  const setDraft = useCallback((value: string) => {
    setDraftState(value);
    setStatus(null);
    setError(null);
  }, []);

  const setTargetId = useCallback((value: string) => {
    setTargetManual(true);
    setTargetIdState(value);
  }, []);

  const addContextItem = useCallback((item: DiffCommentContextItem) => {
    setContextItems((current) => {
      if (current.some((candidate) => candidate.id === item.id)) return current;
      return [...current, item];
    });
    setStatus(null);
    setError(null);
    queueMicrotask(() => textareaRef.current?.focus());
  }, []);

  const removeContextItem = useCallback((id: string) => {
    setContextItems((current) => current.filter((item) => item.id !== id));
    setStatus(null);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    const trimmed = draft.trim();
    if ((!trimmed && contextItems.length === 0) || pending || !snapshot) return;

    const target = targets.find((candidate) => candidate.id === targetId) ?? null;
    const body = buildRepoDiffCommentBody({
      comment: trimmed || "Please review the included diff context.",
      includedContext: contextItems.map((item) => item.snippet),
      snapshot,
      activeLayer,
      selectedFile,
    });

    setPending(true);
    setStatus(null);
    setError(null);
    try {
      if (target) {
        await api("/api/ask", {
          method: "POST",
          body: JSON.stringify({
            body,
            targetAgentId: target.id,
            targetLabel: target.label,
            metadata: {
              source: "repo-diff",
              originSurface: "repo-diff",
              handoffKind: "repo-diff-comment",
              targetAgentId: target.id,
              worktreePath: snapshot.worktreePath,
              activeLayer,
              selectedFile: selectedFile ? fileDisplayPath(selectedFile) : null,
              scopeKind: snapshot.scope?.kind ?? "worktree",
            },
          }),
        });
        setStatus(`Sent to ${target.label}`);
      } else {
        await api("/api/send", {
          method: "POST",
          body: JSON.stringify({ body }),
        });
        setStatus("Sent to Scout");
      }
      setDraftState("");
      setContextItems([]);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setPending(false);
    }
  }, [
    activeLayer,
    contextItems,
    draft,
    pending,
    targetId,
    targets,
    selectedFile,
    snapshot,
  ]);

  const includeFileInComment = useCallback((file: RepoDiffFile, key: string) => {
    if (!snapshot) return;
    setSelectedFileKey(key);
    addContextItem(fileContextItem({
      snapshot,
      activeLayer,
      file,
    }));
  }, [activeLayer, addContextItem, setSelectedFileKey, snapshot]);

  const includeLineInComment = useCallback((line: RepoDiffLineContext) => {
    if (!snapshot) return;
    addContextItem(lineContextItem({ snapshot, line }));
  }, [addContextItem, snapshot]);

  const includeSelectionInComment = useCallback((selection: RepoDiffSelectionContext) => {
    if (!snapshot) return;
    addContextItem(selectionContextItem({ snapshot, selection }));
  }, [addContextItem, snapshot]);

  return {
    targets,
    targetId,
    setTargetId,
    draft,
    setDraft,
    contextItems,
    removeContextItem,
    pending,
    status,
    error,
    textareaRef,
    submit,
    includeFileInComment,
    includeLineInComment,
    includeSelectionInComment,
  };
}
