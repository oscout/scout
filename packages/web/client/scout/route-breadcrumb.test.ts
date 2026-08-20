import { describe, expect, test } from "bun:test";
import { ROUTE_VIEW_LABELS, routeBreadcrumbForRoute } from "./route-breadcrumb.ts";

describe("route breadcrumbs (SCO-083)", () => {
  test("skips top-level primary destinations", () => {
    expect(routeBreadcrumbForRoute({ view: "inbox" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "agents-v2" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "sessions" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "messages" })).toBeNull();
    expect(routeBreadcrumbForRoute({ view: "search" })).toBeNull();
  });

  test("labels detail and ops surfaces", () => {
    expect(routeBreadcrumbForRoute({ view: "conversation", conversationId: "c1" })).toBe(
      "Conversation",
    );
    expect(routeBreadcrumbForRoute({ view: "broker" })).toBe("Dispatch");
    expect(routeBreadcrumbForRoute({ view: "settings", section: "agents" })).toBe(
      "Configuration",
    );
    expect(routeBreadcrumbForRoute({ view: "settings" })).toBe("Settings");
    expect(routeBreadcrumbForRoute({ view: "ops" })).toBe("Mission Control");
    expect(routeBreadcrumbForRoute({ view: "ops", mode: "tail" })).toBe("Live Activity");
    expect(routeBreadcrumbForRoute({ view: "ops", mode: "lanes" })).toBe("Agent Lanes");
    expect(routeBreadcrumbForRoute({ view: "code" })).toBe("Code Browser");
    expect(routeBreadcrumbForRoute({ view: "repo-diff", path: "/tmp/x" })).toBe("Diff");
  });

  test("exposes labels for all primary-area views", () => {
    for (const view of [
      "inbox",
      "activity",
      "briefings",
      "agents-v2",
      "agent-info",
      "repos",
      "repo-diff",
      "code",
      "sessions",
      "terminal",
      "messages",
      "conversation",
      "broker",
      "work",
      "follow",
      "search",
      "ops",
      "mesh",
      "harnesses",
      "settings",
    ] as const) {
      expect(ROUTE_VIEW_LABELS[view]).toBeTruthy();
    }
  });
});
