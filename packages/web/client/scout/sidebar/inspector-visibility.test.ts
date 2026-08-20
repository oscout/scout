import { describe, expect, test } from "bun:test";
import type { Route } from "../../lib/types.ts";
import { routeHasMeaningfulInspector } from "./inspector-visibility.ts";

const noSelection = {
  hasBrokerAttempt: false,
  hasKnowledgeHit: false,
};

function visible(route: Route, selection = noSelection): boolean {
  return routeHasMeaningfulInspector(route, selection);
}

describe("context inspector visibility", () => {
  test("does not reserve a panel for routes without a right-pane surface", () => {
    const routes: Route[] = [
      { view: "activity" },
      { view: "briefings" },
      { view: "code" },
      { view: "follow" },
      { view: "harnesses" },
      { view: "inbox" },
      { view: "ops", mode: "lanes" },
      { view: "repo-diff", path: "/repo" },
      { view: "sessions", flightId: "flight-1" },
      { view: "settings", section: "appearance" },
      { view: "settings", section: "agents", agentId: "agent-1" },
      { view: "voice" },
    ];

    for (const route of routes) expect(visible(route)).toBe(false);
  });

  test("directory routes wait for a concrete selection", () => {
    expect(visible({ view: "agents-v2" })).toBe(false);
    expect(visible({ view: "agents-v2", selectedAgentId: "agent-1" })).toBe(true);
    expect(visible({ view: "agents-v2", sessionId: "session-1" })).toBe(true);
    expect(visible({ view: "agents-v2", agentId: "agent-1" })).toBe(true);

    expect(visible({ view: "messages" })).toBe(false);
    expect(visible({ view: "messages", conversationId: "chat-1" })).toBe(true);

    expect(visible({ view: "search", hitId: "hit-1" })).toBe(false);
    expect(visible(
      { view: "search", hitId: "hit-1" },
      { ...noSelection, hasKnowledgeHit: true },
    )).toBe(true);

    expect(visible({ view: "broker", attemptId: "attempt-1" })).toBe(false);
    expect(visible(
      { view: "broker", attemptId: "attempt-1" },
      { ...noSelection, hasBrokerAttempt: true },
    )).toBe(true);
  });

  test("keeps inspectors that carry route-level or directory summary context", () => {
    const routes: Route[] = [
      { view: "agent-info", conversationId: "chat-1" },
      { view: "conversation", conversationId: "chat-1" },
      { view: "mesh" },
      { view: "mesh-ops" },
      { view: "ops", mode: "mission" },
      { view: "repos" },
      { view: "sessions" },
      { view: "terminal" },
      { view: "work", workId: "work-1" },
    ];

    for (const route of routes) expect(visible(route)).toBe(true);
  });
});
