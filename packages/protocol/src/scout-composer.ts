import { parseAgentIdentity } from "./agent-identity.js";
import { AGENT_HARNESSES, type AgentHarness } from "./actors.js";
import type { ScoutRouteTarget } from "./scout-dispatch.js";

export const SCOUT_COMPOSER_ROUTE_OPERATOR = ">>" as const;
export const SCOUT_TARGET_HANDLE_SHORTHAND = "⌖" as const;

export type ScoutComposerRouteDiagnosticCode =
  | "missing_target"
  | "invalid_target";

export interface ScoutComposerRouteDiagnostic {
  code: ScoutComposerRouteDiagnosticCode;
  message: string;
  start: number;
  end: number;
}

export interface ScoutComposerRoute {
  operator: typeof SCOUT_COMPOSER_ROUTE_OPERATOR;
  token: string;
  target: ScoutRouteTarget;
  operatorStart: number;
  operatorEnd: number;
  targetStart: number;
  targetEnd: number;
}

export interface ScoutComposerRouteParseResult {
  route: ScoutComposerRoute | null;
  body: string;
  diagnostics: ScoutComposerRouteDiagnostic[];
}

const WHITESPACE_PATTERN = /\s/;
const TRAILING_TARGET_PUNCTUATION_PATTERN = /[.,!?;)\]}]+$/;
const ROUTE_VALUE_PATTERN = /^\S+$/;
const AGENT_LABEL_START_PATTERN = /^[A-Za-z0-9]/;
const SESSION_ROUTE_HARNESSES = new Set<AgentHarness>(AGENT_HARNESSES);

function findRouteOperator(input: string): { start: number; end: number } | null {
  let searchFrom = 0;

  while (searchFrom < input.length) {
    const index = input.indexOf(SCOUT_COMPOSER_ROUTE_OPERATOR, searchFrom);
    if (index === -1) {
      return null;
    }

    const previous = index > 0 ? input[index - 1] : "";
    if (index === 0 || WHITESPACE_PATTERN.test(previous)) {
      return {
        start: index,
        end: index + SCOUT_COMPOSER_ROUTE_OPERATOR.length,
      };
    }

    searchFrom = index + SCOUT_COMPOSER_ROUTE_OPERATOR.length;
  }

  return null;
}

function routeBodyWithoutTarget(input: string, start: number, end: number): string {
  return `${input.slice(0, start)} ${input.slice(end)}`.replace(/\s+/g, " ").trim();
}

function trimRouteTargetToken(value: string): string {
  return value
    .trim()
    .replace(TRAILING_TARGET_PUNCTUATION_PATTERN, "");
}

function isRouteValue(value: string): boolean {
  return value.length > 0 && ROUTE_VALUE_PATTERN.test(value);
}

function parseAgentLabelTarget(value: string): ScoutRouteTarget | null {
  const label = value.replace(/^@+/, "");
  if (!AGENT_LABEL_START_PATTERN.test(label)) {
    return null;
  }
  if (!parseAgentIdentity(label)) {
    return null;
  }
  return { kind: "agent_label", label, value };
}

function parseTargetHandleTarget(rawValue: string): ScoutRouteTarget | null {
  const handle = rawValue.replace(/^[@⌖]+/, "");
  if (!isRouteValue(handle)) {
    return null;
  }
  return { kind: "target_handle", handle, value: `target:${handle}` };
}

function parseRouteAliasTarget(rawValue: string): ScoutRouteTarget | null {
  const alias = rawValue.replace(/^@+/, "").trim().toLowerCase();
  if (!isRouteValue(alias)) return null;
  return { kind: "route_alias", alias, value: `alias:${alias}` };
}

function parseSessionRouteTarget(rawValue: string): ScoutRouteTarget | null {
  const value = rawValue.replace(/^@+/, "");
  if (!isRouteValue(value)) {
    return null;
  }

  const harnessSeparator = value.indexOf(":");
  if (harnessSeparator > 0) {
    const maybeHarness = value.slice(0, harnessSeparator) as AgentHarness;
    const sessionId = value.slice(harnessSeparator + 1);
    if (SESSION_ROUTE_HARNESSES.has(maybeHarness) && isRouteValue(sessionId)) {
      return {
        kind: "session_id",
        sessionId,
        harness: maybeHarness,
        value: `session:${maybeHarness}:${sessionId}`,
      };
    }
  }

  return { kind: "session_id", sessionId: value, value: `session:${value}` };
}

