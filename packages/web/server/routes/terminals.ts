import type { Hono } from "hono";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  digestHerdrTopology,
  legacyTerminalSurfaceKey,
  parseTerminalSurfaceId,
  reconcileTerminalWorkspace,
  resolveSessionTerminalSurface,
  terminalSurfaceIdForSurface,
  terminalSurfaceMatchesId,
  type TerminalWorkspaceRecord,
  type TerminalWorkspaceResolution,
} from "@openscout/protocol";
import { openLocalTerminalAttach } from "../local-terminal-open.ts";
import { queryDiscoveredTerminalSessions, reconcileTerminalSessionInventory } from "../terminal-session-discovery.ts";
import {
  deleteTerminalWorkspace,
  queryTerminalWorkspace,
  queryTerminalWorkspaces,
  upsertTerminalWorkspace,
} from "../db/terminal-workspaces.ts";
import {
  describeTerminalHosts,
  isKnownTerminalHost,
  preferredTerminalHost,
  relayCarriedTerminalBackend,
  resolveTerminalHostAdapter,
  terminalHostAdapter,
  terminalHostSupportsControl,
} from "../terminal-hosts/index.ts";
import { queryTerminalSessions } from "../db-queries.ts";
import { readScoutBrokerNodeId } from "../core/broker/service.ts";
import {
  execSystemFile,
  readAllProcessCommandRows,
  readAllProcessRows,
  readHerdrSessions,
  readHerdrTopology,
  readProcessCwd as readProcessCwdProbe,
  readProcessRowsForTty,
  readTmuxPaneDetail,
} from "@openscout/runtime/system-probes";
import { resolveOpenScoutSupportPaths } from "@openscout/runtime/support-paths";
import { firstMetadataString } from "../web-flights.ts";
import { defaultCaptureTmuxPane } from "../tmux-pane-capture.ts";
import { parseTmuxPeekLineCount, parseTmuxPeekColumnCount, normalizeTmuxPeekBody } from "../tmux-peek.ts";
import { mostRecentClaudeSessionForCwd } from "../claude-sessions.ts";
import type { CreateOpenScoutWebServerOptions } from "../web-server-options.ts";
import type { OpenScoutWebRoutes } from "../../shared/runtime-config.js";
import {
  herdrFocusBody,
  terminalHostSessionCreateBody,
  terminalRelayDestroyBody,
  terminalRunBody,
  terminalSurfaceControlBody,
  terminalWorkspaceBody,
} from "../../shared/api/terminals.ts";
import { readJsonBody } from "../request-body.ts";

/**
 * Reconcile saved workspaces against the live host inventory.
 *
 * Both inputs are gathered once and shared across every workspace: probing the
 * hosts per workspace would multiply shell-outs by the size of the library for
 * an answer that is identical each time.
 *
 * The node id goes in with them because the sessions are THIS machine's
 * observations: a session discovered here carries no node in its handle, and
 * only this node's cells may be proven live by it. Without the id a cell scoped
 * to any node at all would bind to a same-named local session — which is how
 * two machines' workspaces both reported one session Running. The id is a
 * node-only broker read — identity is all this needs, never the registry
 * snapshot — and a broker that is down means the id is unknown, which
 * reconciliation reads as "cannot prove it" rather than "matches anything".
 */
async function resolveTerminalWorkspaces(
  workspaces: readonly TerminalWorkspaceRecord[],
): Promise<TerminalWorkspaceResolution[]> {
  if (workspaces.length === 0) return [];
  const [sessions, hosts, localNodeId] = await Promise.all([
    queryDiscoveredTerminalSessions({ limit: 500 }),
    describeTerminalHosts(),
    readScoutBrokerNodeId(),
  ]);
  // Derived from the one probe above; a second resolve would probe every host
  // again for an answer this list already holds.
  const preferred = preferredTerminalHost(hosts);
  const registered = queryTerminalSessions({ limit: 500 });
  const hostStates = hosts.map((host) => ({
    id: host.id,
    installed: host.availability.installed,
    canCreate: host.capabilities.create,
  }));
  return workspaces.map((workspace) => reconcileTerminalWorkspace(workspace, {
    sessions: [...registered, ...sessions],
    hosts: hostStates,
    defaultHostId: preferred?.id ?? null,
    localNodeId,
  }));
}

/** Any host with a registered adapter, not a hardcoded pair. */
function parseTerminalSessionBackend(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && isKnownTerminalHost(normalized) ? normalized : undefined;
}

function parseTerminalSessionLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(1000, Math.floor(parsed)) : 100;
}

function parseTerminalSessionDiscoveryFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "backend";
}

function parseTerminalSurfaceControlAction(value: string | undefined): "interrupt" | "quit" | "stop-job" | "restart-resume" | "detach" | "release" | "force-quit" | "force-quit-bridge" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "interrupt"
    || normalized === "quit"
    || normalized === "stop-job"
    || normalized === "restart-resume"
    || normalized === "detach"
    || normalized === "release"
    || normalized === "force-quit"
    || normalized === "force-quit-bridge"
  ) {
    return normalized;
  }
  return undefined;
}

type TmuxPaneProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  comm: string;
};

type ProcessCommandRow = TmuxPaneProcess & {
  command: string;
};

type RelayRuntimeState = {
  agentId?: string;
  projectRoot?: string;
  sessionId?: string;
  promptFile?: string;
  launchScript?: string;
};

async function tmuxPaneDetail(sessionName: string): Promise<{ panePid: number; paneTty: string; paneCurrentPath: string | null } | null> {
  return await readTmuxPaneDetail(sessionName);
}

async function processRowsForTty(tty: string): Promise<TmuxPaneProcess[]> {
  return await readProcessRowsForTty(tty);
}

async function allProcessRows(): Promise<TmuxPaneProcess[]> {
  return await readAllProcessRows();
}

async function allProcessCommandRows(): Promise<ProcessCommandRow[]> {
  return await readAllProcessCommandRows();
}

async function processRowsForTmuxPane(detail: { panePid: number; paneTty: string }): Promise<TmuxPaneProcess[]> {
  const byPid = new Map<number, TmuxPaneProcess>();
  // Keep tty-derived parentage first: macOS can report long-running tmux pane
  // children as reparented elsewhere, while the tty scan still exposes the
  // pane-to-Claude relationship we need to find no-tty shell jobs.
  for (const row of await processRowsForTty(detail.paneTty)) {
    byPid.set(row.pid, row);
  }
  for (const row of await allProcessRows()) {
    if (!byPid.has(row.pid)) byPid.set(row.pid, row);
  }
  return [...byPid.values()];
}

function descendantsOf(rootPid: number, rows: TmuxPaneProcess[]): Set<number> {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.ppid !== rootPid && !descendants.has(row.ppid)) continue;
      if (descendants.has(row.pid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return descendants;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcesses(pids: number[], signal: NodeJS.Signals): number {
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      killed += 1;
    } catch {
      // The process may already be gone.
    }
  }
  return killed;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:+=@%-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\''`)}'`;
}

async function readProcessCwd(pid: number): Promise<string | null> {
  return await readProcessCwdProbe(pid);
}

function readRelayRuntimeStateForTmuxSession(sessionName: string): RelayRuntimeState | null {
  const agentsDir = resolveOpenScoutSupportPaths().relayAgentsDirectory;
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const statePath = join(agentsDir, entry, "state.json");
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as RelayRuntimeState;
      if (parsed.sessionId === sessionName) return parsed;
    } catch {
      // Ignore malformed or partially-written runtime state files.
    }
  }
  return null;
}

function resumeScriptFromLaunchScript(launchScript: string, sessionId: string): string {
  const resumePrefix = `exec claude --resume ${shellQuote(sessionId)} `;
  const rewritten = launchScript.replace(/(^|\n)(\s*)claude\s+/u, `$1$2${resumePrefix}`);
  return rewritten === launchScript
    ? `${launchScript}\n# OpenScout resume fallback\n${resumePrefix}\n`
    : rewritten;
}

async function forceQuitRelayAgentProcessTree(agentId: string): Promise<boolean> {
  const rows = await allProcessCommandRows();
  const claudeRoots = rows.filter((row) =>
    /(^|\/)claude(\s|$)/u.test(row.command) && row.command.includes(agentId)
  );
  const targetPids = new Set<number>();
  for (const root of claudeRoots) {
    targetPids.add(root.pid);
    const descendants = descendantsOf(root.pid, rows);
    const targetGroups = new Set<number>([root.pgid]);
    for (const row of rows) {
      if (descendants.has(row.pid)) {
        targetPids.add(row.pid);
        targetGroups.add(row.pgid);
      }
    }
    for (const row of rows) {
      if (targetGroups.has(row.pgid)) targetPids.add(row.pid);
    }
  }
  return terminateProcessesWithEscalation([...targetPids]);
}

