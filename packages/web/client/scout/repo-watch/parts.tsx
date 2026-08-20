/**
 * Repo Watch — small shared render bits.
 *
 * Pieces every view draws the same way. Pure presentation; the data shaping
 * lives in ./ui.ts. Kept here (not in ui.ts) so ui.ts stays React-free.
 */

import type { RepoWatchBranchSummary } from "./types.ts";
import { branchParts } from "./ui.ts";

/**
 * Branch identity — a dimmed `codex/` path prefix + the meaningful leaf, or a
 * short sha for a detached head. Returns a fragment; the caller supplies the
 * wrapper (`.br` / `.bd-br` / `.ctx-branch`) so each view keeps its own type
 * treatment while the split logic stays in one place.
 */
export function BranchLabel({
  branch,
  fallback,
}: {
  branch: RepoWatchBranchSummary;
  fallback: string;
}) {
  const p = branchParts(branch, fallback);
  if (p.detached) return <span className="pre">{p.sha ?? "detached"}</span>;
  if (p.prefix) {
    return (
      <>
        <span className="pre">{p.prefix}</span>
        {p.leaf}
      </>
    );
  }
  return <>{p.leaf}</>;
}
