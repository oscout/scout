import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import {
  SCOUT_MCP_CORE_TOOLS,
  resolveBridgeTokenFromConfig,
  startScoutMeshMcpBridge,
  type ScoutMeshBridgeConfigFile,
} from "../../core/mcp/mesh-bridge.ts";

const MESH_BRIDGE_HELP = `scout mesh bridge — Hold the outbound MCP relay connection for this node

Serves the Scout MCP tool surface to remote MCP clients via a mesh-front-door
relay. Caller identity comes from the relay's agent tokens; each identity gets
its own pinned server instance. Spec: docs/eng/sco-095-remote-mcp-gateway.md.

Usage:
  scout mesh bridge [--config <path>] [options]   Run in the foreground
  scout mesh bridge install [options]             Install as a LaunchAgent
  scout mesh bridge uninstall                     Remove the LaunchAgent
  scout mesh bridge status                        Show service state

Options (run + install):
  --relay <url>       MCP relay base URL (default: https://mcp.oscout.net)
  --token <bearer>    Relay infra token; prefer --token-keychain
  --token-keychain <service>
                      Read the token from the macOS keychain (default:
                      OPENSCOUT_MCP_BRIDGE_TOKEN)
  --sender <id>       Fallback identity for tokenless envelopes
                      (default: grokbot.spike)
  --node <id>         Node name in the relay (default: default)
  --tools <csv>       "core" (default) or explicit tool list
  --dir <path>        currentDirectory for tool resolution
  --config <path>     JSON config file; flags override its values
`;

const LAUNCH_AGENT_LABEL = "app.openscout.mcp-bridge";

function supportDirectory(): string {
  return join(homedir(), "Library", "Application Support", "OpenScout");
}

function defaultConfigPath(): string {
  return join(supportDirectory(), "mcp-bridge.json");
}

function launchAgentPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1]?.trim() || undefined;
}

function loadConfigFile(path: string): ScoutMeshBridgeConfigFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ScoutMeshBridgeConfigFile;
}

function resolveRunOptions(context: ScoutCommandContext, args: string[]): {
  config: ScoutMeshBridgeConfigFile;
  configPath: string;
} | { error: string } {
  const configPath = readFlag(args, "--config") ?? defaultConfigPath();
  const fromFile = loadConfigFile(configPath) ?? { relayUrl: "https://mcp.oscout.net" };

  const config: ScoutMeshBridgeConfigFile = {
    relayUrl: readFlag(args, "--relay") ?? fromFile.relayUrl ?? "https://mcp.oscout.net",
    token: readFlag(args, "--token") ?? fromFile.token,
    tokenKeychainService: readFlag(args, "--token-keychain")
      ?? fromFile.tokenKeychainService
      ?? (readFlag(args, "--token") || fromFile.token ? undefined : "OPENSCOUT_MCP_BRIDGE_TOKEN"),
    sender: readFlag(args, "--sender") ?? fromFile.sender ?? "grokbot.spike",
    node: readFlag(args, "--node") ?? fromFile.node ?? "default",
    tools: (() => {
      const flag = readFlag(args, "--tools");
      if (!flag) return fromFile.tools ?? "core";
      return flag === "core" ? "core" : flag.split(",").map((name) => name.trim()).filter(Boolean);
    })(),
    dir: readFlag(args, "--dir") ?? fromFile.dir,
  };
  if (!config.relayUrl) {
    return { error: "Missing relay URL: pass --relay or set relayUrl in the config file." };
  }
  return { config, configPath };
}

