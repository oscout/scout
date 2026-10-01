import type { AdapterConfig } from "../../protocol/adapter.js";
import { AcpAdapter } from "../acp/adapter.js";

/** OpenClaw owns Gateway authentication, model configuration and tool policy. */
export const createAdapter = (config: AdapterConfig) => {
  const options = config.options ?? {};
  for (const key of ["model", "reasoningEffort"] as const) {
    if (options[key] != null && options[key] !== "") {
      throw new Error(`OpenClaw ACP does not support Scout ${key} selection. Configure the OpenClaw Gateway agent instead.`);
    }
  }
  if (options.mcpServers != null
    && (!Array.isArray(options.mcpServers) || options.mcpServers.length > 0)) {
    throw new Error("OpenClaw ACP does not support per-session MCP servers. Configure tools on the OpenClaw Gateway agent instead.");
  }
  const command = typeof options.command === "string" && options.command.trim()
    ? options.command.trim()
    : config.env?.OPENSCOUT_OPENCLAW_BIN?.trim() || process.env.OPENSCOUT_OPENCLAW_BIN?.trim() || "openclaw";
  if (options.args != null && (!Array.isArray(options.args) || !options.args.every((arg) => typeof arg === "string"))) {
    throw new Error("OpenClaw ACP args must be an array of strings.");
  }
  const args = (options.args as string[] | undefined) ?? ["acp"];
  // ACP launch arguments are recorded in session metadata. Never put Gateway
  // credentials there; the upstream CLI supports credential files instead.
  if (args.some((arg) => /^--(?:token|password)(?:=|$)/.test(arg))) {
    throw new Error("Use OpenClaw --token-file/--password-file or Gateway credential configuration instead of inline credentials.");
  }
  return new AcpAdapter({
    ...config,
    options: {
      ...options,
      adapterType: "openclaw-acp",
      command,
      args,
      requireAuth: false,
      authMethodId: null,
      authMethodPreference: [],
      mcpServers: [],
      // An explicit continuation must never fall back to a fresh conversation.
      ...(options.sessionId && (!options.sessionMode || options.sessionMode === "auto")
        ? { sessionMode: "resume" } : {}),
    },
  });
};
