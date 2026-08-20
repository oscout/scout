import {
  projectGoShortcuts,
  type GoShortcut,
} from "../scout/nav-destinations.ts";

export type { GoShortcut };

export const GO_SHORTCUTS: readonly GoShortcut[] = projectGoShortcuts();

export function goShortcutForKey(key: string): GoShortcut | null {
  const normalized = key.toLowerCase();
  return GO_SHORTCUTS.find((shortcut) => shortcut.key === normalized) ?? null;
}
