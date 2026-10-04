import { describe, expect, mock, test } from "bun:test";
import type * as ReactModule from "react";

// @ts-expect-error -- see router.test.ts: the relative path keeps bun on the real react module.
const React = (await import("../../node_modules/react/index.js")) as typeof ReactModule;

mock.module("react", () => React);

const {
  BASIC_EMBED_PATHS,
  isBasicEmbedPath,
  isEmbedPath,
  basicArea,
  basicDmConversations,
  basicRoute,
  findBasicDm,
  findBasicDmForAgent,
  isBasicDm,
  isBasicDmUnread,
} = await import("./profile.ts");
const { basicCanonicalHref, routePath } = await import("../lib/router.ts");
import type { Route, SessionEntry } from "../lib/types.ts";

function session(overrides: Partial<SessionEntry> & { id: string }): SessionEntry {
  return {
    kind: "direct",
    title: overrides.id,
    participantIds: ["operator", "agent-a"],
    agentId: "agent-a",
    ...overrides,
  } as SessionEntry;
}

describe("basic route policy", () => {
  test("Home, DMs and Tail keep their own state", () => {
    expect(basicRoute({ view: "inbox" })).toEqual({ view: "inbox" });
    expect(basicRoute({ view: "broker", filter: "failed", attemptId: "att-1" } as Route)).toEqual({
      view: "broker",
      filter: "failed",
      attemptId: "att-1",
    });
    expect(basicRoute({ view: "broker", filter: "all" } as Route)).toEqual({ view: "broker" });
    expect(basicRoute({ view: "conversation", conversationId: "dm-1", composeDraft: "hi" })).toEqual({
      view: "conversation",
      conversationId: "dm-1",
      composeDraft: "hi",
    });
    expect(basicRoute({ view: "ops", mode: "tail", tailQuery: "abc" })).toEqual({
      view: "ops",
      mode: "tail",
      tailQuery: "abc",
    });
  });

  test("agent routes open that agent's DM", () => {
    expect(basicRoute({ view: "agents-v2", agentId: "agent-a" } as Route)).toEqual({
      view: "messages",
      agentId: "agent-a",
    });
    expect(basicRoute({ view: "terminal", agentId: "agent-a" } as Route)).toEqual({
      view: "messages",
      agentId: "agent-a",
    });
    expect(basicRoute({ view: "messages", conversationId: "dm-1" })).toEqual({
      view: "conversation",
      conversationId: "dm-1",
    });
  });

  test("observed-session agents have no DM and open in Tail", () => {
    const route = basicRoute({ view: "agents-v2", agentId: "native:claude:1234" } as Route);
    expect(route.view).toBe("ops");
    expect(route).toMatchObject({ mode: "tail" });
  });

  test("sessions open a filtered Tail", () => {
    expect(basicRoute({ view: "sessions", sessionId: "sess-1" } as Route)).toEqual({
      view: "ops",
      mode: "tail",
      tailQuery: "sess-1",
    });
  });

  test("full-app-only surfaces fall back to Home", () => {
    for (const route of [
      { view: "ops", mode: "advisor" },
      { view: "ops", mode: "issues" },
      { view: "search" },
      { view: "mesh" },
      { view: "briefings" },
    ] as Route[]) {
      expect(basicRoute(route)).toEqual({ view: "inbox" });
    }
  });

  test("Settings is carried, so Solo Pro and Operator are reachable from the browser", () => {
    expect(basicRoute({ view: "settings" })).toEqual({ view: "settings" });
    expect(basicRoute({ view: "settings", section: "pro" })).toEqual({ view: "settings", section: "pro" });
    expect(basicRoute({ view: "settings", section: "operator" })).toEqual({ view: "settings", section: "operator" });
    expect(basicArea({ view: "settings", section: "pro" })).toBe("settings");
  });

  test("full-app settings screens fold onto what basic has", () => {
    expect(basicRoute({ view: "settings", section: "pairing" })).toEqual({ view: "settings", section: "devices" });
    expect(basicRoute({ view: "settings", section: "agents" })).toEqual({ view: "settings" });
    expect(basicRoute({ view: "settings", section: "agents", agentId: "agent-a" })).toEqual({
      view: "messages",
      agentId: "agent-a",
    });
  });

  test("areas map to the nav destinations", () => {
    expect(basicArea({ view: "inbox" })).toBe("home");
    expect(basicArea({ view: "broker" } as Route)).toBe("home");
    expect(basicArea({ view: "messages" })).toBe("dms");
    expect(basicArea({ view: "conversation", conversationId: "x" })).toBe("dms");
    expect(basicArea({ view: "ops", mode: "tail" })).toBe("tail");
  });

  test("canonical hrefs rewrite excluded paths and keep basic ones", () => {
    expect(basicCanonicalHref("/", "", "")).toBeNull();
    expect(basicCanonicalHref(routePath({ view: "ops", mode: "tail" }), "", "")).toBeNull();
    expect(basicCanonicalHref(routePath({ view: "broker", filter: "failed" } as Route), "", "")).toBeNull();
    expect(basicCanonicalHref(routePath({ view: "ops", mode: "advisor" }), "", "")).toBe("/");
    expect(basicCanonicalHref(routePath({ view: "search" }), "", "x")).toBe("/#x");
    expect(basicCanonicalHref(routePath({ view: "messages", conversationId: "dm-1" }), "", "")).toBe(
      routePath({ view: "conversation", conversationId: "dm-1" }),
    );
  });
});

