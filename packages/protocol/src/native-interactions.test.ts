import { describe, expect, test } from "bun:test";

import {
  nativeInteractionKindForName,
  scoutTargetsForNativeInteraction,
} from "./native-interactions";

describe("native interaction mappings", () => {
  test("maps common native tool names into Scout interaction kinds", () => {
    expect(nativeInteractionKindForName("ask_user")).toBe("question");
    expect(nativeInteractionKindForName("submit_plan")).toBe("plan_approval");
    expect(nativeInteractionKindForName("task_update")).toBe("task_projection");
    expect(nativeInteractionKindForName("tool_approval_required")).toBe("tool_approval");
    expect(nativeInteractionKindForName("unknown_tool")).toBeUndefined();
  });

  test("returns Scout targets for known native interaction kinds", () => {
    expect(scoutTargetsForNativeInteraction("question")).toEqual([
      "question",
      "session_projection",
    ]);
    expect(scoutTargetsForNativeInteraction("subagent_activity")).toContain("flight");
  });
});
