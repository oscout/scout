import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AdapterConfig } from "../../protocol/adapter.js";
import { AcpAdapter } from "../acp/adapter.js";

const DEFAULT_KIMI_ARGS = ["acp"];
const DEFAULT_KIMI_STARTUP_TIMEOUT_MS = 60_000;
const KIMI_ACP_ADAPTER_TYPE = "kimi-acp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length === value.length ? entries : null;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

// GUI hosts and background brokers may not inherit the interactive shell's
// PATH. Prefer Kimi's managed install location, while retaining the legacy
// ~/.local/bin location used by earlier installers.
function defaultKimiCommand(env: Record<string, string> | undefined): string {
  const override = firstNonEmptyString(env?.KIMI_CLI_BIN, process.env.KIMI_CLI_BIN);
  if (override) {
    return override;
  }
  const installedCandidates = [
    join(homedir(), ".kimi-code", "bin", "kimi"),
    join(homedir(), ".local", "bin", "kimi"),
  ];
  return installedCandidates.find((candidate) => existsSync(candidate)) ?? "kimi";
}

export const createAdapter = (config: AdapterConfig) => {
  const rawOptions = isRecord(config.options) ? config.options : {};
  const command = stringValue(rawOptions.command) ?? defaultKimiCommand(config.env);
  const args = stringArray(rawOptions.args) ?? DEFAULT_KIMI_ARGS;
  const authMethodPreference = stringArray(rawOptions.authMethodPreference) ?? ["login"];

  return new AcpAdapter({
    ...config,
    options: {
      clientName: "openscout",
      clientTitle: "OpenScout",
      ...rawOptions,
      adapterType: KIMI_ACP_ADAPTER_TYPE,
      command,
      args,
      startupTimeoutMs: typeof rawOptions.startupTimeoutMs === "number"
        ? rawOptions.startupTimeoutMs
        : DEFAULT_KIMI_STARTUP_TIMEOUT_MS,
      requireAuth: typeof rawOptions.requireAuth === "boolean" ? rawOptions.requireAuth : true,
      authMethodPreference,
    },
  });
};