describe("basic DM restriction", () => {
  const dm = session({ id: "dm-1", lastMessageAt: 100 });
  const channel = session({ id: "chan-1", kind: "channel", participantIds: ["operator", "agent-a", "agent-b"] });
  const groupDm = session({ id: "grp-1", kind: "group_direct", participantIds: ["operator", "agent-a", "agent-b"] });
  const observed = session({ id: "obs-1", participantIds: ["agent-a", "agent-b"] });

  test("only operator ↔ one-agent directs qualify", () => {
    expect(isBasicDm(dm)).toBe(true);
    expect(isBasicDm(channel)).toBe(false);
    expect(isBasicDm(groupDm)).toBe(false);
    expect(isBasicDm(observed)).toBe(false);
    expect(basicDmConversations([dm, channel, groupDm, observed]).map((s) => s.id)).toEqual(["dm-1"]);
  });

  test("coalesced conversation ids resolve to the canonical DM", () => {
    const coalesced = session({ id: "dm-2", equivalentConversationIds: ["dm-old"] });
    expect(findBasicDm([coalesced], "dm-old")?.id).toBe("dm-2");
    expect(findBasicDm([coalesced], "dm-2")?.id).toBe("dm-2");
    expect(findBasicDm([channel], "chan-1")).toBeNull();
  });

  test("an agent's newest DM wins", () => {
    const older = session({ id: "dm-old", lastMessageAt: 10 });
    const newer = session({ id: "dm-new", lastMessageAt: 20 });
    expect(findBasicDmForAgent([older, newer, channel], "agent-a")?.id).toBe("dm-new");
    expect(findBasicDmForAgent([older], "agent-z")).toBeNull();
  });

  test("unread counts from the last open, or the first-visit baseline", () => {
    const now = 1_800_000_000_000;
    const recent = { id: "dm-1", lastMessageAt: now };
    expect(isBasicDmUnread(recent, {}, now - 1)).toBe(true);
    expect(isBasicDmUnread(recent, {}, now + 1)).toBe(false);
    expect(isBasicDmUnread(recent, { "dm-1": now }, 0)).toBe(false);
    expect(isBasicDmUnread({ id: "dm-1", lastMessageAt: null }, {}, 0)).toBe(false);
  });
});

describe("basic embeds", () => {
  test("carries the Mac panes basic has a screen for", () => {
    expect([...BASIC_EMBED_PATHS].sort()).toEqual(["/embed/home", "/embed/session", "/embed/settings", "/embed/thread"]);
  });

  test("every native embed path is an embed, carried or not", () => {
    for (const path of ["/embed/settings", "/embed/terminal", "/embed/observe/agent-1", "/ops/lanes/embed"]) {
      expect(isEmbedPath(path)).toBe(true);
    }
    expect(isEmbedPath("/settings")).toBe(false);
    expect(isEmbedPath("/c/abc")).toBe(false);
  });

  test("full-app embeds are not carried", () => {
    for (const path of ["/embed/ops", "/embed/terminal", "/embed/code", "/embed/voice", "/ops/lanes/embed"]) {
      expect(isBasicEmbedPath(path)).toBe(false);
    }
  });
});