async function restartClaudeWithResumeInTmuxSurface(sessionName: string): Promise<{ ok: boolean; sessionId: string | null; transcriptPath: string | null }> {
  const runtimeState = readRelayRuntimeStateForTmuxSession(sessionName);
  const detail = await tmuxPaneDetail(sessionName);
  const surface = detail ? await claudeRowsInTmuxSurface(sessionName) : null;
  const liveClaudeCwd = surface?.claudeRows[0]?.pid
    ? await readProcessCwd(surface.claudeRows[0].pid)
    : null;
  const cwd = runtimeState?.projectRoot
    ?? liveClaudeCwd
    ?? detail?.paneCurrentPath
    ?? null;
  if (!cwd) return { ok: false, sessionId: null, transcriptPath: null };
  const transcript = mostRecentClaudeSessionForCwd(cwd);
  if (!transcript) return { ok: false, sessionId: null, transcriptPath: null };

  const launchScriptPath = runtimeState?.launchScript;
  const launchScript = launchScriptPath && existsSync(launchScriptPath)
    ? readFileSync(launchScriptPath, "utf8")
    : `#!/bin/bash
set -uo pipefail
cd ${shellQuote(cwd)}
exec claude --resume ${shellQuote(transcript.sessionId)}
`;
  const resumeScript = resumeScriptFromLaunchScript(launchScript, transcript.sessionId);

  try {
    if (runtimeState?.agentId) {
      await forceQuitRelayAgentProcessTree(runtimeState.agentId);
    } else if (detail) {
      await forceQuitClaudeInTmuxSurface(sessionName);
    }
    const command = `bash -lc ${shellQuote(resumeScript)}`;
    if (detail) {
      await execSystemFile("tmux", [
        "respawn-pane",
        "-k",
        "-t",
        sessionName,
        "-c",
        cwd,
        command,
      ], { timeoutMs: 5_000 });
    } else {
      await execSystemFile("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        cwd,
        command,
      ], { timeoutMs: 5_000 });
    }
    return { ok: true, sessionId: transcript.sessionId, transcriptPath: transcript.transcriptPath };
  } catch {
    return { ok: false, sessionId: transcript.sessionId, transcriptPath: transcript.transcriptPath };
  }
}

function terminateProcessesWithEscalation(pids: number[]): boolean {
  const targetPids = [...new Set(pids)]
    .filter((pid) => Number.isFinite(pid) && pid > 0)
    .sort((left, right) => right - left);
  if (targetPids.length === 0) return false;
  killProcesses(targetPids, "SIGTERM");
  const stillAlive = targetPids.filter(processExists);
  if (stillAlive.length > 0) {
    setTimeout(() => {
      killProcesses(stillAlive.filter(processExists), "SIGKILL");
    }, 750);
  }
  return true;
}

async function claudeRowsInTmuxSurface(sessionName: string): Promise<{
  detail: { panePid: number; paneTty: string };
  rows: TmuxPaneProcess[];
  panePgid: number;
  claudeRows: TmuxPaneProcess[];
} | null> {
  const detail = await tmuxPaneDetail(sessionName);
  if (!detail) return null;
  const rows = await processRowsForTmuxPane(detail);
  const descendantPids = descendantsOf(detail.panePid, rows);
  const panePgid = rows.find((row) => row.pid === detail.panePid)?.pgid ?? detail.panePid;
  const claudeRows = rows.filter((row) =>
    descendantPids.has(row.pid) && /(^|\/)claude$/u.test(row.comm)
  );
  return { detail, rows, panePgid, claudeRows };
}

async function stopClaudeActiveJobInTmuxSurface(sessionName: string): Promise<boolean> {
  const surface = await claudeRowsInTmuxSurface(sessionName);
  if (!surface) return false;
  const targetPids = new Set<number>();
  for (const claudeRow of surface.claudeRows) {
    const claudeDescendants = descendantsOf(claudeRow.pid, surface.rows);
    const jobGroups = new Set(
      surface.rows
        .filter((row) =>
          claudeDescendants.has(row.pid)
          && row.pgid !== surface.panePgid
          && row.pgid !== claudeRow.pgid
        )
        .map((row) => row.pgid),
    );
    for (const row of surface.rows) {
      if (claudeDescendants.has(row.pid) && jobGroups.has(row.pgid)) {
        targetPids.add(row.pid);
      }
    }
  }
  return terminateProcessesWithEscalation([...targetPids]);
}

