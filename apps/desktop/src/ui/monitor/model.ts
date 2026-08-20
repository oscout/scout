import { parseScoutRuntimeSpec } from "@openscout/protocol";

export type ScoutTuiCommand = {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  enabled?: boolean;
};

export type ScoutHarnessCommandDefinition = {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  category: "conversation" | "targets" | "inspect" | "navigate";
};

export const SCOUT_HARNESS_COMMANDS: readonly ScoutHarnessCommandDefinition[] = [
  { name: "help", aliases: ["?"], usage: "/help [command]", summary: "Browse every command or inspect one command.", category: "inspect" },
  { name: "chat", usage: "/chat", summary: "Return to the Scout conversation.", category: "conversation" },
  { name: "ask", usage: "/ask <request>", summary: "Send a request to the active target; plain text does the same.", category: "conversation" },
  { name: "profile", aliases: ["profiles"], usage: "/profile [name]", summary: "Browse runtime profiles, inspect one, or make it the active target.", category: "targets" },
  { name: "runtime", aliases: ["runtimes"], usage: "/runtime [harness[/model[/effort]]]", summary: "Browse live runtime capabilities or select an exact broker-validated runtime.", category: "targets" },
  { name: "agent", aliases: ["agents"], usage: "/agent [name or id]", summary: "Browse live agents or attach this conversation to one exact agent.", category: "targets" },
  { name: "status", usage: "/status", summary: "Inspect broker health, counts, project, and the active target.", category: "inspect" },
  { name: "clear", usage: "/clear", summary: "Clear the local conversation viewport without deleting broker records.", category: "conversation" },
  { name: "fleet", usage: "/fleet", summary: "Open the live fleet view.", category: "navigate" },
  { name: "tail", usage: "/tail", summary: "Open the broker activity tail.", category: "navigate" },
  { name: "new", aliases: ["launch"], usage: "/new", summary: "Compose a new broker command and choose where it runs.", category: "navigate" },
] as const;

export type ScoutHarnessCommand =
  | { kind: "ask"; body: string }
  | { kind: "agent"; query?: string }
  | { kind: "profile"; profile?: string }
  | { kind: "runtime"; runtime?: string }
  | { kind: "status" }
  | { kind: "chat" }
  | { kind: "navigate"; tab: "fleet" | "tail" | "new" }
  | { kind: "clear" }
  | { kind: "help"; query?: string }
  | { kind: "empty" }
  | { kind: "invalid"; message: string };

export function parseScoutHarnessCommand(value: string): ScoutHarnessCommand {
  const input = value.trim();
  if (!input) return { kind: "empty" };
  if (!input.startsWith("/")) return { kind: "ask", body: input };

  const firstSpace = input.indexOf(" ");
  const token = (firstSpace < 0 ? input : input.slice(0, firstSpace)).toLowerCase();
  const argument = firstSpace < 0 ? "" : input.slice(firstSpace + 1).trim();
  const rawName = token.slice(1);
  const definition = SCOUT_HARNESS_COMMANDS.find((candidate) => (
    candidate.name === rawName || candidate.aliases?.includes(rawName)
  ));
  const name = definition?.name ?? rawName;
  switch (name) {
    case "ask":
      return argument
        ? { kind: "ask", body: argument }
        : { kind: "invalid", message: "Usage: /ask <request>" };
    case "agent":
      return argument ? { kind: "agent", query: argument } : { kind: "agent" };
    case "profile":
      return argument ? { kind: "profile", profile: argument } : { kind: "profile" };
    case "runtime":
      return argument ? { kind: "runtime", runtime: argument } : { kind: "runtime" };
    case "status":
      return { kind: "status" };
    case "chat":
      return { kind: "chat" };
    case "fleet":
      return { kind: "navigate", tab: "fleet" };
    case "tail":
      return { kind: "navigate", tab: "tail" };
    case "new":
      return { kind: "navigate", tab: "new" };
    case "clear":
      return { kind: "clear" };
    case "help":
      return argument ? { kind: "help", query: argument.replace(/^\//, "") } : { kind: "help" };
    default:
      return { kind: "invalid", message: `Unknown harness command: ${token}. Try /help.` };
  }
}

export function findScoutHarnessCommandDefinition(
  query: string,
): ScoutHarnessCommandDefinition | null {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  if (!needle) return null;
  return SCOUT_HARNESS_COMMANDS.find((candidate) => (
    candidate.name === needle || candidate.aliases?.includes(needle)
  )) ?? null;
}

export function parseScoutHarnessRuntime(value: string) {
  const literal = value.trim();
  const parsed = parseScoutRuntimeSpec(literal);
  if (!parsed.ok) {
    return {
      ok: false as const,
      message: `runtime_spec_invalid: ${parsed.error}`,
    };
  }
  return {
    ok: true as const,
    value: {
      literal,
      ...parsed.value,
    },
  };
}

export type ScoutHarnessAgentMatch =
  | { kind: "match"; index: number }
  | { kind: "ambiguous"; indices: number[] }
  | { kind: "missing" };

export function findScoutHarnessAgent(
  agents: Array<{ id: string; title: string }>,
  query: string,
): ScoutHarnessAgentMatch {
  const needle = query.trim().toLowerCase();
  if (!needle) return { kind: "missing" };

  const exactId = agents.findIndex((agent) => agent.id.toLowerCase() === needle);
  if (exactId >= 0) return { kind: "match", index: exactId };

  const exactTitles = agents.flatMap((agent, index) => (
    agent.title.toLowerCase() === needle ? [index] : []
  ));
  if (exactTitles.length === 1) return { kind: "match", index: exactTitles[0]! };
  if (exactTitles.length > 1) return { kind: "ambiguous", indices: exactTitles };

  const partials = agents.flatMap((agent, index) => (
    agent.id.toLowerCase().includes(needle) || agent.title.toLowerCase().includes(needle)
      ? [index]
      : []
  ));
  if (partials.length === 1) return { kind: "match", index: partials[0]! };
  if (partials.length > 1) return { kind: "ambiguous", indices: partials };
  return { kind: "missing" };
}

function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const contiguousIndex = haystack.indexOf(needle);
  if (contiguousIndex >= 0) {
    return contiguousIndex * 2 + Math.max(0, haystack.length - needle.length) * 0.01;
  }

  let score = 0;
  let cursor = 0;
  let previousMatch = -2;
  for (const character of needle) {
    const match = haystack.indexOf(character, cursor);
    if (match < 0) return null;
    score += match - cursor;
    if (match === previousMatch + 1) score -= 0.5;
    previousMatch = match;
    cursor = match + 1;
  }
  return score + haystack.length * 0.01;
}

export function filterScoutTuiCommands(
  commands: ScoutTuiCommand[],
  query: string,
): ScoutTuiCommand[] {
  return commands
    .filter((command) => command.enabled !== false)
    .map((command, index) => ({
      command,
      index,
      score: fuzzyScore(`${command.label} ${command.description} ${command.id}`, query),
    }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.command);
}

export function clampScoutTuiSelection(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(0, index), itemCount - 1);
}

export function moveScoutTuiSelection(
  index: number,
  direction: -1 | 1,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  return (clampScoutTuiSelection(index, itemCount) + direction + itemCount) % itemCount;
}
