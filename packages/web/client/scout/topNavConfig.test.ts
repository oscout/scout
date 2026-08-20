import { describe, expect, test } from "bun:test";
import {
  isSystemRoute,
  TOP_NAV_ITEMS,
  TOP_NAV_VIEW_LABELS,
  topNavBreadcrumbForRoute,
  topNavItems,
  topNavKeyForRoute,
} from "./topNavConfig.ts";

describe("top nav config", () => {
  test("is a single personality: Home · Projects · Sessions · Messages", () => {
    expect(topNavItems()).toBe(TOP_NAV_ITEMS);
    expect(TOP_NAV_ITEMS.map((item) => item.key)).toEqual(["home", "agents", "sessions", "chat"]);
    expect(TOP_NAV_ITEMS.map((item) => item.label)).toEqual(["Home", "Projects", "Sessions", "Messages"]);
    expect(TOP_NAV_ITEMS.map((item) => item.route)).toEqual([
      { view: "inbox" },
      { view: "agents-v2" },
      { view: "sessions" },
      { view: "messages" },
    ]);
  });

  test("maps work surfaces to their own tabs", () => {
    expect(topNavKeyForRoute({ view: "inbox" })).toBe("home");
    expect(topNavKeyForRoute({ view: "inbox" })).toBe("home");
    expect(topNavKeyForRoute({ view: "activity" })).toBe("home");
    expect(topNavKeyForRoute({ view: "briefings" })).toBe("home");
    expect(topNavKeyForRoute({ view: "agents-v2" })).toBe("agents");
        expect(topNavKeyForRoute({ view: "agent-info", conversationId: "c1" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "settings", section: "agents" })).toBe("agents");
    expect(topNavKeyForRoute({ view: "sessions" })).toBe("sessions");
    expect(topNavKeyForRoute({ view: "conversation", conversationId: "c1" })).toBe("chat");
        expect(topNavKeyForRoute({ view: "messages" })).toBe("chat");
    // A channel is a conversation on the unified route, so it lands on chat too.
    expect(topNavKeyForRoute({ view: "messages", conversationId: "chan-1" })).toBe("chat");
  });

  test("maps the ops/retrieval cluster to system — no fallback lies", () => {
    expect(topNavKeyForRoute({ view: "ops" })).toBe("system");
    expect(topNavKeyForRoute({ view: "ops", mode: "tail" })).toBe("system");
    expect(topNavKeyForRoute({ view: "ops", mode: "lanes" })).toBe("system");
    expect(topNavKeyForRoute({ view: "broker" })).toBe("system");
    expect(topNavKeyForRoute({ view: "repos" })).toBe("system");
    expect(topNavKeyForRoute({ view: "harnesses" })).toBe("system");
    expect(topNavKeyForRoute({ view: "mesh" })).toBe("system");
    expect(topNavKeyForRoute({ view: "terminal" })).toBe("system");
    expect(topNavKeyForRoute({ view: "search" })).toBe("system");
    expect(topNavKeyForRoute({ view: "code" })).toBe("system");
    expect(topNavKeyForRoute({ view: "work", workId: "w1" })).toBe("system");
    expect(topNavKeyForRoute({ view: "follow" })).toBe("system");
    expect(topNavKeyForRoute({ view: "settings" })).toBe("system");
  });

  test("isSystemRoute agrees with the system tab mapping", () => {
    expect(isSystemRoute({ view: "search" })).toBe(true);
    expect(isSystemRoute({ view: "ops", mode: "tail" })).toBe(true);
    expect(isSystemRoute({ view: "settings" })).toBe(true);
    expect(isSystemRoute({ view: "settings", section: "agents" })).toBe(false);
    expect(isSystemRoute({ view: "inbox" })).toBe(false);
    expect(isSystemRoute({ view: "sessions" })).toBe(false);
    expect(isSystemRoute({ view: "messages" })).toBe(false);
  });

  test("breadcrumb skips top tabs and labels ops as System", () => {
    expect(topNavBreadcrumbForRoute({ view: "sessions" })).toBeNull();
    expect(topNavBreadcrumbForRoute({ view: "inbox" })).toBeNull();
    expect(topNavBreadcrumbForRoute({ view: "conversation", conversationId: "c1" })).toBe("Conversation");
    expect(topNavBreadcrumbForRoute({ view: "broker" })).toBe("Dispatch");
    expect(topNavBreadcrumbForRoute({ view: "settings", section: "agents" })).toBe("Configuration");
    expect(TOP_NAV_VIEW_LABELS.ops).toBe("System");
  });
});
