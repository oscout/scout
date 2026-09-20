import { expect, test } from "bun:test";
import { fleetRecapCommands } from "./fleet-recap-commands.ts";

test("palette selection executes once while its search input still owns focus", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { activeElement: { tagName: "INPUT", role: "combobox" } } as unknown as Document;
  try {
    const calls: string[] = [];
    const commands = fleetRecapCommands({
      toggleFleetRollCall: () => calls.push("roll-call"),
      speakLatestVisibleTurn: () => calls.push("latest"),
      stopSessionRecaps: () => calls.push("stop"),
    });
    expect(calls).toEqual([]);
    // These expose no ambient shortcut: typing alone cannot invoke an action.
    for (const command of commands) expect(command.shortcut).toBeUndefined();
    commands.find((command) => command.id === "fleet:roll-call")!.action();
    commands.find((command) => command.id === "fleet:speak-latest")!.action();
    expect(calls).toEqual(["roll-call", "latest"]);
  } finally {
    globalThis.document = previousDocument;
  }
});
