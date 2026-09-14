import { describe, expect, test } from "bun:test";
import {
  TOP_NAV_ITEMS,
  TOP_NAV_VIEW_LABELS,
  topNavBreadcrumbForRoute,
  topNavItems,
  topNavKeyForRoute,
} from "./topNavConfig.ts";

describe("top nav config", () => {
  test("is a flat single row: Home · Chat · Agents · Terminals · Broker · Search · Ops", () => {
    expect(topNavItems()).toBe(TOP_NAV_ITEMS);
    expect(TOP_NAV_ITEMS.map((item) => item.key)).toEqual([
      "home",
      "chat",
      "agents",
      "terminals",
      "broker",
      "search",
      "ops",
    ]);
    expect(TOP_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Home",
      "Chat",
      "Agents",
      "Terminals",
      "Broker",
      "Search",
      "Ops",
    ]);
    expect(TOP_NAV_ITEMS.map((item) => item.route)).toEqual([
      { view: "inbox" },
      { view: "messages" },
      { view: "agents-v2" },
      { view: "terminal" },
      { view: "broker" },
      { view: "search" },
      { view: "ops" },
    ]);
  });

  test("maps work surfaces to their own tabs", () => {
    expect(topNavKeyForRoute({ view: "inbox" })).toBe("home");
    expect(topNavKeyForRoute({ view: "activity" })).toBe("home");
    expect(topNavKeyForRoute({ view: "briefings" })).toBe("home");
    expect(topNavKeyForRoute({ view: "agents-v2" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "agent-info", conversationId: "c1" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "repos" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "repo-diff", path: "/tmp/x" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "code" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "settings", section: "agents" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "conversation", conversationId: "c1" })).toBe("chat");
    expect(topNavKeyForRoute({ view: "messages" })).toBe("chat");
    // A channel is a conversation on the unified route, so it lands on chat too.
    expect(topNavKeyForRoute({ view: "messages", conversationId: "chan-1" })).toBe("chat");
  });

  test("terminals tab owns terminal and session-transcript surfaces", () => {
    expect(topNavKeyForRoute({ view: "terminal" })).toBe("terminals");
    expect(topNavKeyForRoute({ view: "sessions" })).toBe("terminals");
  });

  test("broker tab owns dispatch/work/follow surfaces", () => {
    expect(topNavKeyForRoute({ view: "broker" })).toBe("broker");
    expect(topNavKeyForRoute({ view: "work", workId: "w1" })).toBe("broker");
    expect(topNavKeyForRoute({ view: "follow" })).toBe("broker");
  });

  test("search and ops are first-class tabs", () => {
    expect(topNavKeyForRoute({ view: "search" })).toBe("search");
    expect(topNavKeyForRoute({ view: "ops" })).toBe("ops");
    expect(topNavKeyForRoute({ view: "ops", mode: "tail" })).toBe("ops");
    expect(topNavKeyForRoute({ view: "ops", mode: "lanes" })).toBe("ops");
    expect(topNavKeyForRoute({ view: "ops", mode: "world" })).toBe("ops");
    expect(topNavKeyForRoute({ view: "harnesses" })).toBe("ops");
    expect(topNavKeyForRoute({ view: "mesh" })).toBe("ops");
    expect(topNavKeyForRoute({ view: "mesh-ops" })).toBe("ops");
  });

  test("settings/voice sit outside the tab row — no false highlight", () => {
    expect(topNavKeyForRoute({ view: "settings" })).toBe("system");
    expect(topNavKeyForRoute({ view: "voice" })).toBe("system");
    expect(TOP_NAV_ITEMS.some((item) => (item.key as string) === "system")).toBe(false);
  });

  test("breadcrumb skips top tabs, labels detail surfaces", () => {
    expect(topNavBreadcrumbForRoute({ view: "sessions" })).toBeNull();
    expect(topNavBreadcrumbForRoute({ view: "inbox" })).toBeNull();
    expect(topNavBreadcrumbForRoute({ view: "broker" })).toBeNull();
    expect(topNavBreadcrumbForRoute({ view: "conversation", conversationId: "c1" })).toBe("Conversation");
    expect(topNavBreadcrumbForRoute({ view: "settings", section: "agents" })).toBe("Configuration");
    expect(TOP_NAV_VIEW_LABELS.ops).toBe("Ops");
    expect(TOP_NAV_VIEW_LABELS.broker).toBe("Broker");
  });
});
