/**
 * Mobile-shaped workspace summaries derived from the agents table.
 *
 * Lifted from db-queries.ts as part of SCO-031 Phase C. No filesystem
 * scan; relies on the project_root column on `agent_endpoints`.
 */

import { db } from "../internal/db.ts";
import { HOME } from "../internal/paths.ts";
import type { MobileWorkspaceSummary } from "../types/mobile.ts";

/** Derive workspaces from agents in the DB — no filesystem scan needed. */
export function queryMobileWorkspaces(limit = 50): MobileWorkspaceSummary[] {
  const rows = db().prepare(
    `SELECT DISTINCT
       ep.project_root,
       ac.display_name,
       a.metadata_json,
       ep.harness
     FROM agents a
     JOIN actors ac ON ac.id = a.id
     LEFT JOIN agent_endpoints ep ON ep.agent_id = a.id
     WHERE ep.project_root IS NOT NULL
     ORDER BY ep.updated_at DESC NULLS LAST
     LIMIT ?`,
  ).all(limit) as Array<{
    project_root: string;
    display_name: string;
    metadata_json: string | null;
    harness: string | null;
  }>;

  const seen = new Set<string>();
  const results: MobileWorkspaceSummary[] = [];

  for (const r of rows) {
    if (seen.has(r.project_root)) continue;
    seen.add(r.project_root);

    let meta: Record<string, unknown> = {};
    try { meta = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch {}

    const projectName = (meta.project as string) ?? r.project_root.split("/").pop() ?? "unknown";
    const relativePath = r.project_root.replace(HOME + "/", "");

    results.push({
      id: r.project_root,
      title: projectName,
      projectName,
      root: r.project_root,
      sourceRoot: r.project_root,
      relativePath,
      registrationKind: "agent",
      defaultHarness: r.harness ?? "claude",
      harnesses: r.harness
        ? [{
            harness: r.harness,
            source: "default",
            detail: "Current endpoint",
            readinessState: "ready",
            readinessDetail: null,
          }]
        : [],
    });
  }

  return results;
}
