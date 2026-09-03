import { describe, expect, test } from "bun:test";

import {
  formatScoutSessionAddress,
  isScoutSessionHandle,
  parseScoutSessionAddress,
  type ScoutSessionHandle,
} from "./session-handle.js";

describe("Scout session handles", () => {
  const handle: ScoutSessionHandle = "sess.0123456789abcdefabcd";

  test("recognizes canonical opaque handles and addresses", () => {
    expect(isScoutSessionHandle(handle)).toBe(true);
    expect(formatScoutSessionAddress(handle)).toBe(`session:${handle}`);
    expect(parseScoutSessionAddress(`session:${handle}`)).toBe(handle);
    expect(parseScoutSessionAddress(handle)).toBe(handle);
  });

  test("does not mistake native ids or identity-bearing selectors for handles", () => {
    expect(parseScoutSessionAddress("session:codex:019fbee7-2a7f-7eb0-84bf-da22717c74d0")).toBeNull();
    expect(parseScoutSessionAddress("019fbee7-2a7f-7eb0-84bf-da22717c74d0")).toBeNull();
    expect(parseScoutSessionAddress("session:hudson.main.openscout")).toBeNull();
  });
});
