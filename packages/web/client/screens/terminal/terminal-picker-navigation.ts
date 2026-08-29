export const TERMINAL_PICKER_SOURCES = ["multiplexer", "agent", "session"] as const;

export type TerminalPickerSource = typeof TERMINAL_PICKER_SOURCES[number];

export function nextTerminalPickerSource(
  current: TerminalPickerSource,
  key: string,
): TerminalPickerSource | null {
  if (key === "Home") return TERMINAL_PICKER_SOURCES[0];
  if (key === "End") return TERMINAL_PICKER_SOURCES[TERMINAL_PICKER_SOURCES.length - 1];

  const direction = key === "ArrowRight" || key === "ArrowDown"
    ? 1
    : key === "ArrowLeft" || key === "ArrowUp"
      ? -1
      : 0;
  if (direction === 0) return null;

  const currentIndex = TERMINAL_PICKER_SOURCES.indexOf(current);
  const nextIndex = (
    currentIndex + direction + TERMINAL_PICKER_SOURCES.length
  ) % TERMINAL_PICKER_SOURCES.length;
  return TERMINAL_PICKER_SOURCES[nextIndex] ?? null;
}

export function terminalPickerTabId(source: TerminalPickerSource): string {
  return `terminal-picker-tab-${source}`;
}

export function terminalPickerPanelId(): string {
  return "terminal-picker-panel";
}
