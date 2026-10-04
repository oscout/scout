import { describe, expect, test } from "bun:test";

import { RESERVED_CHAT_PATHS } from "../../../../apps/hosted-chat/src/paths.ts";
import { checkSpaceName, claimFromSearch, claimReturnTo, RESERVED_SPACE_NAMES } from "./hosted-chat-claim.ts";

describe("space name claims", () => {
  test("the client's reserved names are the Worker's", () => {
    expect([...RESERVED_SPACE_NAMES].sort()).toEqual([...RESERVED_CHAT_PATHS].sort());
  });

  test("typed names fold to the slug they become", () => {
    expect(checkSpaceName("  Release Train ")).toEqual({ ok: true, slug: "release-train" });
    expect(checkSpaceName("atlas_ops")).toEqual({ ok: true, slug: "atlas-ops" });
  });

  test("names the Worker would refuse are refused here first", () => {
    expect(checkSpaceName("")).toEqual({ ok: false, reason: "empty" });
    expect(checkSpaceName("ab")).toEqual({ ok: false, reason: "short" });
    expect(checkSpaceName("a".repeat(41))).toEqual({ ok: false, reason: "long" });
    expect(checkSpaceName("-atlas")).toEqual({ ok: false, reason: "shape" });
    expect(checkSpaceName("atlas!")).toEqual({ ok: false, reason: "shape" });
    expect(checkSpaceName("admin")).toEqual({ ok: false, reason: "reserved" });
  });

  test("the claim rides the return address and only a valid one comes back", () => {
    expect(claimReturnTo("atlas")).toBe("/?claim=atlas");
    expect(claimFromSearch("?claim=atlas")).toBe("atlas");
    expect(claimFromSearch("?claim=admin")).toBeNull();
    expect(claimFromSearch("?other=1")).toBeNull();
  });
});
