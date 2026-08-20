export type SemanticEventKind =
  | "agent_response"
  | "approval"
  | "artifact"
  | "command"
  | "error"
  | "file_edit"
  | "file_read"
  | "file_write"
  | "metadata"
  | "prompt"
  | "question"
  | "reasoning"
  | "review"
  | "session"
  | "subagent"
  | "tool_call"
  | "tool_result"
  | "turn"
  | "usage"
  | "web"
  | "unknown";

export interface EventInventoryContext {
  filePath: string;
  lineNumber: number;
}

export interface AdapterEventExtraction {
  sourceKind: string;
  rawType: string;
  rawSubtype?: string;
  semanticType: SemanticEventKind;
  detail?: string;
}

export interface EventInventoryAdapter {
  id: string;
  label: string;
  defaultRoots(home: string): string[];
  matchesFile(filePath: string): boolean;
  extract(record: Record<string, unknown>, context: EventInventoryContext): AdapterEventExtraction[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function lower(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

export function extraction(
  sourceKind: string,
  rawType: string | undefined,
  semanticType: SemanticEventKind,
  options: {
    detail?: string | undefined;
    rawSubtype?: string | undefined;
  } = {},
): AdapterEventExtraction {
  return {
    sourceKind,
    rawType: rawType && rawType.trim().length > 0 ? rawType.trim() : "unknown",
    semanticType,
    ...(options.rawSubtype ? { rawSubtype: options.rawSubtype } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
  };
}

export function semanticForToolName(toolName: string | undefined): SemanticEventKind {
  const name = lower(toolName);
  if (!name) return "tool_call";
  if (
    name === "bash"
    || name === "shell"
    || name === "exec"
    || name === "exec_command"
    || name === "write_stdin"
    || name === "js"
    || name.includes("command")
    || name.includes("repl")
    || name.includes("terminal")
  ) {
    return "command";
  }
  if (
    name === "read"
    || name === "glob"
    || name === "grep"
    || name === "ls"
    || name.includes("read_file")
    || name.includes("read-text-file")
    || name.includes("view_image")
  ) {
    return "file_read";
  }
  if (
    name === "write"
    || name.includes("write_file")
    || name.includes("write-text-file")
  ) {
    return "file_write";
  }
  if (
    name === "edit"
    || name === "multiedit"
    || name === "notebookedit"
    || name === "apply_patch"
    || name.includes("filechange")
    || name.includes("file_change")
    || name.includes("patch")
  ) {
    return "file_edit";
  }
  if (name === "task" || name.includes("subagent") || name.includes("agent")) {
    return "subagent";
  }
  if (name === "askuserquestion" || name.includes("request_user_input") || name.includes("question")) {
    return "question";
  }
  if (name.includes("web") || name.includes("search") || name.includes("fetch")) {
    return "web";
  }
  if (name.includes("review")) {
    return "review";
  }
  return "tool_call";
}
