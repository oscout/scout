import { describe, expect, test } from "bun:test";

import {
  SCOUT_FLAG_BUNDLE_QUERY_KEYS,
  SCOUT_FLAG_GLOBAL_BUNDLE_QUERY_KEYS,
  SCOUT_FLAG_PERSIST_QUERY_KEYS,
  stripScoutFlagQueryParams,
} from "./scout-flag-query.ts";

describe("Scout dev flag query cleanup", () => {
  test("removes every flag query source while preserving route state", () => {
    const url = stripScoutFlagQueryParams(new URL(
      "https://scout.local/channels/chn-1?machineId=mini&ffBundle=max-pro&ff.surface.work=on&no-ops=1&filter=dm#message-2",
    ));

    expect(`${url.pathname}${url.search}${url.hash}`).toBe(
      "/channels/chn-1?machineId=mini&filter=dm#message-2",
    );
  });

  test("removes legacy aliases without touching similarly named application keys", () => {
    const exactKeys = [
      ...SCOUT_FLAG_BUNDLE_QUERY_KEYS,
      ...SCOUT_FLAG_GLOBAL_BUNDLE_QUERY_KEYS,
      ...SCOUT_FLAG_PERSIST_QUERY_KEYS,
      "ffAudience",
      "no-ops",
    ];

    for (const key of exactKeys) {
      const url = stripScoutFlagQueryParams(new URL(
        `https://scout.local/?${key}=on&ff.surface.work=on&ffCustom=keep`,
      ));

      expect(url.searchParams.get("ffCustom")).toBe("keep");
      expect([...url.searchParams.keys()]).toEqual(["ffCustom"]);
    }
  });
});
