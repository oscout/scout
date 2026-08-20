import type { RuntimeEnv } from "./portable-types.js";
type ManagedAgentEnvironmentOptions = {
  agentName: string;
  currentDirectory: string;
};

function managedAgentEnvironmentEntries(
  options: ManagedAgentEnvironmentOptions,
): Array<[key: string, value: string]> {
  const agentName = options.agentName.trim();
  const currentDirectory = options.currentDirectory.trim();
  const entries: Array<[key: string, value: string]> = [
    ["OPENSCOUT_AGENT", agentName],
    ["OPENSCOUT_SETUP_CWD", currentDirectory],
    ["OPENSCOUT_MANAGED_AGENT", "1"],
  ];

  return entries.filter(([, value]) => value.length > 0);
}

export function buildManagedAgentEnvironment(
  options: ManagedAgentEnvironmentOptions & {
    baseEnv?: RuntimeEnv;
  },
): RuntimeEnv {
  const env: RuntimeEnv = {
    ...(options.baseEnv ?? process.env),
  };

  for (const [key, value] of managedAgentEnvironmentEntries(options)) {
    env[key] = value;
  }

  return env;
}

export function buildManagedAgentShellExports(
  options: ManagedAgentEnvironmentOptions,
): string[] {
  return managedAgentEnvironmentEntries(options)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`);
}
