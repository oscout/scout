/**
 * Recognizing a running Scout bridge (`scout mcp`, `scout channel`,
 * `scout mesh bridge`) from its `ps` args.
 *
 * Matching is anchored on how the process was launched — a bun/node runtime
 * whose script is a Scout CLI entrypoint, or the entrypoint itself as argv[0] —
 * so a harness prompt or shell line that merely mentions "scout.ts mesh bridge"
 * is never taken for one. Paths may contain spaces (`Application Support`), so
 * the script is matched lazily up to the entrypoint rather than as one token.
 */

const ENTRYPOINT = String.raw`(?:scout\.(?:mjs|ts|js)|\/bin\/scout|\/main\.mjs)`;
const SUBCOMMAND = String.raw`\s+(mcp|channel|mesh\s+bridge)(?:\s|$)`;
// Runtime flags before the script. Eval/print modes (`-e`, `-p`, `--eval`,
// `--print`) take source text, not a script, so they never match.
const RUNTIME = String.raw`(?:\S*\/)?(?:bun|node)(?:\s+(?!(?:-e|-p|--eval|--print)(?:[\s=]|$))-[\w-]+(?:=\S+)?)*`;
// The runtime's script path, up to the entrypoint. It may contain spaces
// (`Application Support`) but never crosses into the script's own arguments:
// no ` -flag` and no other script (`innocent.ts `) inside it.
const SCRIPT_PREFIX = String.raw`(?:[^-\s](?:(?!\s-|\.(?:[cm]?js|ts)\s).)*?)?`;
const SCOUT_BRIDGE_COMMAND = new RegExp(
  String.raw`^(?:${RUNTIME}\s+${SCRIPT_PREFIX}|\S*?)${ENTRYPOINT}${SUBCOMMAND}`,
);

/** The standalone MCP binary, which carries no subcommand; direct or via a runtime. */
const SCOUT_BRIDGE_BINARY = new RegExp(
  String.raw`^(?:${RUNTIME}\s+(?:${SCRIPT_PREFIX}\/)?|\S*\/)?scout-mcp(?:\s|$)`,
);

export type ScoutBridgeKind = "mcp" | "channel" | "mesh";

export function classifyScoutBridgeCommand(args: string): ScoutBridgeKind | null {
  const lowered = args.trim().toLowerCase();
  const match = SCOUT_BRIDGE_COMMAND.exec(lowered);
  if (match) return match[1]!.startsWith("mesh") ? "mesh" : (match[1] as ScoutBridgeKind);
  return SCOUT_BRIDGE_BINARY.test(lowered) ? "mcp" : null;
}

export function isMeshBridgeCommand(args: string): boolean {
  return classifyScoutBridgeCommand(args) === "mesh";
}
