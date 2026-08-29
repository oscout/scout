import { describe, expect, test } from "bun:test";

import { SCOUT_REALTIME_VOICE_FLAG } from "../../shared/realtime-voice.ts";
import { scoutFlagBundleLayer, scoutFlags } from "./scout-flags.ts";

describe("realtime voice feature flag", () => {
  test("is registered as an on-by-default build kill switch", () => {
    expect(SCOUT_REALTIME_VOICE_FLAG).toBe("surface.realtime-voice");
    expect(scoutFlags[SCOUT_REALTIME_VOICE_FLAG]).toEqual(expect.objectContaining({
      defaultEnabled: true,
      tier: "everyone",
    }));
  });

  test("leaves everyday enablement to Settings instead of experience bundles", () => {
    expect(scoutFlagBundleLayer("light-prod").flags?.[SCOUT_REALTIME_VOICE_FLAG]).toBeUndefined();
    expect(scoutFlagBundleLayer("max-pro").flags?.[SCOUT_REALTIME_VOICE_FLAG]).toBeUndefined();
  });
});
