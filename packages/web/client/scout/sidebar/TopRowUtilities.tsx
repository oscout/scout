/**
 * @deprecated Top-row scope + ⌘K were removed — the title row stays quiet.
 * Machine scope remains available via MachineScopeControl elsewhere; command
 * palette stays on the ⌘K keyboard shortcut.
 *
 * Kept as an empty export so any lingering import fails softly during rollouts.
 */
export function TopRowUtilities(_props: { onOpenCommandPalette?: () => void }) {
  return null;
}
