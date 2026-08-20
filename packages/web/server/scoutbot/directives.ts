export type ScoutbotReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type ScoutbotDirectiveAction =
  | "help"
  | "agents"
  | "status"
  | "recent"
  | "doing"
  | "flight"
  | "steer";

export type ScoutbotDirectiveCommand = {
  name: ScoutbotDirectiveAction;
  raw: string;
  args: string;
};

export type ScoutbotDirectiveSet = {
  reasoningEffort?: ScoutbotReasoningEffort;
  targetSessionId?: string;
};

export type ScoutbotDirectiveParseResult = {
  original: string;
  body: string;
  messageBody: string;
  command: ScoutbotDirectiveCommand | null;
  directives: ScoutbotDirectiveSet;
};

const ACTIONS = new Set<ScoutbotDirectiveAction>([
  "help",
  "agents",
  "status",
  "recent",
  "doing",
  "flight",
  "steer",
]);

const EFFORT_ALIASES: Record<string, ScoutbotReasoningEffort> = {
  none: "none",
  off: "none",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  quick: "low",
  medium: "medium",
  med: "medium",
  mid: "medium",
  high: "high",
  deep: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
};

const EFFORT_KEYS = new Set(["eff", "effort", "reasoning", "reasoning-effort", "reasoning_effort"]);
const SESSION_KEYS = new Set(["sid", "session", "session-id", "session_id", "target-session", "target_session"]);

export function parseScoutbotDirectives(input: string): ScoutbotDirectiveParseResult {
  const original = input.trim();
  const rawTokens = original.split(/\s+/).filter(Boolean);
  const directives: ScoutbotDirectiveSet = {};
  const bodyTokens: string[] = [];
  const messageTokens: string[] = [];
  let command: Omit<ScoutbotDirectiveCommand, "args"> | null = null;
  let commandIndex = -1;

  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index] ?? "";
    const directive = parseDirectiveToken(token);
    if (directive) {
      if (directive.kind === "reasoningEffort") {
        directives.reasoningEffort = directive.value;
      } else {
        directives.targetSessionId = directive.value;
      }
      continue;
    }

    messageTokens.push(token);

    const action: ScoutbotDirectiveAction | null = command ? null : parseActionToken(token);
    if (action) {
      command = { name: action, raw: token };
      commandIndex = index;
      continue;
    }

    bodyTokens.push(token);
  }

  const args = command
    ? rawTokens
      .slice(commandIndex + 1)
      .filter((token) => !parseDirectiveToken(token) && !parseActionToken(token))
      .join(" ")
      .trim()
    : "";

  return {
    original,
    body: bodyTokens.join(" ").trim(),
    messageBody: messageTokens.join(" ").trim(),
    command: command ? { ...command, args } : null,
    directives,
  };
}

export function scoutbotDirectiveMetadata(parsed: ScoutbotDirectiveParseResult): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (parsed.command) metadata.scoutbotAction = parsed.command.name;
  if (parsed.directives.reasoningEffort) metadata.reasoningEffort = parsed.directives.reasoningEffort;
  if (parsed.directives.targetSessionId) metadata.targetSessionId = parsed.directives.targetSessionId;
  if (
    (parsed.directives.reasoningEffort || parsed.directives.targetSessionId)
    && parsed.body
    && parsed.body !== parsed.original
  ) {
    metadata.directiveBody = parsed.body;
  }
  return metadata;
}

function parseActionToken(rawToken: string): ScoutbotDirectiveAction | null {
  const token = trimTokenBoundary(rawToken);
  const match = token.match(/^\/([A-Za-z][A-Za-z0-9_-]*)$/);
  if (!match?.[1]) return null;
  const action = match[1].toLowerCase().replace(/-/g, "_");
  return ACTIONS.has(action as ScoutbotDirectiveAction) ? action as ScoutbotDirectiveAction : null;
}

function parseDirectiveToken(rawToken: string):
  | { kind: "reasoningEffort"; value: ScoutbotReasoningEffort }
  | { kind: "targetSessionId"; value: string }
  | null {
  const token = trimTokenBoundary(rawToken);
  const separator = token.indexOf(":");
  if (separator <= 0) return null;

  const key = token.slice(0, separator).trim().toLowerCase();
  const value = normalizeDirectiveValue(token.slice(separator + 1));
  if (!value) return null;

  if (EFFORT_KEYS.has(key)) {
    const effort = EFFORT_ALIASES[value.toLowerCase()];
    return effort ? { kind: "reasoningEffort", value: effort } : null;
  }

  if (SESSION_KEYS.has(key) && isValidSessionId(value)) {
    return { kind: "targetSessionId", value };
  }

  return null;
}

function normalizeDirectiveValue(value: string): string {
  return trimTokenBoundary(value)
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

function trimTokenBoundary(value: string): string {
  return value
    .trim()
    .replace(/^[([{]+/g, "")
    .replace(/[)\]},.!?;]+$/g, "");
}

function isValidSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