function parsePrefixedRouteTarget(prefix: string, rawValue: string): ScoutRouteTarget | null {
  const value = rawValue.replace(/^@+/, "");
  if (!isRouteValue(value)) {
    return null;
  }

  if (prefix === "agent" || prefix === "a") {
    return parseAgentLabelTarget(value);
  }
  if (prefix === "alias" || prefix === "route-alias" || prefix === "route_alias") {
    return parseRouteAliasTarget(rawValue);
  }
  if (prefix === "target" || prefix === "target-handle" || prefix === "target_handle") {
    return parseTargetHandleTarget(rawValue);
  }
  if (prefix === "ref" || prefix === "binding" || prefix === "binding-ref") {
    return { kind: "binding_ref", ref: value, value: `ref:${value}` };
  }
  if (prefix === "project" || prefix === "project-path" || prefix === "project_path") {
    return { kind: "project_path", projectPath: value, value: `project:${value}` };
  }
  if (prefix === "id" || prefix === "agent-id" || prefix === "agent_id") {
    return { kind: "agent_id", agentId: value, value: `id:${value}` };
  }
  if (prefix === "session" || prefix === "session-id" || prefix === "session_id" || prefix === "sid" || prefix === "s") {
    return parseSessionRouteTarget(rawValue);
  }
  if (prefix === "channel" || prefix === "chan" || prefix === "ch") {
    return { kind: "channel", channel: value, value: `channel:${value}` };
  }

  return null;
}

export function parseScoutComposerRouteTarget(value: string): ScoutRouteTarget | null {
  const token = trimRouteTargetToken(value);
  if (!isRouteValue(token)) {
    return null;
  }

  if (token === "broadcast") {
    return { kind: "broadcast", value: token };
  }

  if (token.startsWith(SCOUT_TARGET_HANDLE_SHORTHAND)) {
    return parseTargetHandleTarget(token);
  }

  const separatorIndex = token.indexOf(":");
  if (separatorIndex > 0) {
    const prefix = token.slice(0, separatorIndex).toLowerCase();
    const rawValue = token.slice(separatorIndex + 1);
    const prefixed = parsePrefixedRouteTarget(prefix, rawValue);
    if (prefixed) {
      return prefixed;
    }
  }

  return parseAgentLabelTarget(token);
}

export function parseScoutComposerRoute(input: string): ScoutComposerRouteParseResult {
  const operator = findRouteOperator(input);
  if (!operator) {
    return {
      route: null,
      body: input.trim(),
      diagnostics: [],
    };
  }

  let targetStart = operator.end;
  while (targetStart < input.length && WHITESPACE_PATTERN.test(input[targetStart] ?? "")) {
    targetStart += 1;
  }

  if (targetStart >= input.length) {
    return {
      route: null,
      body: routeBodyWithoutTarget(input, operator.start, operator.end),
      diagnostics: [{
        code: "missing_target",
        message: "route operator requires a target after >>",
        start: operator.start,
        end: operator.end,
      }],
    };
  }

  let targetEnd = targetStart;
  while (targetEnd < input.length && !WHITESPACE_PATTERN.test(input[targetEnd] ?? "")) {
    targetEnd += 1;
  }

  const rawToken = input.slice(targetStart, targetEnd);
  const token = trimRouteTargetToken(rawToken);
  const target = parseScoutComposerRouteTarget(token);
  if (!target) {
    return {
      route: null,
      body: routeBodyWithoutTarget(input, operator.start, targetEnd),
      diagnostics: [{
        code: "invalid_target",
        message: `invalid route target: ${rawToken}`,
        start: targetStart,
        end: targetEnd,
      }],
    };
  }

  return {
    route: {
      operator: SCOUT_COMPOSER_ROUTE_OPERATOR,
      token,
      target,
      operatorStart: operator.start,
      operatorEnd: operator.end,
      targetStart,
      targetEnd,
    },
    body: routeBodyWithoutTarget(input, operator.start, targetEnd),
    diagnostics: [],
  };
}
