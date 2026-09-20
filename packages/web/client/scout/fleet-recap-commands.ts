import type { CommandOption } from "@hudsonkit";

/** Explicit palette actions run before its focused search input is closed. */
export function fleetRecapCommands(actions: {
  toggleFleetRollCall: () => void;
  speakLatestVisibleTurn: () => void;
  stopSessionRecaps: () => void;
}): CommandOption[] {
  return [{
    id: "fleet:roll-call",
    label: "Fleet roll call",
    action: actions.toggleFleetRollCall,
  }, {
    id: "fleet:speak-latest",
    label: "Speak latest turn",
    action: actions.speakLatestVisibleTurn,
  }, {
    id: "fleet:stop-recaps",
    label: "Stop spoken summaries",
    action: actions.stopSessionRecaps,
  }];
}
