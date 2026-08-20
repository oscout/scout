/**
 * SCO-085 empty CONTEXT panel collapse policy (pure helpers for tests).
 *
 * Emptiness derives collapse on /ops/lanes, but expand adds a TEMPORARY
 * route-scoped open override — never flips stored rightCollapsed permanently.
 * Loading must not be treated as empty (avoids unmount deadlock while session
 * has not published yet).
 */

export type EmptyContextConversation = {
  messageCount: number;
  loading: boolean;
};

export function isLanesContextRoute(route: {
  view: string;
  mode?: string;
}): boolean {
  return route.view === "ops" && route.mode === "lanes";
}

export function isLanesContextEmpty(
  route: { view: string; mode?: string },
  conversation: EmptyContextConversation | null | undefined,
): boolean {
  if (!isLanesContextRoute(route)) return false;
  if (!conversation) return false;
  if (conversation.loading) return false;
  return conversation.messageCount === 0;
}

/**
 * Resolve whether the right CONTEXT panel should render collapsed.
 * When empty, forceOpen wins; otherwise fall back to stored preference + other
 * derived collapses (caller passes those as `baseCollapsed`).
 */
export function resolveLanesContextCollapsed(options: {
  empty: boolean;
  forceOpen: boolean;
  baseCollapsed: boolean;
}): boolean {
  if (options.empty) return !options.forceOpen;
  return options.baseCollapsed;
}

/**
 * Toggle transition for the empty-panel override.
 * Returns the next forceOpen / rightCollapsed pair without mutating inputs.
 *
 * SCO-086: expand-while-empty sets forceOpen only — never rewrites the stored
 * rightCollapsed preference (temporary open override).
 */
export function nextLanesContextToggle(options: {
  empty: boolean;
  forceOpen: boolean;
  rightCollapsed: boolean;
}): { forceOpen: boolean; rightCollapsed: boolean } {
  const collapsedNow = options.empty
    ? !options.forceOpen
    : options.rightCollapsed;
  if (collapsedNow) {
    return {
      forceOpen: true,
      // Temporary open while empty must preserve the stored pref.
      rightCollapsed: options.empty ? options.rightCollapsed : false,
    };
  }
  return {
    forceOpen: false,
    rightCollapsed: options.empty ? options.rightCollapsed : true,
  };
}
