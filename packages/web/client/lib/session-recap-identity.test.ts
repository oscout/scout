import { describe, expect, test } from "bun:test";

import { recapTargetsFromLanes, type RecapLaneInput } from "./session-recap-identity.ts";

function lane(overrides: {
  id: string;
  name?: string;
  handle?: string | null;
  harnessSessionId?: string;
}): RecapLaneInput {
  const sessionRef = overrides.harnessSessionId ?? "session-ms857tz2-9aybmi";
  return {
    id: overrides.id,
    source: "scout",
    lastActiveAt: 10,
    agent: {
      id: overrides.id,
      name: overrides.name ?? overrides.id,
      handle: overrides.handle ?? null,
      harness: "claude",
      harnessSessionId: sessionRef,
      homeNodeId: "arts-mini",
      state: "working",
    },
    observe: {
      metadata: {
        session: {
          adapterType: "claude",
          externalSessionId: sessionRef,
        },
      },
    },
  };
}

describe("recapTargetsFromLanes", () => {
  test("duplicate cards sharing one native session yield one recap without four friendly names", () => {
    const shared = "session-ms857tz2-9aybmi";
    const targets = recapTargetsFromLanes([
      lane({ id: "devon-1-openscout", name: "Devon 1", handle: "devon-1", harnessSessionId: shared }),
      lane({ id: "devon-2-openscout", name: "Devon 2", handle: "devon-2", harnessSessionId: shared }),
      lane({ id: "devon-3-openscout", name: "Devon 3", handle: "devon-3", harnessSessionId: shared }),
      lane({ id: "devon-4-openscout", name: "Devon 4", handle: "devon-4", harnessSessionId: shared }),
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.identityVerified).toBe(false);
    expect(targets[0]!.displayLabel).toBe("claude · ms857tz2");
    expect(targets[0]!.displayLabel.toLowerCase()).not.toContain("devon");
  });

  test("an unambiguous scout binding may use the friendly card label", () => {
    const targets = recapTargetsFromLanes([
      lane({ id: "opus.main", name: "Opus", handle: "opus", harnessSessionId: "sess-opus" }),
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.identityVerified).toBe(true);
    expect(targets[0]!.displayLabel).toBe("opus");
    expect(targets[0]!.voiceKey).toBe("opus.main");
  });
});
