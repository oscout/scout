export type DirectLocalAgentTransport = "codex_app_server" | "claude_stream_json" | "pi_rpc" | "grok_acp" | "kimi_acp" | "cursor_acp" | "opencode_acp";

const directLocalAgentTransports = new Set<string>([
  "codex_app_server",
  "claude_stream_json",
  "pi_rpc",
  "grok_acp",
  "kimi_acp",
  "cursor_acp",
  "opencode_acp",
]);

export function isDirectLocalAgentTransport(
  transport: string | null | undefined,
): transport is DirectLocalAgentTransport {
  return typeof transport === "string" && directLocalAgentTransports.has(transport);
}

export function isBrokerRunnableLocalAgentTransport(
  transport: string | null | undefined,
): boolean {
  return transport === "tmux" || isDirectLocalAgentTransport(transport);
}
