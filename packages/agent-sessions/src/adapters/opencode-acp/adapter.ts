import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AdapterConfig } from "../../protocol/adapter.js";
import { AcpAdapter } from "../acp/adapter.js";
import { registerSecretValue } from "../../secret-redaction.js";

const DEFAULT_OPENCODE_ARGS = ["acp"];
const DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS = 60_000;
const OPENCODE_ACP_ADAPTER_TYPE = "opencode-acp";

/** OpenCode reads this as an extra config layer merged over the user's own config. */
const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

/** What OpenCode itself reads for the OpenCode Zen / OpenCode Go providers. */
const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";
/** Scout namespaces provider keys as SCOUT_*, mirroring SCOUT_XAI_API_KEY. */
const SCOUT_OPENCODE_API_KEY_ENV = "SCOUT_OPENCODE_API_KEY";

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
// PATH, so probe the install locations OpenCode's own installers use before
// falling back to a bare PATH lookup.
function defaultOpenCodeCommand(env: Record<string, string> | undefined): string {
  const override = firstNonEmptyString(env?.OPENCODE_BIN, process.env.OPENCODE_BIN);
  if (override) {
    return override;
  }
  const installedCandidates = [
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    join(homedir(), ".opencode", "bin", "opencode"),
    join(homedir(), ".local", "bin", "opencode"),
  ];
  return installedCandidates.find((candidate) => existsSync(candidate)) ?? "opencode";
}

/**
 * OpenCode's `acp` subcommand takes no model flag, so a per-session model is
 * expressed as a config overlay on the child environment. OpenCode merges this
 * over the user's global and project config rather than replacing it, which
 * keeps their MCP servers, plugins, and skills intact.
 */
function configContentEnv(
  rawOptions: Record<string, unknown>,
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const model = stringValue(rawOptions.model);
  if (!model) {
    return undefined;
  }

  // A caller-supplied overlay wins outright — it is already a full config.
  const existing = firstNonEmptyString(env?.[OPENCODE_CONFIG_CONTENT_ENV]);
  if (existing) {
    return undefined;
  }

  const overlay: Record<string, unknown> = {
    // OpenCode addresses models as `provider/model`; accept either form so a
    // catalog id such as `glm-5.2` resolves against OpenCode Zen.
    model: model.includes("/") ? model : `opencode/${model}`,
  };

  return { [OPENCODE_CONFIG_CONTENT_ENV]: JSON.stringify(overlay) };
}

/**
 * Workstation credentials live in the macOS login keychain (see
 * docs/local-secrets.md); env vars are only ad-hoc overrides. The broker is
 * started by launchd with a fixed environment, so without this lookup a
 * keychain-stored key would never reach a Scout-spawned OpenCode.
 */
function keychainSecret(name: string, commandOverride?: string | null): string | null {
  const candidates = commandOverride
    ? [commandOverride]
    : ["secret", join(homedir(), ".local", "bin", "secret")];
  for (const command of candidates) {
    try {
      const result = spawnSync(command, ["get", name], { encoding: "utf8", timeout: 5_000 });
      const value = result.status === 0 ? result.stdout?.trim() : "";
      if (value) return value;
    } catch {
      // Absent CLI or non-macOS host: fall through to the next candidate.
    }
  }
  return null;
}

/**
 * Scout holds provider keys under its own namespace so they can be managed
 * per-fleet; OpenCode only reads the vendor-native name. Bridge the two.
 *
 * A cached credential in ~/.local/share/opencode/auth.json takes precedence
 * over OPENCODE_API_KEY for any provider it already covers, so this env var
 * governs providers that auth.json does NOT list — notably `opencode-go`,
 * the subscription plan.
 */
function providerKeyEnv(
  env: Record<string, string> | undefined,
  useKeychain: boolean,
  secretCommand?: string | null,
): Record<string, string> | undefined {
  // An explicit vendor-native value is already what OpenCode wants.
  const native = firstNonEmptyString(env?.[OPENCODE_API_KEY_ENV], process.env[OPENCODE_API_KEY_ENV]);
  if (native) {
    registerSecretValue(native, "opencode-acp:env");
    return undefined;
  }
  const resolved = firstNonEmptyString(
    env?.[SCOUT_OPENCODE_API_KEY_ENV],
    process.env[SCOUT_OPENCODE_API_KEY_ENV],
  ) ?? (useKeychain ? keychainSecret(SCOUT_OPENCODE_API_KEY_ENV, secretCommand) : null);

  // Resolved credentials are sensitive by provenance, not by variable name —
  // register the exact string so log/tail boundaries can scrub it.
  registerSecretValue(resolved, "opencode-acp:credential");
  return resolved ? { [OPENCODE_API_KEY_ENV]: resolved } : undefined;
}

export const createAdapter = (config: AdapterConfig) => {
  const rawOptions = isRecord(config.options) ? config.options : {};
  const command = stringValue(rawOptions.command) ?? defaultOpenCodeCommand(config.env);
  const args = stringArray(rawOptions.args) ?? DEFAULT_OPENCODE_ARGS;
  // OpenCode advertises an `opencode-login` auth method even once credentials
  // are cached in ~/.local/share/opencode/auth.json, and that method is only an
  // instruction to run the CLI — there is no in-band flow to drive. Default to
  // not authenticating so a logged-in install starts straight into a session.
  const authMethodPreference = stringArray(rawOptions.authMethodPreference) ?? [];
  const childEnv = {
    ...configContentEnv(rawOptions, config.env),
    ...providerKeyEnv(
      config.env,
      typeof rawOptions.useKeychain === "boolean" ? rawOptions.useKeychain : true,
      stringValue(rawOptions.secretCommand),
    ),
  };

  return new AcpAdapter({
    ...config,
    ...(Object.keys(childEnv).length ? { env: { ...(config.env ?? {}), ...childEnv } } : {}),
    options: {
      clientName: "openscout",
      clientTitle: "OpenScout",
      ...rawOptions,
      adapterType: OPENCODE_ACP_ADAPTER_TYPE,
      command,
      args,
      startupTimeoutMs: typeof rawOptions.startupTimeoutMs === "number"
        ? rawOptions.startupTimeoutMs
        : DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS,
      requireAuth: typeof rawOptions.requireAuth === "boolean" ? rawOptions.requireAuth : false,
      authMethodPreference,
    },
  });
};
