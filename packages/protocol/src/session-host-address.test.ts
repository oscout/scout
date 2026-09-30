import { describe, expect, test } from "bun:test";

import { parseScoutComposerRouteTarget } from "./scout-composer.js";
import {
  formatScoutSessionHostAddress,
  normalizeScoutSessionHost,
  parseScoutSessionAddress,
  parseScoutSessionHostAddress,
  scoutNodeMatchesSessionHost,
  scoutSessionHostForNode,
  type ScoutSessionHandle,
} from "./session-handle.js";

const handle: ScoutSessionHandle = "sess.0123456789abcdefabcd";

describe("session host addresses (sess.<token>@<host>)", () => {
  test("parses bare and typed forms, normalizing the host", () => {
    expect(parseScoutSessionHostAddress(`${handle}@arts-mini`)).toEqual({ handle, host: "arts-mini" });
    expect(parseScoutSessionHostAddress(`session:${handle}@Arts-Mini.local`)).toEqual({ handle, host: "arts-mini" });
    expect(formatScoutSessionHostAddress({ handle, host: "Arts-Mini.local." })).toBe(`${handle}@arts-mini`);
  });

  test("rejects non-canonical local parts, empty or doubled hosts", () => {
    expect(parseScoutSessionHostAddress("0199-codex-thread@arts-mini")).toBeNull();
    expect(parseScoutSessionHostAddress(`${handle}@`)).toBeNull();
    expect(parseScoutSessionHostAddress(`${handle}@a@b`)).toBeNull();
    expect(parseScoutSessionHostAddress(handle)).toBeNull();
    // The plain canonical address grammar is unchanged and never takes a host.
    expect(parseScoutSessionAddress(`session:${handle}@arts-mini`)).toBeNull();
    expect(parseScoutSessionAddress(`session:${handle}`)).toBe(handle);
  });

  test("derives the host from the stable node qualifier, not the display name", () => {
    expect(scoutSessionHostForNode({ id: "arts-mini-openscout", meshId: "openscout", name: "arts-mini.local" })).toBe("arts-mini");
    expect(scoutSessionHostForNode({ id: "mini-local-openscout", meshId: "openscout", name: "mini" })).toBe("mini-local");
    expect(scoutSessionHostForNode({ id: "custom-node", meshId: "openscout", name: "Studio Lab.local" })).toBe("studio-lab");
    expect(normalizeScoutSessionHost(" Air.local. ")).toBe("air");
  });

  test("a host matches a node by derived label, id, name, or host name", () => {
    const node = { id: "mini-local-openscout", meshId: "openscout", name: "mini", hostName: "mini" };
    expect(scoutNodeMatchesSessionHost(node, "mini-local")).toBe(true);
    expect(scoutNodeMatchesSessionHost(node, "mini")).toBe(true);
    expect(scoutNodeMatchesSessionHost(node, "mini-local-openscout")).toBe(true);
    expect(scoutNodeMatchesSessionHost(node, "arts-mini")).toBe(false);
  });
});

describe("route target parsing for session addresses", () => {
  test("bare and typed addresses become host-scoped exact session targets", () => {
    const expected = {
      kind: "session_id",
      sessionId: handle,
      host: "arts-mini",
      value: `session:${handle}@arts-mini`,
    };
    expect(parseScoutComposerRouteTarget(`${handle}@arts-mini`)).toEqual(expected);
    expect(parseScoutComposerRouteTarget(`session:${handle}@arts-mini`)).toEqual(expected);
    expect(parseScoutComposerRouteTarget(`${handle}@arts-mini.`)).toEqual(expected);
  });

  test("existing selectors keep their meaning", () => {
    expect(parseScoutComposerRouteTarget(`session:${handle}`)).toEqual({
      kind: "session_id",
      sessionId: handle,
      value: `session:${handle}`,
    });
    // Legacy native ids are untouched, including an `@` inside them.
    expect(parseScoutComposerRouteTarget("session:codex:019a-thread")).toMatchObject({
      kind: "session_id",
      sessionId: "019a-thread",
      harness: "codex",
    });
    expect(parseScoutComposerRouteTarget("session:tmux@pane")).toEqual({
      kind: "session_id",
      sessionId: "tmux@pane",
      value: "session:tmux@pane",
    });
    expect(parseScoutComposerRouteTarget("alias:reviewer")).toMatchObject({ kind: "route_alias", alias: "reviewer" });
    expect(parseScoutComposerRouteTarget("@talkie.main.arts-mini")).toMatchObject({ kind: "agent_label" });
    // A bare canonical handle without a host is not reinterpreted.
    expect(parseScoutComposerRouteTarget(handle)?.kind).not.toBe("session_id");
    // Non-canonical `x@y` stays unparseable rather than becoming a session.
    expect(parseScoutComposerRouteTarget("someone@arts-mini")).toBeNull();
  });
});
