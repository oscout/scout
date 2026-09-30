

export const TMUX_PEEK_DEFAULT_LINES = 44;

export const TMUX_PEEK_MIN_LINES = 10;

export const TMUX_PEEK_MAX_LINES = 80;

export const TMUX_PEEK_DEFAULT_COLUMNS = 132;

export const TMUX_PEEK_MIN_COLUMNS = 60;

export const TMUX_PEEK_MAX_COLUMNS = 200;

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function parseTmuxPeekLineCount(value: string | undefined): number {
  return parseBoundedInteger(
    value,
    TMUX_PEEK_DEFAULT_LINES,
    TMUX_PEEK_MIN_LINES,
    TMUX_PEEK_MAX_LINES,
  );
}

export function parseTmuxPeekColumnCount(value: string | undefined): number {
  return parseBoundedInteger(
    value,
    TMUX_PEEK_DEFAULT_COLUMNS,
    TMUX_PEEK_MIN_COLUMNS,
    TMUX_PEEK_MAX_COLUMNS,
  );
}

export function stripTerminalControlSequences(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function normalizeTmuxPeekLine(line: string, columns: number): string {
  const chars = Array.from(line);
  const clipped = chars.length > columns ? chars.slice(0, columns).join("") : line;
  const clippedLength = Array.from(clipped).length;
  return `${clipped}${" ".repeat(Math.max(0, columns - clippedLength))}`;
}

export function normalizeTmuxPeekBody(body: string, lines: number, columns: number): {
  body: string;
  lineCount: number;
  columnCount: number;
  truncated: boolean;
} {
  const cleaned = stripTerminalControlSequences(body)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const split = cleaned.endsWith("\n") ? cleaned.slice(0, -1).split("\n") : cleaned.split("\n");
  const sourceRows = split.length === 1 && split[0] === "" ? [] : split;
  const visible = sourceRows.length > lines ? sourceRows.slice(-lines) : sourceRows;
  const rows = [...visible];
  while (rows.length < lines) {
    rows.unshift("");
  }
  return {
    body: rows.map((line) => normalizeTmuxPeekLine(line, columns)).join("\n"),
    lineCount: rows.length,
    columnCount: columns,
    truncated: sourceRows.length > lines,
  };
}
