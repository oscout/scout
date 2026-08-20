import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterConfig } from "../../protocol/adapter.js";
import { registerSecretValue } from "../../secret-redaction.js";
import { AcpAdapter } from "../acp/adapter.js";

const DEFAULT_GROK_ARGS = ["--no-auto-update", "agent", "stdio"];
const GROK_ACP_ADAPTER_TYPE = "grok-acp";

// A bare "grok" spawn resolves through the parent's PATH, which under bun's
// script runner has every ancestor node_modules/.bin prepended — an unrelated
// npm "grok" shim there shadows the xAI CLI and exits 1. Prefer the official
// install location so the daemon and an interactive shell agree on the binary.
function defaultGrokCommand(env: Record<string, string> | undefined): string {
  const override = firstNonEmptyString(env?.GROK_CLI_BIN, process.env.GROK_CLI_BIN);
  if (override) {
    return override;
  }
  const installed = join(homedir(), ".grok", "bin", "grok");
  return existsSync(installed) ? installed : "grok";
}

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

function resolveGrokEnvironment(configEnv: Record<string, string> | undefined): {
  env: Record<string, string> | undefined;
  hasXaiApiKey: boolean;
} {
  const xaiApiKey = firstNonEmptyString(
    configEnv?.XAI_API_KEY,
    configEnv?.SCOUT_XAI_API_KEY,
    process.env.XAI_API_KEY,
    process.env.SCOUT_XAI_API_KEY,
  );

  if (!xaiApiKey) {
    return { env: configEnv, hasXaiApiKey: false };
  }
  registerSecretValue(xaiApiKey, "grok-acp:env");

  registerSecretValue(xaiApiKey, "grok-acp:env");

  return {
    env: {
      ...(configEnv ?? {}),
      XAI_API_KEY: configEnv?.XAI_API_KEY?.trim() ? configEnv.XAI_API_KEY : xaiApiKey,
    },
    hasXaiApiKey: true,
  };
}

function defaultAuthPreference(hasXaiApiKey: boolean): string[] {
  return hasXaiApiKey ? ["xai.api_key", "cached_token"] : ["cached_token"];
}

export const createAdapter = (config: AdapterConfig) => {
  const rawOptions = isRecord(config.options) ? config.options : {};
  const { env, hasXaiApiKey } = resolveGrokEnvironment(config.env);

  const command = stringValue(rawOptions.command) ?? defaultGrokCommand(config.env);
  const args = stringArray(rawOptions.args) ?? DEFAULT_GROK_ARGS;
  const authMethodPreference = stringArray(rawOptions.authMethodPreference)
    ?? defaultAuthPreference(hasXaiApiKey);

  return new AcpAdapter({
    ...config,
    env,
    options: {
      clientName: "openscout",
      clientTitle: "OpenScout",
      ...rawOptions,
      adapterType: GROK_ACP_ADAPTER_TYPE,
      command,
      args,
      requireAuth: typeof rawOptions.requireAuth === "boolean" ? rawOptions.requireAuth : true,
      authMethodPreference,
    },
  });
};
