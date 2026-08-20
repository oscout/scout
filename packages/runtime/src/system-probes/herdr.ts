import { homedir } from "node:os";

import { emptyHerdrSessionTopology } from "@openscout/protocol";
import type {
  HerdrAgentSessionRef,
  HerdrLayoutRect,
  HerdrPaneProjection,
  HerdrSessionTopology,
  HerdrTabLayout,
  HerdrTabProjection,
  HerdrWorkspaceProjection,
} from "@openscout/protocol";

import type { RuntimeEnv } from "../portable-types.js";

import { defineProbeFamily, probeRunOutput, type ProbeCtx } from "./registry.js";
import { execProbeFile, execSystemFile, ProbeCommandError } from "./exec.js";
import { runWithScoutdFallback } from "./scoutd-client.js";

const HERDR_TTL_MS = 5_000;
const HERDR_TIMEOUT_MS = 2_000;

export type HerdrSessionInfo = {
  name: string;
  isDefault: boolean;
  running: boolean;
  /** Server-local only — never forward to browser clients. */
  sessionDir: string | null;
};

/**
 * Agent state as the host reports it, rather than as Scout infers it from
 * screen-scraping a rendered composer. Only meaningful while the session's
 * herdr server is running; a stopped session simply reports no agents.
 */
export type HerdrAgentInfo = {
  /** Pane id, which `herdr agent <verb> <target>` accepts. */
  target: string;
  name: string | null;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
  cwd: string | null;
};

function herdrBin(env: RuntimeEnv = process.env): string {
  return env.OPENSCOUT_HERDR_BIN?.trim() || "herdr";
}

/**
 * The parts of an environment that decide what `herdr session list` answers:
 * which binary runs, where it is found, and which config home its sessions
 * live in. Everything else in an environment is noise for this probe.
 */
type HerdrProbeTarget = { bin: string; path: string; home: string; xdgConfigHome: string | null };

function herdrProbeTarget(env: RuntimeEnv): HerdrProbeTarget {
  return {
    bin: herdrBin(env),
    path: env.PATH ?? "",
    home: env.HOME?.trim() || homedir(),
    // Kept apart from HOME: herdr resolves its config as $XDG_CONFIG_HOME/herdr
    // and falls back to ~/.config only when XDG is unset. Synthesizing a value
    // for it here would relocate the config dir and hide every real session.
    xdgConfigHome: env.XDG_CONFIG_HOME?.trim() || null,
  };
}

function parseHerdrProbeKey(key: string): HerdrProbeTarget {
  try {
    const parsed = JSON.parse(key) as Partial<HerdrProbeTarget>;
    if (typeof parsed?.bin === "string" && typeof parsed.path === "string" && typeof parsed.home === "string") {
      return {
        bin: parsed.bin,
        path: parsed.path,
        home: parsed.home,
        xdgConfigHome: typeof parsed.xdgConfigHome === "string" && parsed.xdgConfigHome.trim()
          ? parsed.xdgConfigHome.trim()
          : null,
      };
    }
  } catch {
    // A caller-supplied opaque string key; fall through to this process.
  }
  return herdrProbeTarget(process.env);
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ProbeCommandError
    && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit");
}

/**
 * One cache entry per ENVIRONMENT, the way the tmux and zellij probes key on
 * socket path and socket dir.
 *
 * This used to collapse every environment to the literal string `"default"`,
 * so a caller passing an environment with no herdr on its PATH was served the
 * inventory collected for a completely different environment — nine live
 * sessions from a probe that should have found none. A client-supplied socket
 * path is still never accepted, which is the property the old comment was
 * reaching for; that is achieved by deriving the key from an environment
 * instead of taking one.
 */
export function herdrProbeKey(input?: string | { env?: RuntimeEnv } | null): string {
  if (typeof input === "string") return input.trim() || "default";
  return JSON.stringify(herdrProbeTarget(input?.env ?? process.env));
}

export function parseHerdrSessionListJson(output: string): HerdrSessionInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return [];
  }

  const sessions = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : [];

  const out: HerdrSessionInfo[] = [];
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const isDefault = record.default === true || name === "default";
    const running = record.running === true;
    const sessionDir = typeof record.session_dir === "string" && record.session_dir.trim()
      ? record.session_dir.trim()
      : typeof record.sessionDir === "string" && record.sessionDir.trim()
        ? record.sessionDir.trim()
        : null;
    out.push({ name, isDefault, running, sessionDir });
  }
  return out;
}