async function forceQuitClaudeInTmuxSurface(sessionName: string): Promise<boolean> {
  const surface = await claudeRowsInTmuxSurface(sessionName);
  if (!surface) return false;
  const targetPids = [...new Set(surface.claudeRows.flatMap((row) =>
    surface.rows
      .filter((candidate) => candidate.pid === row.pid || descendantsOf(row.pid, surface.rows).has(candidate.pid))
      .map((candidate) => candidate.pid)
  ))].sort((left, right) => right - left);
  return terminateProcessesWithEscalation(targetPids);
}

async function controlTmuxSurface(sessionName: string, action: "interrupt" | "quit" | "stop-job" | "restart-resume" | "detach" | "force-quit"): Promise<boolean> {
  try {
    if (action === "interrupt") {
      await execSystemFile("tmux", ["send-keys", "-t", sessionName, "C-c"], { timeoutMs: 2_000 });
      return true;
    }
    if (action === "quit") {
      await execSystemFile("tmux", ["send-keys", "-t", sessionName, "C-d"], { timeoutMs: 2_000 });
      return true;
    }
    if (action === "stop-job") {
      return await stopClaudeActiveJobInTmuxSurface(sessionName);
    }
    if (action === "restart-resume") {
      return (await restartClaudeWithResumeInTmuxSurface(sessionName)).ok;
    }
    if (action === "force-quit") {
      return await forceQuitClaudeInTmuxSurface(sessionName);
    }
    await execSystemFile("tmux", ["detach-client", "-s", sessionName], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The full attachable inventory for hop resolution and local open: durable
 * registrations reconciled with whatever the hosts report live. Discovery
 * failure costs the discovered rows only — registered surfaces still resolve.
 */
async function terminalSessionInventoryForHop() {
  const registered = queryTerminalSessions({ limit: 500 });
  const discovered = await queryDiscoveredTerminalSessions({ limit: 1000 }).catch(() => []);
  return reconcileTerminalSessionInventory(registered, discovered, 1500);
}

export type TerminalRouteDeps = {
  options: Pick<CreateOpenScoutWebServerOptions, "captureTmuxPane" | "destroyTerminalRelaySession" | "destroyTerminalRelaySurface" | "openLocalTerminal" | "runTerminalCommand">;
  routes: OpenScoutWebRoutes;
};

export function mountTerminalRoutes(app: Hono, deps: TerminalRouteDeps) {
  const { options, routes } = deps;

  // What each terminal host can do, and whether it is installed here. Clients
  // read this to decide which actions to render, so a host that cannot do
  // something never gets a button that 400s.
  app.get("/api/terminal-hosts", async (c) => {
    const hosts = await describeTerminalHosts();
    const preferred = preferredTerminalHost(hosts);
    return c.json({
      ok: true,
      count: hosts.length,
      preferredHostId: preferred?.id ?? null,
      hosts,
    });
  });

  // Every herdr session, digested: what is blocked, what is moving, where the
  // panes live, and how each tab is arranged. The per-session topology route
  // below is the faithful projection; this is the RANKED one — the answer to
  // "what is going on in my workspaces" for a caller that cannot afford to
  // read the whole tree (Scoutbot, a bulletin, a narrow surface). Same rule as
  // the projection: no mutation verbs, herdr still owns the layout.
  app.get("/api/terminal-hosts/herdr/workspaces", async (c) => {
    if (!terminalHostAdapter("herdr")) return c.json({ error: "unknown terminal host" }, 404);
    const requested = c.req.query("session")?.trim();
    const sessions = requested
      ? [{ name: requested }]
      : await readHerdrSessions().catch(() => []);
    // A herdr install with no sessions is an ordinary empty state. Shelling a
    // topology read per session is bounded by herdr's own 2s topology cache,
    // but the session count is not, so cap the fan-out.
    const targets = sessions.slice(0, 8);
    const digests = await Promise.all(targets.map(async (session) => {
      const topology = await readHerdrTopology(session.name);
      return digestHerdrTopology(topology);
    }));
    return c.json({
      ok: true,
      count: digests.length,
      truncated: sessions.length > targets.length,
      digests,
    });
  });

  // A herdr session's workspace/tab/pane topology, projected read-only. Herdr
  // owns the layout; this exists so clients can REPRESENT a session faithfully
  // without Scout becoming a second layout manager. A stopped session projects
  // as running:false, an ordinary state rather than an error.
  app.get("/api/terminal-hosts/herdr/sessions/:name/topology", async (c) => {
    if (!terminalHostAdapter("herdr")) return c.json({ error: "unknown terminal host" }, 404);
    const name = c.req.param("name")?.trim();
    if (!name) return c.json({ error: "session name is required" }, 400);
    const topology = await readHerdrTopology(name);
    return c.json({ ok: true, topology });
  });

  // Handoff into the native herdr client: focus a pane/agent THERE. This is
  // deliberately not a TerminalSurfaceControlAction — focusing is a herdr
  // client action, not a Scout control verb over the surface.
  app.post("/api/terminal-hosts/herdr/sessions/:name/focus", async (c) => {
    if (!terminalHostAdapter("herdr")) return c.json({ error: "unknown terminal host" }, 404);
    const name = c.req.param("name")?.trim();
    if (!name) return c.json({ error: "session name is required" }, 400);
    const parsed = await readJsonBody(c, herdrFocusBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const target = body.target?.trim();
    if (!target) return c.json({ error: "target is required" }, 400);
    try {
      await execSystemFile("herdr", ["--session", name, "agent", "focus", target], { timeoutMs: 2_000 });
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "focus failed";
      return c.json({ ok: false, error: message }, 502);
    }
  });

  // Durable workspaces. The record is the web client's source of truth: it
  // seeds its deck from these routes and writes changes back, instead of
  // keeping a private store that cannot follow an operator to another device or
  // be reasoned about by the broker. macOS and iOS have not adopted it yet —
  // macOS still reads its own UserDefaults — so this is one client over a
  // shared object today, with the others to follow.
  app.get("/api/terminal-workspaces", async (c) => {
    const workspaces = queryTerminalWorkspaces({ limit: parseTerminalSessionLimit(c.req.query("limit")) });
    const resolutions = await resolveTerminalWorkspaces(workspaces);
    return c.json({ ok: true, count: workspaces.length, workspaces, resolutions });
  });

  app.get("/api/terminal-workspaces/:workspaceId", async (c) => {
    const workspace = queryTerminalWorkspace(c.req.param("workspaceId"));
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const [resolution] = await resolveTerminalWorkspaces([workspace]);
    return c.json({ ok: true, workspace, resolution });
  });

  app.put("/api/terminal-workspaces/:workspaceId", async (c) => {
    const parsed = await readJsonBody(c, terminalWorkspaceBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const name = body.name?.trim();
    if (!name) return c.json({ error: "name is required" }, 400);
    const workspace = upsertTerminalWorkspace({
      ...body,
      id: c.req.param("workspaceId"),
      name,
    });
    return c.json({ ok: true, workspace });
  });

  app.post("/api/terminal-workspaces", async (c) => {
    const parsed = await readJsonBody(c, terminalWorkspaceBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const name = body.name?.trim();
    if (!name) return c.json({ error: "name is required" }, 400);
    return c.json({ ok: true, workspace: upsertTerminalWorkspace({ ...body, name }) }, 201);
  });

  // Re-materialize one saved cell. The only path that creates a host session
  // from stored intent, and it refuses unless reconciliation says the cell is
  // actually revivable — an operator is never told a tile came back when the
  // host was never asked.
  app.post("/api/terminal-workspaces/:workspaceId/cells/:cellId/revive", async (c) => {
    const workspace = queryTerminalWorkspace(c.req.param("workspaceId"));
    if (!workspace) return c.json({ error: "workspace not found" }, 404);
    const [resolution] = await resolveTerminalWorkspaces([workspace]);
    const cell = resolution?.cells.find((candidate) => candidate.cellId === c.req.param("cellId"));
    if (!cell) return c.json({ error: "cell not found" }, 404);
    if (cell.status === "live") return c.json({ ok: true, revived: false, status: cell.status, detail: cell.detail });
    if (cell.status !== "revivable" || !cell.revive) {
      return c.json({ error: cell.detail, status: cell.status, capability: "create" }, 409);
    }

    const adapter = terminalHostAdapter(cell.revive.hostId);
    if (!adapter?.create) {
      return c.json({ error: `${cell.revive.hostId} cannot be started by Scout`, capability: "create" }, 501);
    }
    // Probe for real before shelling out. Reconciliation reads a cached
    // availability that deliberately holds a recent success through a
    // momentary failure, and acting on that memory is how a revive turns into
    // an unhandled spawn error instead of a 409.
    const availability = await adapter.probe();
    if (!availability.installed) {
      return c.json({
        error: availability.reason ?? `${adapter.label} is not installed here`,
        status: "unavailable",
        capability: "create",
      }, 409);
    }
    const created = await adapter.create({
      sessionName: cell.revive.sessionName,
      cwd: cell.revive.cwd,
      resumeCommand: cell.revive.resumeCommand,
    });
    // A session that came back WITHOUT the harness the cell asked for is not
    // "live" in the sense the operator means, so it does not get to say so.
    // `started` is a distinct outcome with its own detail; the alternative is
    // reporting a resumed agent when what is actually there is a bare shell.
    const resumedHarness = created.resumed !== false;
    return c.json({
      ok: created.created,
      revived: created.created,
      status: created.created ? (resumedHarness ? "live" : "started") : cell.status,
      resumed: created.resumed ?? null,
      sessionName: cell.revive.sessionName,
      ...(created.reason
        ? { detail: created.reason }
        : created.created && !resumedHarness
          ? { detail: `Started ${cell.revive.hostId} session ${cell.revive.sessionName}, but Scout could not replay the harness command there.` }
          : {}),
    }, created.created ? 200 : 502);
  });

  app.delete("/api/terminal-workspaces/:workspaceId", (c) => {
    const deleted = deleteTerminalWorkspace(c.req.param("workspaceId"));
    return c.json({ ok: true, deleted });
  });

  // Create a session on a host. The one primitive behind both "start something
  // new" for a host the relay cannot render and the workspace revive path.
  // Guarded by the declared capability, so a host that does not create sessions
  // answers 501 instead of pretending.
  app.post("/api/terminal-hosts/:hostId/sessions", async (c) => {
    const adapter = terminalHostAdapter(c.req.param("hostId"));
    if (!adapter) return c.json({ error: "unknown terminal host" }, 404);
    if (!adapter.capabilities.create || !adapter.create) {
      return c.json({ error: `${adapter.label} sessions cannot be started by Scout`, capability: "create" }, 501);
    }
    const parsed = await readJsonBody(c, terminalHostSessionCreateBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const sessionName = body.sessionName?.trim();
    if (!sessionName) return c.json({ error: "sessionName is required" }, 400);
    const availability = await adapter.probe();
    if (!availability.installed) {
      return c.json({ error: availability.reason ?? `${adapter.label} is not installed here` }, 409);
    }
    const created = await adapter.create({ sessionName, cwd: body.cwd ?? null });
    return c.json(
      { ok: created.created, created: created.created, hostId: adapter.id, sessionName, ...(created.reason ? { detail: created.reason } : {}) },
      created.created ? 201 : 502,
    );
  });

  app.get("/api/terminal-sessions", async (c) => {
    const backend = parseTerminalSessionBackend(c.req.query("backend"));
    if (c.req.query("backend") && !backend) {
      return c.json({ error: "backend must be a registered terminal host" }, 400);
    }
    const limit = parseTerminalSessionLimit(c.req.query("limit"));
    const sessions = queryTerminalSessions({
      ...(c.req.query("harness") ? { harness: c.req.query("harness") } : {}),
      ...(c.req.query("sourceSessionId") ? { sourceSessionId: c.req.query("sourceSessionId") } : {}),
      ...(backend ? { backend } : {}),
      limit,
    });
    const includeDiscovered = parseTerminalSessionDiscoveryFlag(c.req.query("includeDiscovered"));
    const discovered = includeDiscovered
      ? await queryDiscoveredTerminalSessions({
          ...(backend ? { backend } : {}),
          // Read the full host inventory so a registered surface can inherit
          // authoritative activity even when it is already at the result cap.
          limit: 1000,
        })
      : [];
    const visibleSessions = includeDiscovered
      ? reconcileTerminalSessionInventory(sessions, discovered, limit)
      : sessions;
    return c.json({
      ok: true,
      count: visibleSessions.length,
      sessions: visibleSessions,
    });
  });

  // Session → live terminal surface resolution, shared by every client that
  // renders an agent/session and wants to offer "hop into terminal": the web
  // hop menu, the macOS HUD, future thin clients. The same resolver also runs
  // client-side over this inventory; the endpoint exists for clients that
  // should not ship the matching rules.
  app.get("/api/terminal-sessions/resolve", async (c) => {
    const refs = c.req.queries("ref") ?? [];
    const agentId = c.req.query("agentId")?.trim() || undefined;
    const sessions = await terminalSessionInventoryForHop();
    const hit = resolveSessionTerminalSurface(sessions, { agentId, sessionRefs: refs });
    if (!hit) return c.json({ ok: true, target: null });
    const surfaceId = terminalSurfaceIdForSurface(hit.surface);
    const address = parseTerminalSurfaceId(surfaceId);
    // The native app routes only on the legacy backend:name key — never send
    // it the opaque form, or the link silently opens nothing.
    const legacySurface = address ? legacyTerminalSurfaceKey(address) : null;
    return c.json({
      ok: true,
      target: {
        sessionId: hit.session.id,
        via: hit.via,
        surfaceId,
        legacySurface,
        deepLink: legacySurface
          ? `scout://terminal?${new URLSearchParams({
              session: hit.session.id,
              surface: legacySurface,
              mode: "takeover",
            }).toString()}`
          : null,
        backend: hit.surface.backend,
        sessionName: hit.surface.sessionName,
        paneId: hit.surface.paneId,
        state: hit.surface.state ?? null,
        attachCommand: hit.surface.attachCommand,
        cwd: hit.session.cwd || null,
      },
    });
  });

  // The real-terminal hop behind one route so no client needs per-app launch
  // code. The client names a surface, never argv: the command comes off the
  // resolved surface, so this route cannot be aimed at anything a host
  // adapter did not already declare attachable.
  app.post("/api/terminal-sessions/open-local", async (c) => {
    const body = await c.req.json<{ surface?: unknown }>().catch(() => null);
    const handle = typeof body?.surface === "string" ? body.surface.trim() : "";
    if (!handle) return c.json({ error: "surface is required" }, 400);
    const sessions = await terminalSessionInventoryForHop();
    let matched: { session: (typeof sessions)[number]; surface: (typeof sessions)[number]["surfaces"][number] } | null = null;
    for (const session of sessions) {
      const surface = session.surfaces.find((candidate) => terminalSurfaceMatchesId(candidate, handle));
      if (surface) {
        matched = { session, surface };
        break;
      }
    }
    if (!matched) return c.json({ error: "terminal surface not found" }, 404);
    if (matched.surface.state === "exited") return c.json({ error: "terminal surface has exited" }, 409);
    if (matched.surface.attachCommand.length === 0) {
      return c.json({ error: "terminal surface has no attach command" }, 409);
    }
    try {
      const open = options.openLocalTerminal ?? openLocalTerminalAttach;
      const result = await open(matched.surface.attachCommand, { cwd: matched.session.cwd });
      return c.json({ ok: true, app: result.app });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to open a terminal";
      return c.json({ ok: false, error: message }, 502);
    }
  });

  app.get("/api/terminal-sessions/peek", async (c) => {
    const backend = parseTerminalSessionBackend(c.req.query("backend"));
    const sessionName = firstMetadataString(c.req.query("sessionName"));
    const capturedAt = Date.now();
    const lines = parseTmuxPeekLineCount(c.req.query("lines"));
    const columns = parseTmuxPeekColumnCount(c.req.query("cols") ?? c.req.query("columns"));

    if (!backend) {
      return c.json({ error: "backend must be a registered terminal host" }, 400);
    }
    if (!sessionName) {
      return c.json({ error: "sessionName is required" }, 400);
    }
    const previewHost = terminalHostAdapter(backend);
    if (!previewHost?.capabilities.capture) {
      return c.json({
        available: false,
        agentId: "terminal",
        sessionId: sessionName,
        capturedAt,
        body: "",
        lineCount: lines,
        columnCount: columns,
        truncated: false,
        reason: `${previewHost?.label ?? backend} does not report screen contents.`,
      });
    }
    if (backend !== "tmux") {
      // tmux keeps the dedicated capture path (line/column normalization, the
      // injectable capture hook the tests drive); other hosts go through the
      // adapter's own capture verb. `paneId` lets multi-pane hosts (herdr)
      // capture one pane instead of the session default.
      const paneId = firstMetadataString(c.req.query("paneId"));
      const body = await previewHost.capture?.({ sessionName, ...(paneId ? { paneId } : {}), lines });
      // normalizeTmuxPeekBody returns {body, lineCount, columnCount, truncated}
      // — spread the shape, don't nest it under `body` as one object.
      const normalized = body ? normalizeTmuxPeekBody(body, lines, columns) : null;
      return c.json({
        available: Boolean(body),
        agentId: "terminal",
        sessionId: sessionName,
        capturedAt,
        body: normalized?.body ?? "",
        lineCount: normalized?.lineCount ?? lines,
        columnCount: normalized?.columnCount ?? columns,
        truncated: normalized?.truncated ?? false,
        ...(body ? {} : { reason: `The ${previewHost.label} session is not available right now.` }),
      });
    }

    const capture = await (options.captureTmuxPane ?? defaultCaptureTmuxPane)({
      agentId: "terminal",
      sessionId: sessionName,
      paneTarget: sessionName,
      cwd: null,
      lines,
      columns,
    });
    if (!capture) {
      return c.json({
        available: false,
        agentId: "terminal",
        sessionId: sessionName,
        capturedAt,
        body: "",
        lineCount: lines,
        columnCount: columns,
        truncated: false,
        reason: "The tmux pane is not available right now.",
      });
    }

    const normalized = normalizeTmuxPeekBody(capture.body, lines, columns);
    return c.json({
      available: true,
      agentId: "terminal",
      sessionId: sessionName,
      capturedAt,
      body: normalized.body,
      lineCount: capture.lineCount ?? normalized.lineCount,
      columnCount: normalized.columnCount,
      truncated: capture.truncated ?? normalized.truncated,
      reason: null,
    });
  });

  app.post(routes.terminalRunPath, async (c) => {
    const parsed = await readJsonBody(c, terminalRunBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const command = body.command?.trim();
    if (!command) return c.json({ error: "missing command" }, 400);
    if (!options.runTerminalCommand) {
      return c.json({ error: "terminal relay is unavailable" }, 503);
    }
    try {
      await options.runTerminalCommand({
        command,
        cwd: body.cwd?.trim() || null,
        agentId: body.agentId?.trim() || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to queue command";
      return c.json({ error: message }, 503);
    }
    return c.json({ ok: true });
  });

  app.post("/api/terminal-relay/session/destroy", async (c) => {
    const parsed = await readJsonBody(c, terminalRelayDestroyBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return c.json({ error: "missing sessionId" }, 400);
    if (!options.destroyTerminalRelaySession) {
      return c.json({ error: "terminal relay is unavailable" }, 503);
    }
    try {
      const destroyed = await options.destroyTerminalRelaySession(sessionId);
      return c.json({ ok: true, destroyed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to destroy terminal session";
      return c.json({ error: message }, 503);
    }
  });

  app.post("/api/terminal-sessions/control", async (c) => {
    const parsed = await readJsonBody(c, terminalSurfaceControlBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const backend = parseTerminalSessionBackend(body.backend);
    const sessionName = body.sessionName?.trim();
    const action = parseTerminalSurfaceControlAction(body.action);

    if (!backend) return c.json({ error: "backend must be a registered terminal host" }, 400);
    if (!sessionName) return c.json({ error: "sessionName is required" }, 400);
    if (!action) return c.json({ error: "action must be interrupt, quit, stop-job, restart-resume, detach, release, force-quit, or force-quit-bridge" }, 400);

    // Capability, not backend. A host that cannot perform a verb says so with
    // the capability that is missing, and the UI is expected to have read
    // /api/terminal-hosts and not offered the action in the first place.
    const support = terminalHostSupportsControl(backend, action);
    if (!support.supported) {
      return c.json({
        error: `${backend} does not support ${action}`,
        backend,
        action,
        capability: "control",
      }, 501);
    }

    let delivered = false;
    let resumeResult: { ok: boolean; sessionId: string | null; transcriptPath: string | null } | null = null;
    if (support.via === "harness") {
      // Harness-aware verbs walk a process tree and read a Claude transcript;
      // they are Scout features layered over one host, not host features.
      if (action === "restart-resume") {
        resumeResult = await restartClaudeWithResumeInTmuxSurface(sessionName);
        delivered = resumeResult.ok;
      } else if (action !== "force-quit-bridge" && action !== "release") {
        delivered = await controlTmuxSurface(sessionName, action);
      }
    } else if (action !== "force-quit-bridge") {
      const adapter = resolveTerminalHostAdapter(backend);
      const result = await adapter.control?.(action, { sessionName });
      delivered = result?.delivered ?? false;
    }

    let destroyed = 0;
    if (action === "detach" || action === "release" || action === "force-quit" || action === "force-quit-bridge" || action === "restart-resume") {
      // Only hosts the relay can carry have a bridge to tear down. That is the
      // `relayAttach` capability plus what this vendored relay build accepts,
      // asked as one question instead of spelled out as a backend list here.
      const relayBackend = relayCarriedTerminalBackend(backend);
      if (options.destroyTerminalRelaySurface && relayBackend) {
        destroyed = await options.destroyTerminalRelaySurface(relayBackend, sessionName);
      }
      const detachSupport = terminalHostSupportsControl(backend, "detach");
      if (action !== "restart-resume" && action !== "detach" && action !== "release" && detachSupport.supported) {
        await resolveTerminalHostAdapter(backend).control?.("detach", { sessionName });
      }
    }

    return c.json({
      ok: true,
      action,
      backend,
      sessionName,
      delivered,
      destroyed,
      resumeSessionId: resumeResult?.sessionId ?? null,
      resumeTranscriptPath: resumeResult?.transcriptPath ?? null,
    });
  });
}
