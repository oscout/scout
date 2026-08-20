import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OpenScoutSupportPaths = {
  supportDirectory: string;
  logsDirectory: string;
  appLogsDirectory: string;
  brokerLogsDirectory: string;
  runtimeDirectory: string;
  catalogDirectory: string;
  relayAgentsDirectory: string;
  settingsPath: string;
  harnessCatalogPath: string;
  relayAgentsRegistryPath: string;
  managedInstallsPath: string;
  hostInfoPath: string;
  relayHubDirectory: string;
  controlHome: string;
  knowledgeDirectory: string;
  knowledgeQmdDirectory: string;
  knowledgeSqlitePath: string;
  desktopStatusPath: string;
  workspaceStatePath: string;
  cutoverMarkerPath: string;
};

const OPENSCOUT_RPC_CUTOVER_MARKER = "rpc-runtime-cutover-v1";

/**
 * Tests must never touch real user data. Every writer of OpenScout user state
 * calls this first: under a test runner (bun test sets NODE_ENV=test) the
 * write is refused unless the isolation env var redirects it to a temp
 * directory. This exists because an unisolated test once persisted its fake
 * temp-home workspaceRoots into the operator's real settings.json.
 */
export function assertTestIsolatedUserData(operation: string, isolationEnvKey: string): void {
  if (process.env.NODE_ENV !== "test") return;
  if (process.env[isolationEnvKey]?.trim()) return;
  throw new Error(
    `Refusing to ${operation} while NODE_ENV=test without ${isolationEnvKey} set. `
      + "Tests must isolate OpenScout user data in a temp directory (see prepareHome in onboarding.test.ts).",
  );
}

export function resolveOpenScoutSupportPaths(): OpenScoutSupportPaths {
  const home = homedir();
  const supportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY
    ?? join(home, "Library", "Application Support", "OpenScout");
  const logsDirectory = join(supportDirectory, "logs");
  const runtimeDirectory = join(supportDirectory, "runtime");
  const catalogDirectory = join(supportDirectory, "catalog");
  const controlHome = process.env.OPENSCOUT_CONTROL_HOME
    ?? join(home, ".openscout", "control-plane");
  const knowledgeDirectory = join(controlHome, "knowledge");

  return {
    supportDirectory,
    logsDirectory,
    appLogsDirectory: join(logsDirectory, "app"),
    brokerLogsDirectory: join(logsDirectory, "broker"),
    runtimeDirectory,
    catalogDirectory,
    relayAgentsDirectory: join(runtimeDirectory, "agents"),
    settingsPath: join(supportDirectory, "settings.json"),
    harnessCatalogPath: join(catalogDirectory, "harness-catalog.json"),
    relayAgentsRegistryPath: join(supportDirectory, "relay-agents.json"),
    managedInstallsPath: join(supportDirectory, "managed-installs.json"),
    hostInfoPath: join(supportDirectory, ".host-info"),
    relayHubDirectory: process.env.OPENSCOUT_RELAY_HUB
      ?? join(home, ".openscout", "relay"),
    controlHome,
    knowledgeDirectory,
    knowledgeQmdDirectory: join(knowledgeDirectory, "qmd"),
    knowledgeSqlitePath: join(knowledgeDirectory, "knowledge.sqlite"),
    desktopStatusPath: join(supportDirectory, "agent-status.json"),
    workspaceStatePath: join(supportDirectory, "workspace-state.json"),
    cutoverMarkerPath: join(supportDirectory, OPENSCOUT_RPC_CUTOVER_MARKER),
  };
}

export function localAgentRuntimeDirectory(agentId: string): string {
  return join(resolveOpenScoutSupportPaths().relayAgentsDirectory, agentId);
}

export function localAgentLogsDirectory(agentId: string): string {
  return join(localAgentRuntimeDirectory(agentId), "logs");
}

export function relayAgentRuntimeDirectory(agentId: string): string {
  return localAgentRuntimeDirectory(agentId);
}

export function relayAgentLogsDirectory(agentId: string): string {
  return localAgentLogsDirectory(agentId);
}

export function ensureOpenScoutCleanSlateSync(): void {
  assertTestIsolatedUserData("reset the OpenScout support directory", "OPENSCOUT_SUPPORT_DIRECTORY");
  const paths = resolveOpenScoutSupportPaths();
  if (existsSync(paths.cutoverMarkerPath)) {
    return;
  }

  rmSync(paths.supportDirectory, { recursive: true, force: true });
  rmSync(paths.controlHome, { recursive: true, force: true });
  rmSync(paths.relayHubDirectory, { recursive: true, force: true });

  mkdirSync(paths.supportDirectory, { recursive: true });
  writeFileSync(paths.cutoverMarkerPath, `${Date.now()}\n`, "utf8");
}