/** Attach argv for a discovered Herdr session. Never includes socket paths. */
export function buildHerdrAttachCommand(session: Pick<HerdrSessionInfo, "name" | "isDefault">): string[] {
  if (session.isDefault || session.name === "default") {
    return ["herdr"];
  }
  return ["herdr", "session", "attach", session.name];
}

/** Create-or-attach argv for a Scout-owned named Herdr session. */
export function buildHerdrCreateAttachCommand(sessionName: string): string[] {
  const name = sessionName.trim();
  if (!name || name === "default") return ["herdr"];
  return ["herdr", "--session", name];
}

/**
 * Argv that brings a named Herdr session into existence with NO terminal
 * attached: the session's own headless server. `herdr --session <name>` needs a
 * TTY because it launches the client too; this is the half Scout wants, and the
 * session then shows up in `herdr session list` for anyone to attach to.
 */
export function buildHerdrStartServerCommand(sessionName: string): string[] {
  const name = sessionName.trim();
  if (!name || name === "default") return ["herdr", "server"];
  return ["herdr", "--session", name, "server"];
}

/** Argv for the first workspace inside a Scout-created Herdr session. */
export function buildHerdrWorkspaceCreateCommand(
  sessionName: string,
  input: { cwd?: string | null; label?: string | null } = {},
): string[] {
  const args = ["herdr", "--session", sessionName.trim(), "workspace", "create"];
  if (input.cwd?.trim()) args.push("--cwd", input.cwd.trim());
  if (input.label?.trim()) args.push("--label", input.label.trim());
  args.push("--no-focus");
  return args;
}

/**
 * `herdr agent list` answers over the socket API in JSON, wrapped as
 * `{ id, result: { agents: [...] } }`. Parse defensively: a status the schema
 * grows later reads as "unknown" rather than being guessed at, and an empty
 * result is an ordinary state (the session's server is not running).
 */
export function parseHerdrAgentList(output: string): HerdrAgentInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return [];
  }
  const result = parsed && typeof parsed === "object" && "result" in parsed
    ? (parsed as { result?: unknown }).result
    : parsed;
  const agents = result && typeof result === "object" && Array.isArray((result as { agents?: unknown }).agents)
    ? (result as { agents: unknown[] }).agents
    : [];

  const out: HerdrAgentInfo[] = [];
  for (const entry of agents) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const target = typeof record.pane_id === "string" && record.pane_id.trim()
      ? record.pane_id.trim()
      : typeof record.terminal_id === "string" && record.terminal_id.trim()
        ? record.terminal_id.trim()
        : null;
    if (!target) continue;
    out.push({
      target,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : null,
      status: normalizeHerdrAgentStatus(record.agent_status),
      cwd: typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : null,
    });
  }
  return out;
}

