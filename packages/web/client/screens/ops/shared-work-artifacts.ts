import type { ObserveFile } from "../../lib/types.ts";
import { buildLaneSessionStats, buildLaneTouchedFiles } from "./agent-lane-detail.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

export type SharedWorkArtifact = {
  id: string;
  workspace: string | null;
  path: string;
  resolvedPath: string | null;
  owners: AgentLane[];
  /** Observed change classification, not delivery status or a conflict signal. */
  state: Exclude<ObserveFile["state"], "read">;
};

/** Lexical POSIX normalization only: does not claim symlink or host equivalence. */
function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/** Group changed files within their observed checkout; unknown checkouts remain lane-scoped. */
export function buildSharedWorkArtifacts(lanes: readonly AgentLane[]): SharedWorkArtifact[] {
  const artifacts = new Map<string, SharedWorkArtifact>();
  for (const lane of lanes) {
    const cwd = (lane.facts?.cwd || buildLaneSessionStats(lane).cwd || "").trim();
    const workspace = cwd.startsWith("/") ? normalizePath(cwd) : null;
    const files = buildLaneTouchedFiles({ events: [], files: lane.facts?.touchedFiles ?? lane.observe?.files ?? [] }, Infinity);
    for (const file of files) {
      if (file.state === "read") continue;
      const resolvedPath = file.path.startsWith("/") ? normalizePath(file.path)
        : workspace ? normalizePath(`${workspace}/${file.path}`) : null;
      const normalized = resolvedPath ?? normalizePath(file.path);
      if (!normalized || normalized === "/" || normalized === "..") continue;
      const prefix = workspace === "/" ? "/" : `${workspace}/`;
      const path = workspace && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
      const id = JSON.stringify([workspace ? "workspace" : "lane", workspace ?? lane.id, normalized]);
      const existing = artifacts.get(id);
      if (existing) {
        if (!existing.owners.some((owner) => owner.id === lane.id)) existing.owners.push(lane);
        // Match touched-file aggregation: any observed creation preserves that classification.
        // Relative session timestamps cannot establish ordering between different actors.
        if (file.state === "created") existing.state = "created";
      } else artifacts.set(id, { id, workspace, path, resolvedPath, owners: [lane], state: file.state });
    }
  }
  return [...artifacts.values()].sort((a, b) => a.id.localeCompare(b.id));
}
