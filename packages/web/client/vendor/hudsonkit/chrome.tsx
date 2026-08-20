import type * as ReactModule from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { StatusColor } from "./index.tsx";

// Keep Bun's runtime resolver away from this repo's React -> .d.ts tsconfig path.
// @ts-expect-error -- untyped relative .js import, cast back to React's public type.
const React = (await import("../../../node_modules/react/index.js")) as typeof ReactModule;
const { createElement } = React;

export function Frame({
  children,
  hud,
}: {
  children: ReactNode;
  hud?: ReactNode;
  mode?: string;
  panOffset?: { x: number; y: number };
  scale?: number;
  onPan?: (delta: { x: number; y: number }) => void;
  onZoom?: (scale: number) => void;
}) {
  return createElement("div", { "data-hudson-frame": "" }, children, hud);
}

export function SidePanel({
  children,
  footer,
  headerActions,
  style,
}: {
  children: ReactNode;
  side: "left" | "right";
  title?: string;
  icon?: ReactNode;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  width?: number;
  onResizeStart?: (event: MouseEvent) => void;
  /** Pass-through chrome hint: panel floats over content instead of pushing it. */
  floating?: boolean;
  style?: CSSProperties;
  footer?: ReactNode;
  headerActions?: ReactNode;
}) {
  return createElement("aside", { "data-hudson-side-panel": "", style }, headerActions, children, footer);
}

export function StatusBar({
  left,
  right,
}: {
  status?: { label: string; color: StatusColor };
  left?: ReactNode;
  right?: ReactNode;
  onToggleTerminal?: () => void;
  isTerminalOpen?: boolean;
}) {
  return createElement("div", { "data-hudson-status-bar": "" }, left, right);
}

export function CommandDock(_props: { onOpenCommandPalette?: () => void }) {
  return null;
}
