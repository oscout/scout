import type { AgentLane } from "./agent-lanes-model.ts";
import type { AdventureStop } from "./agent-adventures-model.ts";
import { adventureCommandText, adventureIsValidationCommand, adventureShellCommands } from "./adventure-playback.ts";
import { buildLaneSessionStats } from "./agent-lane-detail.ts";

export type AdventureFileEvidence = { path: string; resolvedPath: string | null; observations: number; clue: string };
export type AdventureRunEvidence = { id: string; command: string; outcome: "passed" | "failed" | "unavailable"; clue: string };
export type AdventureEvidenceModel = { read: AdventureFileEvidence[]; changed: AdventureFileEvidence[]; runs: AdventureRunEvidence[] };
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !path.startsWith("/")) parts.push(part);
  }
  return `${path.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}
function isPath(value: string): boolean {
  return value.length < 1024 && !/[\n\r\0*?<>|;$`]/.test(value) && !value.startsWith("-") && /(?:\/|\.[a-zA-Z0-9]{1,12}$)/.test(value) && !/^\w+:\/\//.test(value);
}
function args(arg: string | undefined): { paths: string[]; command: string } {
  const value = arg?.trim() ?? "";
  try {
    const record = JSON.parse(value);
    if (record && typeof record === "object" && !Array.isArray(record)) {
      const paths = [record.path, record.file_path, record.filePath, record.filename].filter((path): path is string => typeof path === "string" && isPath(path));
      const command = record.cmd ?? record.command;
      return { paths, command: typeof command === "string" ? command : Array.isArray(command) ? command.filter((part: unknown) => typeof part === "string").join(" ") : "" };
    }
  } catch { /* Direct tool arguments are also observed. */ }
  return { paths: isPath(value) && !/\s/.test(value) ? [value] : [], command: value };
}
function shellPaths(command: string): { path: string; search: boolean }[] {
  const found: { path: string; search: boolean }[] = [];
  // Here-doc bodies are data, not executed shell commands.
  let delimiter = "";
  const source = command.split("\n").filter(line => {
    if (delimiter) { if (line.trim() === delimiter) delimiter = ""; return false; }
    const heredoc = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/.exec(line);
    if (heredoc) delimiter = heredoc[1];
    return true;
  }).join("\n");
  for (const [rawTool, ...tokens] of adventureShellCommands(source)) {
    const tool = rawTool.split("/").at(-1) ?? "";
    if (!["cat", "head", "tail", "sed", "rg", "grep"].includes(tool)) continue;
    if (tool === "sed" && tokens.some(token => /^-i|^--in-place/.test(token))) continue;
    const search = tool === "rg" || tool === "grep";
    let pattern = false, flags = true;
    const operands: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (flags && token === "--") { flags = false; continue; }
      if (flags && token.startsWith("-")) {
        if (token === "--files") { pattern = true; continue; }
        if (["-e", "--regexp", "-f", "--file"].includes(token)) { pattern = true; i++; continue; }
        if (/^-[ef].+/.test(token) || /^--(?:regexp|file)=/.test(token)) { pattern = true; continue; }
        if (["-n", "-c"].includes(token) && !search && tool !== "sed" || ["--max-count", "-m", "--glob", "-g", "--type", "-t", "--encoding", "--context", "-A", "-B", "-C", "--include", "--exclude", "--exclude-dir", "--iglob", "--max-depth"].includes(token)) i++;
        continue;
      }
      if ((search || tool === "sed") && !pattern) { pattern = true; continue; }
      if ([">", ">>", "<", "2>"].includes(token)) break;
      operands.push(token);
    }
    for (const path of operands) if (isPath(path) || search && /^[A-Za-z0-9_./-]+$/.test(path)) found.push({ path, search });
  }
  return found;
}

/** Evidence is scoped to visited stops, never the lane's all-time file rollup. */
export function adventureEvidence(stops: readonly AdventureStop[], index: number, lane: AgentLane): AdventureEvidenceModel {
  const read = new Map<string, AdventureFileEvidence>();
  const changed = new Map<string, AdventureFileEvidence>();
  const runs: AdventureRunEvidence[] = [];
  const seen = new Set<string>();
  const cwd = lane.facts?.cwd || buildLaneSessionStats(lane).cwd || "";
  const end = Number.isFinite(index) ? Math.min(Math.floor(index), stops.length - 1) : -1;
  for (const stop of stops.slice(0, Math.max(0, end + 1))) {
    if (seen.has(stop.event.id)) continue;
    seen.add(stop.event.id);
    const event = stop.event;
    if (event.kind !== "tool") continue;
    const parsed = args(event.arg);
    const tool = event.tool?.toLowerCase() ?? "";
    const command = adventureCommandText(stop);
    const shell = command !== null;
    const isChange = Boolean(event.diff) || /(?:edit|write|apply_patch|str_replace)/.test(tool);
    const isRead = /(?:read|search|find|view|open)/.test(tool);
    const paths = new Set<string>(!shell && (isRead || isChange) ? parsed.paths : []);
    if (isChange) for (const match of `${event.arg ?? ""}\n${event.diff?.preview ?? ""}`.matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File: |(?:\+\+\+|---) [ab]\/)(.+)$/gm)) {
      if (isPath(match[1])) paths.add(match[1]);
    }
    const searchScopes = new Set<string>();
    if (command) for (const operand of shellPaths(command)) {
      paths.add(operand.path);
      if (operand.search) searchScopes.add(operand.path);
    }
    const bucket = isChange ? changed : read;
    for (const path of paths) {
      const scope = searchScopes.has(path);
      const resolvedPath = scope ? null : path.startsWith("/") ? normalize(path) : cwd.startsWith("/") ? normalize(`${cwd}/${path}`) : null;
      const key = resolvedPath ?? normalize(path);
      const existing = bucket.get(key);
      if (existing) existing.observations++;
      else bucket.set(key, { path: normalize(path), resolvedPath, observations: 1, clue: scope ? "Search scope" : event.tool || stop.label });
    }
    if (command !== null && adventureIsValidationCommand(command)) {
      const result = event.result;
      const rawCode = result?.exit_code ?? result?.exitCode;
      const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" && /^-?\d+$/.test(rawCode) ? Number(rawCode) : undefined;
      const clue = event.text === "Command completed" ? `Observed command completion · ${Object.entries(result ?? {}).map(([key, value]) => `${key}: ${value}`).join(" · ") || "Exit unavailable"}` : result ? Object.entries(result).map(([key, value]) => `${key}: ${value}`).join(" · ") : event.stream?.join("\n") || "Result unavailable in these observations";
      // Tool output can contain arbitrary prose; only an explicit process exit establishes outcome.
      const exit = code;
      runs.push({ id: stop.id, command, outcome: exit === undefined ? "unavailable" : exit === 0 ? "passed" : "failed", clue });
    }
  }
  return { read: [...read.values()], changed: [...changed.values()], runs };
}
