import type { AdventureStop } from "./agent-adventures-model.ts";

export type AdventurePlayback = { checkpoint: boolean; durationMs: number; label: string; routine: boolean };

const shellTools = /(?:^|[._])(?:bash|shell|terminal|exec|run|command|exec_command|shell_command|local_shell|container_exec)$/i;

/** A deliberately small static wrapper grammar. Never execute or interpret JS. */
function wrappedCommand(raw: string): string | null {
  const source = raw.trim();
  const wrapper = source.startsWith("text(")
    ? /^text\(\s*await\s+tools\.exec_command\(\s*\{([\s\S]*)\}\s*\)\s*\)\s*;?$/
    : /^await\s+tools\.exec_command\(\s*\{([\s\S]*)\}\s*\)\s*;?$/;
  const body = wrapper.exec(source)?.[1];
  if (body === undefined) return null;
  // Only literal object values are accepted; expressions, spreads, interpolation,
  // duplicate fields, comments and extra statements deliberately fail closed.
  const field = /\s*("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*(,|$)/gy;
  const values = new Map<string, unknown>();
  let cursor = 0;
  while (cursor < body.length) {
    field.lastIndex = cursor;
    const match = field.exec(body);
    if (!match) {
      if (body.slice(cursor).trim()) return null;
      break;
    }
    try {
      const key = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
      if (values.has(key)) return null;
      values.set(key, JSON.parse(match[2]));
    } catch { return null; }
    cursor = field.lastIndex;
  }
  const command = values.get("cmd") ?? values.get("command");
  return typeof command === "string" ? command : null;
}

/** Split top-level statements while leaving strings and nested calls intact. */
function wrapperCommands(raw: string): string | null {
  const statements: string[] = [];
  let start = 0, depth = 0, quote = "", escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if ("({[".includes(char)) depth++;
    if (")}]".includes(char)) depth--;
    if (depth < 0) return null;
    if (char === ";" && depth === 0) { statements.push(raw.slice(start, i + 1)); start = i + 1; }
  }
  if (depth !== 0 || quote) return null;
  statements.push(raw.slice(start));
  const extracted = statements.map(wrappedCommand).filter((command): command is string => command !== null);
  return extracted.length ? extracted.join("\n") : null;
}

export function adventureCommandText(stop: AdventureStop): string | null {
  if (stop.event.kind !== "tool") return null;
  for (const raw of [stop.event.detail, stop.event.arg]) {
    if (!raw?.trim()) continue;
    const wrapped = wrapperCommands(raw);
    if (wrapped !== null) return wrapped;
    if (!shellTools.test(stop.event.tool ?? "")) continue;
    try {
      const data = JSON.parse(raw);
      const command = data?.cmd ?? data?.command;
      if (typeof command === "string") return command;
      if (Array.isArray(command) && command.every(part => typeof part === "string")) return command.join(" ");
    } catch { /* Plain shell arguments are also an observed command source. */ }
    if (raw === stop.event.arg && !raw.trim().startsWith("{")) return raw;
  }
  return null;
}

/** Tokenize just enough shell syntax to avoid treating quoted prose as commands. */
export function adventureShellCommands(text: string): string[][] {
  const result: string[][] = [[]];
  let token = "", quote = "", escaped = false;
  const flush = () => { if (token) result[result.length - 1].push(token); token = ""; };
  for (const char of text) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else token += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";" || char === "&" || char === "|" || char === "\n") { flush(); if (result[result.length - 1].length) result.push([]); continue; }
    if (/\s/.test(char)) flush(); else token += char;
  }
  flush();
  return result.filter(parts => parts.length);
}

function validation(parts: string[]): boolean {
  const [program, ...args] = parts;
  const executable = program?.split("/").at(-1) ?? "";
  if (["pytest", "vitest", "jest", "mocha", "tsc"].includes(executable)) return true;
  if (["cargo", "go", "swift", "xcodebuild"].includes(executable)) return args.includes("test") || args.includes("check");
  if (/^python(?:3(?:\.\d+)?)?$/.test(executable)) return args[0] === "-m" && ["pytest", "unittest"].includes(args[1]);
  if (["bun", "npm", "pnpm", "yarn", "npx"].includes(executable)) {
    const meaningful = args.filter((arg, index) => !arg.startsWith("-") && !(index > 0 && ["--cwd", "--prefix", "-C", "--dir", "--filter"].includes(args[index - 1])));
    const script = meaningful[0] === "run" || meaningful[0] === "exec" ? meaningful[1] : meaningful[0];
    return /^(?:test|check|typecheck|lint|validate)(?::[\w-]+)?$/.test(script ?? "") || ["vitest", "jest", "tsc", "pytest"].includes(script);
  }
  return false;
}

export function adventureIsValidationCommand(command: string): boolean {
  return adventureShellCommands(command).some(validation);
}

function baseAdventurePlayback(stop: AdventureStop): AdventurePlayback {
  const result = stop.event.result;
  const exit = result?.exit_code ?? result?.exitCode;
  if (stop.event.kind === "tool" && (typeof exit === "number" || typeof exit === "string" && /^-?\d+$/.test(exit)) && Number(exit) !== 0) {
    return { checkpoint: true, durationMs: 3200, label: `Exit code ${exit}`, routine: false };
  }
  if (stop.kind === "stopped") return { checkpoint: true, durationMs: 2800, label: stop.label, routine: false };
  const parsed = adventureShellCommands(adventureCommandText(stop) ?? "");
  if (adventureIsValidationCommand(adventureCommandText(stop) ?? "")) return { checkpoint: true, durationMs: 2400, label: "Validation checkpoint", routine: false };
  if (stop.kind === "read" || parsed.length > 0 && parsed.every(parts => /^(?:rg|grep|cat|head|tail|sed|find|ls|pwd)$/.test(parts[0]?.split("/").at(-1) ?? ""))) {
    return { checkpoint: false, durationMs: 800, label: stop.label, routine: true };
  }
  return { checkpoint: stop.kind === "wait" || stop.kind === "end", durationMs: stop.kind === "wait" || stop.kind === "end" ? 1800 : 1000, label: stop.label, routine: false };
}

/** Use explicit tool duration only; adjacent event spacing is not execution time. */
export function adventurePlayback(stop: AdventureStop): AdventurePlayback {
  const base = baseAdventurePlayback(stop);
  if (stop.event.kind !== "tool") return base;
  const result = stop.event.result;
  const rawMs = result?.duration_ms ?? result?.durationMs;
  const rawSeconds = result?.wall_time_seconds;
  const raw = rawMs ?? rawSeconds;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return { ...base, durationMs: Math.max(1800, base.durationMs) };
  const milliseconds = rawMs !== undefined ? numeric : numeric * 1000;
  return { ...base, durationMs: Math.max(1800, Math.min(6000, 700 + milliseconds * .2)) };
}
