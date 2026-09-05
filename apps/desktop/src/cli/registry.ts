export type ScoutCommandRegistration = {
  name: string;
  summary: string;
  status?: "stable" | "deprecated";
  canonicalName?: string;
  deprecationMessage?: string;
};

export const SCOUT_COMMANDS: ScoutCommandRegistration[] = [
  { name: "help", summary: "Show help text" },
  { name: "version", summary: "Print the Scout CLI version" },
  { name: "setup", summary: "Bootstrap local settings and broker" },
  { name: "doctor", summary: "Show broker health and project inventory" },
  { name: "attention", summary: "Show recent unfinished work and local diffs" },
  { name: "diff", summary: "Inspect worktree or session-scoped diffs" },
  { name: "runtimes", summary: "Show harness catalog and readiness" },
  { name: "providers", summary: "Show provider usage quota windows" },
  { name: "role", summary: "Assign roles (orchestrator) and read/write mission logs" },
  { name: "env", summary: "Show executable and agent identity context" },
  { name: "whoami", summary: "Resolve your current Scout sender identity" },
  { name: "search", summary: "Past harness sessions — explicit index → FTS (prefer over grepping ~/.codex|claude|kimi)" },
  { name: "inbox", summary: "Read recent direct or addressed messages for this identity" },
  { name: "match", summary: "Rendezvous with one participant by shared project topic" },
  { name: "send", summary: "Tell one target or post to an explicit channel" },
  { name: "session", summary: "Actions on a harness session" },
  { name: "statusline", summary: "Capture harness statusline metadata" },
  { name: "speak", summary: "Send and speak aloud via TTS" },
  { name: "ask", summary: "Hand work to one agent and wait for acknowledgement" },
  { name: "need", summary: "Tell your operator you are blocked and need an answer" },
  { name: "alias", summary: "Manage scoped broker-owned route aliases" },
  { name: "wait", summary: "Wait for an ask by invocation, flight, message, or ref" },
  { name: "flight", summary: "Follow an existing ask flight" },
  { name: "label", summary: "Watch, feed, or brief related work by label" },
  { name: "card", summary: "Create a dedicated reply-ready Scout agent card" },
  { name: "watch", summary: "Stream broker messages" },
  { name: "tail", summary: "Stream observed harness events" },
  { name: "who", summary: "List agents and last activity" },
  { name: "latest", summary: "Show the latest Scout activity" },
  { name: "mcp", summary: "Run a Scout MCP server over stdio" },
  { name: "channel", summary: "Read channel messages or run a Claude Code channel server" },
  { name: "broadcast", summary: "Broadcast to channel.shared" },
  { name: "up", summary: "Spawn a local agent for a project" },
  { name: "down", summary: "Stop one or all local agents" },
  { name: "ps", summary: "List configured local agents" },
  { name: "restart", summary: "Restart configured local agents" },
  { name: "app", summary: "Start, stop, restart, or inspect the OpenScout app and its services" },
  { name: "menu", summary: "Launch the OpenScout macOS menu bar app" },
  { name: "install", summary: "Download and install the OpenScout macOS app" },
  { name: "update", summary: "Update the installed OpenScout macOS app", canonicalName: "install" },
  { name: "config", summary: "View or set user config (name, handle, agent name pool, etc.)" },
  { name: "mesh", summary: "Mesh status, diagnostics, and trust-cone peers/enrollment" },
  {
    name: "monitor",
    summary: "Retired: legacy OpenTUI console (use 'scout tui')",
    status: "deprecated",
    deprecationMessage: "`scout monitor` has been retired. Use `scout tui`.",
  },
  { name: "pair", summary: "Pair a companion device via QR" },
  { name: "server", summary: "Run the Scout web UI (Bun; see: scout server start/open)" },
  { name: "tui", summary: "Launch the Scout TUI" },
  { name: "init", summary: "Write ~/.openscout/config.json with broker/web/pairing ports" },
];

export function listScoutPrimaryCommands(): ScoutCommandRegistration[] {
  return SCOUT_COMMANDS.filter((command) => (command.status ?? "stable") === "stable");
}

export function listScoutDeprecatedCommands(): ScoutCommandRegistration[] {
  return SCOUT_COMMANDS.filter((command) => command.status === "deprecated");
}

export function findScoutCommandRegistration(name: string): ScoutCommandRegistration | undefined {
  return SCOUT_COMMANDS.find((command) => command.name === name);
}
