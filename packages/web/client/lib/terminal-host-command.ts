export const SCOUT_TERMINAL_SEND_LINE_EVENT = "scout:terminal-send-line";

export function terminalHostLineFromEvent(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object" || !("line" in detail)) return null;
  const line = (detail as { line?: unknown }).line;
  return typeof line === "string" && line.trim().length > 0 ? line : null;
}
