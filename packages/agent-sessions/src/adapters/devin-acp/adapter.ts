import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AdapterConfig } from "../../protocol/adapter.js";
import { AcpAdapter } from "../acp/adapter.js";

const DEVIN_ACP_ADAPTER_TYPE = "devin-acp";
const DEFAULT_DEVIN_STARTUP_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length === value.length ? entries : null;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// GUI hosts and background brokers may not inherit the interactive shell's
// PATH, so probe the install location Devin's own installer uses before
// falling back to a bare PATH lookup.
function defaultDevinCommand(env: Record<string, string> | undefined): string {
  const override = firstNonEmptyString(
    env?.DEVIN_CLI_BIN,
    env?.OPENSCOUT_DEVIN_BIN,
    process.env.DEVIN_CLI_BIN,
    process.env.OPENSCOUT_DEVIN_BIN,
  );
  if (override) return override;

  const installed = join(homedir(), ".local", "bin", "devin");
  return existsSync(installed) ? installed : "devin";
}

/**
 * `devin acp` takes `--model` (also read from DEVIN_MODEL) but accepts no
 * per-session model switch once running, so a requested model becomes a
 * launch argument rather than a session/set_model call.
 */
function devinArgs(rawOptions: Record<string, unknown>): string[] {
  const explicit = stringArray(rawOptions.args);
  if (explicit) return explicit;

  const args = ["acp"];
  const model = stringValue(rawOptions.model);
  if (model) args.push("--model", model);
  return args;
}

export const createAdapter = (config: AdapterConfig) => {
  const rawOptions = isRecord(config.options) ? config.options : {};
  const command = stringValue(rawOptions.command) ?? defaultDevinCommand(config.env);
  const args = devinArgs(rawOptions);
  // `devin acp` advertises only `devin-browser`, which needs an interactive
  // browser flow — it cannot be driven headlessly. Stored CLI credentials
  // (~/.local/share/devin/credentials.toml) or WINDSURF_API_KEY already
  // authenticate the process, so default to not calling authenticate.
  const authMethodPreference = stringArray(rawOptions.authMethodPreference) ?? [];

  return new AcpAdapter({
    ...config,
    options: {
      clientName: "openscout",
      clientTitle: "OpenScout",
      ...rawOptions,
      adapterType: DEVIN_ACP_ADAPTER_TYPE,
      command,
      args,
      startupTimeoutMs: typeof rawOptions.startupTimeoutMs === "number"
        ? rawOptions.startupTimeoutMs
        : DEFAULT_DEVIN_STARTUP_TIMEOUT_MS,
      requireAuth: typeof rawOptions.requireAuth === "boolean" ? rawOptions.requireAuth : false,
      authMethodPreference,
    },
  });
};
