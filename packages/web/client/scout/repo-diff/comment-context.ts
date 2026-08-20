import { agentHandle } from "../repo-watch/ui.ts";
import type {
  RepoDiffFile,
  RepoDiffLayer,
  RepoDiffLayerKind,
  ScoutRepoDiffSnapshot,
} from "./types.ts";

export type RepoDiffCommentTarget = {
  id: string;
  label: string;
  score: number;
};

function agentStateScore(state: string | null): number {
  switch (state?.trim().toLowerCase()) {
    case "active":
    case "working":
    case "running":
    case "in_turn":
      return 80;
    case "queued":
    case "waiting":
    case "waking":
    case "in_flight":
      return 50;
    case "idle":
    case "available":
      return 25;
    case "offline":
    case "retired":
    case "stale":
      return -40;
    default:
      return 0;
  }
}

function filePath(file: RepoDiffFile): string {
  return file.newPath ?? file.oldPath ?? "(unknown)";
}

export function repoDiffCommentTargets(snapshot: ScoutRepoDiffSnapshot): RepoDiffCommentTarget[] {
  const scopedAgentId = snapshot.scope?.kind === "session" ? snapshot.scope.agentId : null;
  const hintCounts = new Map<string, number>();
  for (const hint of snapshot.scout.hints) {
    if (hint.agentId) {
      hintCounts.set(hint.agentId, (hintCounts.get(hint.agentId) ?? 0) + 1);
    }
  }

  return snapshot.scout.agents
    .map((agent) => ({
      id: agent.id,
      label: agentHandle(agent),
      score:
        agentStateScore(agent.state)
        + (agent.id === scopedAgentId ? 1_000 : 0)
        + (hintCounts.get(agent.id) ?? 0) * 10,
    }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      return left.label.localeCompare(right.label);
    });
}

export function defaultRepoDiffCommentTarget(snapshot: ScoutRepoDiffSnapshot): RepoDiffCommentTarget | null {
  return repoDiffCommentTargets(snapshot)[0] ?? null;
}

function layerSummary(layer: RepoDiffLayer): string {
  const churn = layer.files.reduce(
    (acc, file) => ({
      add: acc.add + (file.additions ?? 0),
      del: acc.del + (file.deletions ?? 0),
    }),
    { add: 0, del: 0 },
  );
  return `${layer.kind}: ${layer.files.length} file${layer.files.length === 1 ? "" : "s"}, +${churn.add} -${churn.del}${layer.truncated ? ", truncated" : ""}`;
}

function selectedFileSummary(file: RepoDiffFile): string {
  const churn = file.binary
    ? "binary"
    : `+${file.additions ?? 0} -${file.deletions ?? 0}`;
  return `${file.status}: ${filePath(file)} (${churn}${file.truncated ? ", truncated" : ""})`;
}

function scopeSummary(snapshot: ScoutRepoDiffSnapshot): string {
  const scope = snapshot.scope;
  if (!scope) return "worktree";
  if (scope.kind === "session") {
    return `session ${scope.sessionId ?? scope.refId ?? "(unknown)"} (${scope.changedFiles} changed / ${scope.touchedFiles} touched files, ${scope.include})`;
  }
  if (scope.filteredPaths.length > 0) {
    return `filtered worktree (${scope.filteredPaths.length} paths)`;
  }
  return "worktree";
}

export function buildRepoDiffCommentBody(input: {
  comment: string;
  includedContext?: string[];
  snapshot: ScoutRepoDiffSnapshot;
  activeLayer: RepoDiffLayerKind | null;
  selectedFile: RepoDiffFile | null;
}): string {
  const { comment, includedContext = [], snapshot, activeLayer, selectedFile } = input;
  const active = activeLayer
    ? snapshot.layers.find((layer) => layer.kind === activeLayer) ?? null
    : null;
  const files = (active?.files ?? snapshot.layers.flatMap((layer) => layer.files))
    .slice(0, 12)
    .map(selectedFileSummary);
  const agents = snapshot.scout.agents.map((agent) => agentHandle(agent)).slice(0, 8);

  const lines = [
    "Operator comment on repo diff:",
    comment,
    "",
    "Repo Diff context:",
    `- Worktree: ${snapshot.worktreePath}`,
    `- Scope: ${scopeSummary(snapshot)}`,
    `- Active layer: ${activeLayer ?? "none"}`,
  ];

  if (includedContext.length > 0) {
    lines.splice(
      3,
      0,
      "Included diff context:",
      ...includedContext.map((context) => context.trim()).filter(Boolean),
      "",
    );
  }

  if (selectedFile) {
    lines.push(`- Selected file: ${selectedFileSummary(selectedFile)}`);
  }
  lines.push(`- Layers: ${snapshot.layers.map(layerSummary).join("; ")}`);
  if (agents.length > 0) {
    lines.push(`- Attached agents: ${agents.join(", ")}`);
  }
  if (snapshot.scout.sessions.length > 0) {
    lines.push(`- Sessions: ${snapshot.scout.sessions.map((session) => session.id).slice(0, 8).join(", ")}`);
  }
  if (files.length > 0) {
    lines.push(`- Changed files: ${files.join(", ")}`);
  }
  if (snapshot.diagnostics.length > 0) {
    lines.push(`- Diagnostics: ${snapshot.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`);
  }

  return lines.join("\n");
}

export function repoDiffContextSnippet(input: {
  snapshot: ScoutRepoDiffSnapshot;
  activeLayer: RepoDiffLayerKind | null;
  file: RepoDiffFile;
}): string {
  const { snapshot, activeLayer, file } = input;
  const parts = [
    activeLayer ?? "diff",
    selectedFileSummary(file),
  ];
  if (snapshot.scope?.kind === "session") {
    parts.push(`session ${snapshot.scope.sessionId ?? snapshot.scope.refId ?? "scope"}`);
  }
  return `[Diff context: ${parts.join(" · ")}]`;
}

export function repoDiffFileForKey(
  layer: RepoDiffLayer | null,
  key: string | null,
  keyFor: (file: RepoDiffFile, index: number) => string,
): RepoDiffFile | null {
  if (!layer || !key) return null;
  return layer.files.find((file, index) => keyFor(file, index) === key) ?? null;
}
