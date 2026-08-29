import { describe, expect, test } from "bun:test";

import {
  activeSessionRefLookupState,
  createSessionRefLookupCoordinator,
  type SessionRefLookupCompletion,
} from "./session-ref-lookup-state.ts";

describe("session-ref lookup state", () => {
  test("hides the prior writable lookup and ignores deferred A/B results after C wins", async () => {
    const requests = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
    const completions: Array<SessionRefLookupCompletion<string>> = [];
    const coordinator = createSessionRefLookupCoordinator(
      (sessionRef) => {
        const request = Promise.withResolvers<string>();
        requests.set(sessionRef, request);
        return request.promise;
      },
      (completion) => completions.push(completion),
    );

    const a = coordinator.request("session:codex:A");
    const b = coordinator.request("session:codex:B");
    const c = coordinator.request("session:codex:C");

    expect(activeSessionRefLookupState({
      sessionRef: "session:codex:A",
      lookup: "writable A",
      loading: false,
      error: null,
    }, "session:codex:C")).toEqual({
      sessionRef: "session:codex:C",
      lookup: null,
      loading: true,
      error: null,
    });

    requests.get("session:codex:C")!.resolve("writable C");
    await c;
    requests.get("session:codex:A")!.resolve("writable A");
    requests.get("session:codex:B")!.resolve("writable B");
    await Promise.all([a, b]);

    expect(completions).toEqual([{
      sessionRef: "session:codex:C",
      result: { ok: true, lookup: "writable C" },
    }]);
  });
});
