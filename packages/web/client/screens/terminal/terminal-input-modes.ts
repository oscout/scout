/**
 * The xterm instance behind hudsonkit's relay.
 *
 * hudsonkit types its `onReady` handover down to write/focus/clear/dispose,
 * but the object it passes is the real xterm Terminal. These are the members
 * Scout reads back off it — every one optional, so a hudsonkit or xterm change
 * degrades the affordance instead of throwing inside a menu handler.
 */
export type TerminalInputSurface = {
  focus?: () => void;
  getSelection?: () => string;
  paste?: (data: string) => void;
  modes?: { readonly mouseTrackingMode?: "none" | "x10" | "vt200" | "drag" | "any" };
};

/**
 * True while the program inside the terminal is reading the mouse itself —
 * herdr, vim, htop, lazygit. xterm has already reported the press to it, so a
 * Scout menu on top of the app's own menu is two menus for one click.
 */
export function terminalAppOwnsMouse(terminal: TerminalInputSurface | null): boolean {
  const mode = terminal?.modes?.mouseTrackingMode;
  return typeof mode === "string" && mode !== "none";
}
