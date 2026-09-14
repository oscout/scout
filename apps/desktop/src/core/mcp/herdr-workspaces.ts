import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  renderHerdrWorkspaceDigest,
  type HerdrWorkspaceDigest,
} from "@openscout/protocol";

import { readScoutWebJson } from "../../cli/web-api.ts";

/**
 * `herdr_workspaces` — the read side of Scout's herdr coordination layer.
 *
 * Herdr owns workspaces, tabs and panes; Scout coordinates over whatever host
 * is present and never becomes a second layout manager. So this tool reads a
 * ranked digest and stops there. It has no mutation verb, and it deliberately
 * does not shell `herdr` itself: the web server already owns that probe and its
 * cache, and a caller that cannot reach the server should learn that rather
 * than quietly open a second path to the same binary.
 *
 * The tool returns the rendered digest as its text content — attention first,
 * then motion, then directories, then arrangement — because that ordering is
 * the presentation, not a formatting detail. Structured content carries the
 * same digest for callers that want the fields.
 */

export type HerdrWorkspacesDependencies = {
  readDigests: (session?: string) => Promise<{
    digests: HerdrWorkspaceDigest[];
    truncated: boolean;
    available: boolean;
  }>;
};

export function herdrWorkspacesDependencies(
  webOrigin: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): HerdrWorkspacesDependencies {
  const fetchImpl = options.fetchImpl ?? fetch;
  const boundedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(8_000) })) as typeof fetch;
  const context = { env: { ...(options.env ?? process.env), OPENSCOUT_WEB_URL: webOrigin } };
  return {
    readDigests: async (session) => {
      const path = session
        ? `/api/terminal-hosts/herdr/workspaces?session=${encodeURIComponent(session)}`
        : "/api/terminal-hosts/herdr/workspaces";
      try {
        const result = await readScoutWebJson<{
          digests?: HerdrWorkspaceDigest[];
          truncated?: boolean;
        }>(context, path, { fetchImpl: boundedFetch });
        return { digests: result.digests ?? [], truncated: result.truncated === true, available: true };
      } catch {
        // Herdr not installed, or the web server unreachable. Both are "we
        // cannot answer", which is a different claim from "no workspaces".
        return { digests: [], truncated: false, available: false };
      }
    },
  };
}

export function registerHerdrWorkspaceTools(server: McpServer, deps: HerdrWorkspacesDependencies): void {
  server.registerTool("herdr_workspaces", {
    title: "Read Herdr Workspace Topology",
    description: [
      "Read the operator's herdr terminal workspaces: which panes are blocked and waiting on a person, which are working, what directory each sits in, and how each tab is arranged.",
      "Herdr reports agent state; Scout does not infer it. blocked means herdr recognized an approval or question UI. idle and done both mean ready for input. unknown means an agent is present that herdr could not classify — it is the absence of a signal, never completion.",
      "Read-only. This tool cannot split panes, start agents, focus, or close anything; herdr owns the layout. To act, hand the operator the herdr command or dispatch an agent with ask.",
      "A session reported not live is a persisted last-known layout, not running work. Never describe its panes as active.",
    ].join(" "),
    inputSchema: z.object({
      session: z.string().trim().min(1).max(120).optional()
        .describe("Herdr session name. Omit to read every session on this host."),
      limit: z.number().int().min(1).max(8).default(3)
        .describe("Maximum sessions to return, most workspaces first."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ session, limit }) => {
    const { digests, truncated, available } = await deps.readDigests(session);
    if (!available) {
      const structuredContent = {
        source: "herdr_topology_projection",
        available: false,
        reason: "herdr_unavailable",
        note: "Could not read herdr on this host: it may not be installed, or the Scout web server is unreachable. This is not evidence that there are no workspaces.",
        sessions: [] as HerdrWorkspaceDigest[],
      };
      return { content: [{ type: "text" as const, text: structuredContent.note }], structuredContent };
    }

    // Most workspaces first, so a bounded read spends its budget on the session
    // that actually has a topology to describe.
    const ordered = [...digests].sort((left, right) =>
      right.counts.blocked - left.counts.blocked
      || right.totals.panes - left.totals.panes
      || left.session.localeCompare(right.session, undefined, { numeric: true }));
    const sessions = ordered.slice(0, limit);
    const text = sessions.length
      ? sessions.map(renderHerdrWorkspaceDigest).join("\n\n")
      : "No herdr sessions on this host.";
    const structuredContent = {
      source: "herdr_topology_projection",
      available: true,
      coverage: "this_host_only",
      truncated: truncated || ordered.length > sessions.length,
      sessions,
    };
    return { content: [{ type: "text" as const, text }], structuredContent };
  });
}