function normalizeHerdrAgentStatus(value: unknown): HerdrAgentInfo["status"] {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "idle":
      return "idle";
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/**
 * Run the listing in the environment the KEY names, not in this process's.
 *
 * The key already encodes the binary, the PATH, and the config home, so
 * rebuilding an environment from it is what makes the cache entry honest: the
 * answer stored under a key is the answer that key's environment produces.
 * Previously the environment a caller supplied was thrown away here and the
 * probe always ran against `process.env`.
 */
async function readHerdrSessionsLocal(key: string, ctx: ProbeCtx): Promise<HerdrSessionInfo[]> {
  const target = parseHerdrProbeKey(key);
  try {
    // XDG_CONFIG_HOME is forwarded only when the probed environment set it.
    // Forcing it to HOME when unset relocates herdr's config dir from
    // ~/.config/herdr to ~/herdr, and the inventory collapses to a phantom
    // "default" while every real session disappears from discovery.
    const env: RuntimeEnv = { ...process.env, PATH: target.path, HOME: target.home };
    if (target.xdgConfigHome) env.XDG_CONFIG_HOME = target.xdgConfigHome;
    else delete env.XDG_CONFIG_HOME;
    const { stdout } = await execProbeFile(ctx, target.bin, ["session", "list", "--json"], {
      env,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return parseHerdrSessionListJson(stdout);
  } catch (error) {
    if (isUnavailable(error)) return [];
    throw error;
  }
}

export const herdrSessionsProbe = defineProbeFamily<string | { env?: RuntimeEnv } | null, HerdrSessionInfo[]>({
  id: "herdr.sessions",
  ttlMs: HERDR_TTL_MS,
  timeoutMs: HERDR_TIMEOUT_MS,
  maxKeys: 8,
  idleKeyTtlMs: 5 * 60_000,
  maxConcurrentKeys: 1,
  normalizeKey: herdrProbeKey,
  run: (key, ctx) => {
    // scoutd answers from ITS environment, so it cannot serve a key that names
    // a different one. It does not serve this family today; asking anyway once
    // it does would silently reintroduce the bug this key was widened to fix.
    if (key !== herdrProbeKey(process.env ? { env: process.env } : null)) {
      return readHerdrSessionsLocal(key, ctx).then((value) => probeRunOutput(value, { backend: "local" }));
    }
    return runWithScoutdFallback({
      probeId: "herdr.sessions",
      key,
      ctx,
      local: () => readHerdrSessionsLocal(key, ctx),
    });
  },
});

export async function readHerdrSessions(options: { env?: RuntimeEnv; maxAgeMs?: number } = {}): Promise<HerdrSessionInfo[]> {
  const snapshot = await herdrSessionsProbe.for({ env: options.env }).fresh({
    maxAgeMs: options.maxAgeMs ?? HERDR_TTL_MS,
  });
  return snapshot.value ?? [];
}

export function invalidateHerdrSessions(options: { env?: RuntimeEnv; reason?: string } = {}): void {
  herdrSessionsProbe.invalidate({ env: options.env }, options.reason);
}

/**
 * Whether the herdr binary is present. Availability is not a capability: herdr
 * may be installed while a given session's server is stopped, in which case the
 * agent-state verbs return nothing rather than failing the host.
 */
export async function isHerdrAvailable(options: { env?: RuntimeEnv } = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.OPENSCOUT_HERDR_BIN?.trim()) return true;
  try {
    const { stdout } = await execProbeFile(
      {
        probeId: "herdr.which",
        signal: AbortSignal.timeout(HERDR_TIMEOUT_MS),
        timeoutMs: HERDR_TIMEOUT_MS,
        startedAt: Date.now(),
      },
      "which",
      ["herdr"],
      { maxStdoutBytes: 4_096, maxStderrBytes: 1_024 },
    );
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session topology projection
//
// Herdr owns workspaces/tabs/panes; Scout reads them. The projection is built
// from the session's three list commands, all of which answer
// `{ id, result: { ... } }` JSON over the socket API. A session whose server
// is stopped answers with connection-refused on stderr and a non-zero exit —
// that projects as `{ running: false, workspaces: [] }`, an ordinary state,
// not an error (the same reasoning as `observedAgents`).

const HERDR_TOPOLOGY_TTL_MS = 2_000;

type HerdrTopologyCacheEntry = { at: number; value: HerdrSessionTopology };
const herdrTopologyCache = new Map<string, HerdrTopologyCacheEntry>();

function herdrTopologyCacheKey(sessionName: string, env: RuntimeEnv): string {
  return `${herdrProbeKey({ env })}|${sessionName}`;
}

function unwrapHerdrResult(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const result = "result" in parsed ? (parsed as { result?: unknown }).result : parsed;
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

function herdrString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function herdrNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function herdrLayoutRect(value: unknown): HerdrLayoutRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = herdrNumber(record.x);
  const y = herdrNumber(record.y);
  const width = herdrNumber(record.width);
  const height = herdrNumber(record.height);
  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null;
}

/**
 * Per-tab layout geometry from `herdr --session <n> api snapshot`
 * (`result.snapshot.layouts[]`), keyed by tab id. Tabs the snapshot does not
 * cover simply project with `layout: null` — geometry is additive, never a
 * reason to drop a tab.
 */
export function parseHerdrSnapshotLayouts(snapshot: string): Map<string, HerdrTabLayout> {
  const result = unwrapHerdrResult(snapshot);
  const snapshotRaw = result && typeof result.snapshot === "object" && result.snapshot !== null
    ? (result.snapshot as Record<string, unknown>)
    : null;
  const layoutsRaw = Array.isArray(snapshotRaw?.layouts) ? (snapshotRaw.layouts as unknown[]) : [];

  const layouts = new Map<string, HerdrTabLayout>();
  for (const entry of layoutsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const tabId = herdrString(record.tab_id);
    const workspaceId = herdrString(record.workspace_id);
    const area = herdrLayoutRect(record.area);
    if (!tabId || !workspaceId || !area) continue;
    const panes = (Array.isArray(record.panes) ? (record.panes as unknown[]) : [])
      .flatMap((pane) => {
        if (!pane || typeof pane !== "object") return [];
        const paneRecord = pane as Record<string, unknown>;
        const paneId = herdrString(paneRecord.pane_id);
        const rect = herdrLayoutRect(paneRecord.rect);
        return paneId && rect ? [{ paneId, focused: paneRecord.focused === true, rect }] : [];
      });
    const splits = (Array.isArray(record.splits) ? (record.splits as unknown[]) : [])
      .flatMap((split) => {
        if (!split || typeof split !== "object") return [];
        const splitRecord = split as Record<string, unknown>;
        const direction = herdrString(splitRecord.direction);
        const narrowed: "right" | "down" | null = direction === "right" || direction === "down" ? direction : null;
        return [{
          id: herdrString(splitRecord.id),
          direction: narrowed,
          ratio: herdrNumber(splitRecord.ratio),
          rect: herdrLayoutRect(splitRecord.rect),
        }];
      });
    layouts.set(tabId, {
      tabId,
      workspaceId,
      area,
      focusedPaneId: herdrString(record.focused_pane_id),
      zoomed: record.zoomed === true,
      panes,
      splits,
    });
  }
  return layouts;
}

/**
 * Build the workspace/tab/pane tree from the three list payloads. Pure, so the
 * mapping is unit-tested against captured 0.7.x output without a herdr server.
 * Unknown agent statuses read as "unknown"; entries without ids are dropped
 * rather than guessed at.
 */
export function parseHerdrTopology(inputs: {
  workspaceList?: string;
  tabList?: string;
  paneList?: string;
  snapshot?: string;
}): HerdrWorkspaceProjection[] {
  const workspaceResult = inputs.workspaceList ? unwrapHerdrResult(inputs.workspaceList) : null;
  const tabResult = inputs.tabList ? unwrapHerdrResult(inputs.tabList) : null;
  const paneResult = inputs.paneList ? unwrapHerdrResult(inputs.paneList) : null;
  const layoutsByTab = inputs.snapshot ? parseHerdrSnapshotLayouts(inputs.snapshot) : new Map<string, HerdrTabLayout>();

  const workspacesRaw = Array.isArray(workspaceResult?.workspaces)
    ? (workspaceResult.workspaces as unknown[])
    : [];
  const tabsRaw = Array.isArray(tabResult?.tabs) ? (tabResult.tabs as unknown[]) : [];
  const panesRaw = Array.isArray(paneResult?.panes) ? (paneResult.panes as unknown[]) : [];

  const panesByTab = new Map<string, HerdrPaneProjection[]>();
  for (const entry of panesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const paneId = herdrString(record.pane_id);
    const tabId = herdrString(record.tab_id);
    const workspaceId = herdrString(record.workspace_id);
    if (!paneId || !tabId || !workspaceId) continue;
    const agentSessionRaw = record.agent_session;
    const agentSession: HerdrAgentSessionRef | null = agentSessionRaw && typeof agentSessionRaw === "object"
      ? (() => {
          const ref = agentSessionRaw as Record<string, unknown>;
          const agent = herdrString(ref.agent);
          const kind = herdrString(ref.kind);
          const source = herdrString(ref.source);
          const value = herdrString(ref.value);
          return agent && kind && source && value ? { agent, kind, source, value } : null;
        })()
      : null;
    const scrollRaw = record.scroll;
    const scrollRecord = scrollRaw && typeof scrollRaw === "object"
      ? (scrollRaw as Record<string, unknown>)
      : null;
    const scroll = scrollRecord
      && typeof scrollRecord.max_offset_from_bottom === "number"
      && typeof scrollRecord.offset_from_bottom === "number"
      && typeof scrollRecord.viewport_rows === "number"
      ? {
          maxOffsetFromBottom: scrollRecord.max_offset_from_bottom,
          offsetFromBottom: scrollRecord.offset_from_bottom,
          viewportRows: scrollRecord.viewport_rows,
        }
      : null;
    const pane: HerdrPaneProjection = {
      paneId,
      terminalId: herdrString(record.terminal_id),
      tabId,
      workspaceId,
      label: herdrString(record.label),
      agent: herdrString(record.agent),
      agentStatus: normalizeHerdrAgentStatus(record.agent_status),
      agentSession,
      cwd: herdrString(record.cwd),
      foregroundCwd: herdrString(record.foreground_cwd),
      focused: record.focused === true,
      scroll,
    };
    const list = panesByTab.get(tabId) ?? [];
    list.push(pane);
    panesByTab.set(tabId, list);
  }

  const tabsByWorkspace = new Map<string, HerdrTabProjection[]>();
  for (const entry of tabsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const tabId = herdrString(record.tab_id);
    const workspaceId = herdrString(record.workspace_id);
    if (!tabId || !workspaceId) continue;
    const tab: HerdrTabProjection = {
      tabId,
      workspaceId,
      label: herdrString(record.label),
      number: herdrNumber(record.number),
      focused: record.focused === true,
      agentStatus: normalizeHerdrAgentStatus(record.agent_status),
      panes: panesByTab.get(tabId) ?? [],
      layout: layoutsByTab.get(tabId) ?? null,
    };
    const list = tabsByWorkspace.get(workspaceId) ?? [];
    list.push(tab);
    tabsByWorkspace.set(workspaceId, list);
  }

  const workspaces: HerdrWorkspaceProjection[] = [];
  for (const entry of workspacesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const workspaceId = herdrString(record.workspace_id);
    if (!workspaceId) continue;
    workspaces.push({
      workspaceId,
      label: herdrString(record.label),
      number: herdrNumber(record.number),
      focused: record.focused === true,
      activeTabId: herdrString(record.active_tab_id),
      agentStatus: normalizeHerdrAgentStatus(record.agent_status),
      tabs: tabsByWorkspace.get(workspaceId) ?? [],
    });
  }
  return workspaces;
}

async function readHerdrTopologyUncached(sessionName: string, env: RuntimeEnv): Promise<HerdrSessionTopology> {
  const bin = herdrBin(env);
  const exec = (args: string[]) => execSystemFile(bin, ["--session", sessionName, ...args], {
    timeoutMs: HERDR_TIMEOUT_MS,
    env,
    maxStdoutBytes: 512 * 1024,
  });
  try {
    const [workspaceList, tabList, paneList] = await Promise.all(
      (["workspace", "tab", "pane"] as const).map(async (noun) => (await exec([noun, "list"])).stdout),
    );
    // Geometry is additive: an older herdr without `api snapshot` (or a busy
    // one timing out) must not take the whole projection down with it.
    const snapshot = await exec(["api", "snapshot"]).then((r) => r.stdout).catch(() => undefined);
    return {
      session: sessionName,
      running: true,
      workspaces: parseHerdrTopology({ workspaceList, tabList, paneList, snapshot }),
      observedAt: Date.now(),
    };
  } catch {
    // The session's herdr server is not running (connection refused). An
    // ordinary state: report an empty projection and let the caller offer the
    // start path instead of an error.
    return emptyHerdrSessionTopology(sessionName, false);
  }
}

/**
 * Topology reads are TTL-cached per (environment, session) — the terminals
 * view polls on a few-second cadence and agent status is the only fast-moving
 * part, so a 2s ceiling keeps it live without shelling herdr per render.
 */
export async function readHerdrTopology(
  sessionName: string,
  options: { env?: RuntimeEnv; maxAgeMs?: number } = {},
): Promise<HerdrSessionTopology> {
  const session = sessionName.trim();
  if (!session) return emptyHerdrSessionTopology(session, false);
  const env = options.env ?? process.env;
  const key = herdrTopologyCacheKey(session, env);
  const now = Date.now();
  const cached = herdrTopologyCache.get(key);
  if (cached && now - cached.at <= (options.maxAgeMs ?? HERDR_TOPOLOGY_TTL_MS)) {
    return cached.value;
  }
  const value = await readHerdrTopologyUncached(session, env);
  herdrTopologyCache.set(key, { at: now, value });
  return value;
}

export function invalidateHerdrTopology(
  sessionName?: string,
  options: { env?: RuntimeEnv; reason?: string } = {},
): void {
  void options.reason;
  if (!sessionName) {
    herdrTopologyCache.clear();
    return;
  }
  const suffix = `|${sessionName.trim()}`;
  for (const key of herdrTopologyCache.keys()) {
    if (key.endsWith(suffix)) herdrTopologyCache.delete(key);
  }
}
