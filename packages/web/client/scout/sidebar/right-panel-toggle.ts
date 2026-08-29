import { nextLanesContextToggle } from "./empty-context-collapse.ts";

export type RightPanelToggleState = {
  available: boolean;
  terminalFocusActive: boolean;
  lanesContextRoute: boolean;
  lanesContextEmpty: boolean;
  lanesContextForceOpen: boolean;
  rightCollapsed: boolean;
};

export type RightPanelToggleResult = {
  terminalFocusActive: boolean;
  lanesContextForceOpen: boolean;
  rightCollapsed: boolean;
};

/** One state transition shared by chrome buttons, shortcuts, and commands. */
export function nextRightPanelToggle(
  state: RightPanelToggleState,
): RightPanelToggleResult | null {
  if (!state.available) return null;
  if (state.terminalFocusActive) {
    return {
      terminalFocusActive: false,
      lanesContextForceOpen: state.lanesContextForceOpen,
      rightCollapsed: false,
    };
  }
  if (state.lanesContextRoute) {
    const next = nextLanesContextToggle({
      empty: state.lanesContextEmpty,
      forceOpen: state.lanesContextForceOpen,
      rightCollapsed: state.rightCollapsed,
    });
    return {
      terminalFocusActive: false,
      lanesContextForceOpen: next.forceOpen,
      rightCollapsed: next.rightCollapsed,
    };
  }
  return {
    terminalFocusActive: false,
    lanesContextForceOpen: state.lanesContextForceOpen,
    rightCollapsed: !state.rightCollapsed,
  };
}
