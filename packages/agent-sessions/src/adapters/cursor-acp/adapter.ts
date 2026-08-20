import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AdapterConfig } from "../../protocol/adapter.js";
import { AcpAdapter } from "../acp/adapter.js";

const CURSOR_ACP_ADAPTER_TYPE = "cursor-acp";
const DEFAULT_CURSOR_ARGS = ["acp"];

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

function defaultCursorCommand(env: Record<string, string> | undefined): string {
  const override = firstNonEmptyString(
    env?.CURSOR_CLI_BIN,
    env?.CURSOR_AGENT_BIN,
    env?.OPENSCOUT_CURSOR_AGENT_BIN,
    process.env.CURSOR_CLI_BIN,
    process.env.CURSOR_AGENT_BIN,
    process.env.OPENSCOUT_CURSOR_AGENT_BIN,
  );
  if (override) return override;

  // Cursor and Grok both ship a binary named `agent`. OpenScout deliberately
  // uses Cursor's compatibility name so the two providers remain independent.
  const installed = join(homedir(), ".local", "bin", "cursor-agent");
  return existsSync(installed) ? installed : "cursor-agent";
}

export const createAdapter = (config: AdapterConfig) => {
  const rawOptions = isRecord(config.options) ? config.options : {};
  const command = stringValue(rawOptions.command) ?? defaultCursorCommand(config.env);
  const args = stringArray(rawOptions.args) ?? DEFAULT_CURSOR_ARGS;

  return new AcpAdapter({
    ...config,
    options: {
      clientName: "openscout",
      clientTitle: "OpenScout",
      ...rawOptions,
      adapterType: CURSOR_ACP_ADAPTER_TYPE,
      command,
      args,
      startupTimeoutMs: typeof rawOptions.startupTimeoutMs === "number" ? rawOptions.startupTimeoutMs : 60_000,
      requireAuth: typeof rawOptions.requireAuth === "boolean" ? rawOptions.requireAuth : true,
      authMethodPreference: stringArray(rawOptions.authMethodPreference) ?? ["cursor_login"],
      cursorExtensions: typeof rawOptions.cursorExtensions === "boolean" ? rawOptions.cursorExtensions : true,
    },
  });
};
