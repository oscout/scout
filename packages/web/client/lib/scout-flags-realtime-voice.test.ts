import { describe, expect, test } from "bun:test";

import { SCOUT_REALTIME_VOICE_FLAG } from "../../shared/realtime-voice.ts";
import { scoutFlagBundleLayer, scoutFlags } from "./scout-flags.ts";

describe("realtime voice feature flag", () => {
  test("is registered and off by default", () => {
    expect(SCOUT_REALTIME_VOICE_FLAG).toBe("surface.realtime-voice");
    expect(scoutFlags[SCOUT_REALTIME_VOICE_FLAG]).toEqual(expect.objectContaining({
      defaultEnabled: false,
      tier: "everyone",
    }));
  });

  test("follows the explicit surface bundles", () => {
    expect(scoutFlagBundleLayer("light-prod").flags?.[SCOUT_REALTIME_VOICE_FLAG]).toBe(false);
    expect(scoutFlagBundleLayer("max-pro").flags?.[SCOUT_REALTIME_VOICE_FLAG]).toBe(true);
  });
});
