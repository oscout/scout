import type * as ReactModule from "react";
import type { ReactNode } from "react";
import type { CommandOption } from "./index.tsx";

// Keep Bun's runtime resolver away from this repo's React -> .d.ts tsconfig path.
// @ts-expect-error -- untyped relative .js import, cast back to React's public type.
const React = (await import("../../../node_modules/react/index.js")) as typeof ReactModule;
const { createElement } = React;

export function CommandPalette({
  isOpen,
  commands,
}: {
  isOpen: boolean;
  onClose: () => void;
  commands: CommandOption[];
}) {
  if (!isOpen) return null;
  return createElement("div", { "data-hudson-command-palette": "" }, commands.length);
}

export function TerminalDrawer({
  isOpen,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  onToggleMaximize?: () => void;
  isMaximized?: boolean;
  height?: number;
  onHeightChange?: (height: number) => void;
  title?: ReactNode;
  children: ReactNode;
}) {
  if (!isOpen) return null;
  return createElement("div", { "data-hudson-terminal-drawer": "" }, children);
}