async function runBridge(context: ScoutCommandContext, args: string[]): Promise<void> {
  const resolved = resolveRunOptions(context, args);
  if ("error" in resolved) {
    context.stderr(resolved.error);
    process.exitCode = 1;
    return;
  }
  const { config } = resolved;

  const token = resolveBridgeTokenFromConfig(config)
    ?? context.env.OPENSCOUT_MCP_RELAY_TOKEN?.trim()
    ?? context.env.OPENSCOUT_MESH_RENDEZVOUS_TOKEN?.trim();
  if (!token) {
    context.stderr("No relay token found (flag, config, keychain, or env). See: scout mesh bridge --help");
    process.exitCode = 1;
    return;
  }

  const relayUrl = new URL(config.relayUrl);
  if (config.node && !relayUrl.searchParams.get("node")) {
    relayUrl.searchParams.set("node", config.node);
  }
  const toolNames = config.tools === "core" || !config.tools
    ? [...SCOUT_MCP_CORE_TOOLS]
    : config.tools;

  const handle = await startScoutMeshMcpBridge({
    relayUrl: relayUrl.toString(),
    token,
    senderId: config.sender ?? "grokbot.spike",
    currentDirectory: config.dir ?? defaultScoutContextDirectory(context),
    toolNames,
    env: context.env,
    log: (line) => context.stderr(line),
  });

  context.stderr(`bridge: node=${config.node} relay=${config.relayUrl}`);
  context.stderr("bridge: running — Ctrl-C to stop");

  await new Promise<void>((resolve) => {
    const stop = () => {
      // A wedged identity server must not turn shutdown into a zombie:
      // give graceful close a bounded window, then exit regardless.
      const force = setTimeout(() => process.exit(0), 5_000);
      void handle.close().finally(() => {
        clearTimeout(force);
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.exit(process.exitCode ?? 0);
}

function launchctl(context: ScoutCommandContext, args: string[]): { ok: boolean; output: string } {
  const result = Bun.spawnSync(["launchctl", ...args]);
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  return { ok: result.exitCode === 0, output };
}

async function installBridge(context: ScoutCommandContext, args: string[]): Promise<void> {
  const resolved = resolveRunOptions(context, args);
  if ("error" in resolved) {
    context.stderr(resolved.error);
    process.exitCode = 1;
    return;
  }
  const { config, configPath } = resolved;
  if (!resolveBridgeTokenFromConfig(config)) {
    context.stderr(
      `No token reachable at install time (keychain service: ${config.tokenKeychainService ?? "none"}). `
      + "Add it first: security add-generic-password -a openscout -s OPENSCOUT_MCP_BRIDGE_TOKEN -w <token>",
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(supportDirectory(), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(configPath, 0o600);

  const logDirectory = join(supportDirectory(), "logs");
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(logDirectory, "mcp-bridge.log");

  const entry = Bun.main;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entry}</string>
    <string>mesh</string>
    <string>bridge</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
  writeFileSync(launchAgentPlistPath(), plist);

  const domain = `gui/${process.getuid?.() ?? 501}`;
  launchctl(context, ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  const bootstrap = launchctl(context, ["bootstrap", domain, launchAgentPlistPath()]);
  if (!bootstrap.ok) {
    context.stderr(`launchctl bootstrap failed: ${bootstrap.output}`);
    process.exitCode = 1;
    return;
  }
  context.stdout(`Installed ${LAUNCH_AGENT_LABEL}`);
  context.stdout(`  config: ${configPath}`);
  context.stdout(`  logs:   ${logPath}`);
  context.stdout(`  runner: ${process.execPath} ${entry}`);
}

async function uninstallBridge(context: ScoutCommandContext): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  launchctl(context, ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  if (existsSync(launchAgentPlistPath())) {
    unlinkSync(launchAgentPlistPath());
  }
  context.stdout(`Removed ${LAUNCH_AGENT_LABEL} (config file kept).`);
}

async function bridgeStatus(context: ScoutCommandContext): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const result = launchctl(context, ["print", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  if (!result.ok) {
    context.stdout("mcp-bridge service: not installed");
    return;
  }
  const state = result.output.match(/state = (.+)/)?.[1] ?? "unknown";
  const pid = result.output.match(/pid = (\d+)/)?.[1];
  context.stdout(`mcp-bridge service: ${state}${pid ? ` (pid ${pid})` : ""}`);
  context.stdout(`  logs: ${join(supportDirectory(), "logs", "mcp-bridge.log")}`);
}

export async function runMeshBridgeCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    context.stdout(MESH_BRIDGE_HELP);
    return;
  }
  if (subcommand === "install") {
    return installBridge(context, args.slice(1));
  }
  if (subcommand === "uninstall") {
    return uninstallBridge(context);
  }
  if (subcommand === "status") {
    return bridgeStatus(context);
  }
  return runBridge(context, args);
}
