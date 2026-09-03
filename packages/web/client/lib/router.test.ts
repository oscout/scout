import { describe, expect, mock, test } from "bun:test";
import type * as ReactModule from "react";

// @ts-expect-error -- the relative .js path keeps bun's runtime resolution to the real react
// module; a bare "react" specifier would be hijacked by tsconfig `paths` to the .d.ts. The cast
// restores the proper types that the path import otherwise loses.
const React = (await import("../../node_modules/react/index.js")) as typeof ReactModule;

mock.module("react", () => React);

const {
  buildScopePath,
  preserveLocationSearch,
  SCOPE_PATH_PREFIX,
  SCOPE_ROUTE_SEGMENTS,
} = await import("../scope/paths.ts");
const { clearRouteMachineScope, canonicalHrefForRoute, routeFromUrl, routePath, setRouteMachineScope } = await import("./router.ts");
const { normalizeRoute } = await import("./synthetic-agent-routing.ts");
const { formatTerminalSurfaceId } = await import("@openscout/protocol");
const surfaceId = (backend: string, hostSession: string) => formatTerminalSurfaceId({ backend, hostSession });
const { resolveRoutedSessionId, resolveSelectedSessionId, sortSessionsByRecency } = await import("./session-catalog.ts");

describe("scope route parsing", () => {
  const origin = "http://127.0.0.1:43120";

  test("scope lanes routes map to ops lanes", () => {
    expect(routeFromUrl(`${origin}${SCOPE_PATH_PREFIX}`)).toEqual({
      view: "ops",
      mode: "lanes",
    });
    expect(routeFromUrl(`${origin}${buildScopePath(SCOPE_ROUTE_SEGMENTS.lanes)}`)).toEqual({
      view: "ops",
      mode: "lanes",
    });
  });

  test("legacy scout-prefixed routes still parse", () => {
    expect(routeFromUrl(`${origin}/scout/sessions/sess-legacy`)).toEqual({
      view: "sessions",
      sessionId: "sess-legacy",
    });
  });

  test("legacy scout-prefixed routes canonicalize to /scope/*", () => {
    expect(canonicalHrefForRoute("/scout/sessions/sess-legacy", "", "")).toBe(
      "/scope/sessions/sess-legacy",
    );
    expect(canonicalHrefForRoute("/scout", "", "")).toBe("/scope");
    expect(canonicalHrefForRoute("/scout/tail", "?q=codex", "")).toBe("/scope/tail?q=codex");
    // Already-canonical scope URLs are left alone.
    expect(canonicalHrefForRoute("/scope/sessions/sess-legacy", "", "")).toBeNull();
  });

  test("trailing slashes canonicalize without a redirect round-trip", () => {
    // The canonical router owns slash normalization (this used to ping-pong
    // against a second redirect in the retired router layer).
    expect(canonicalHrefForRoute("/projects/", "", "")).toBe("/projects");
    expect(canonicalHrefForRoute("/fleet/", "", "")).toBe("/");
    expect(canonicalHrefForRoute("/projects", "", "")).toBeNull();
  });

  test("scope tail and sessions routes round-trip", () => {
    const tailRoute = routeFromUrl(`${origin}${buildScopePath(SCOPE_ROUTE_SEGMENTS.tail, { tailQuery: "codex" })}`);
    expect(tailRoute).toEqual({
      view: "ops",
      mode: "tail",
      tailQuery: "codex",
    });

    expect(routeFromUrl(`${origin}${buildScopePath(SCOPE_ROUTE_SEGMENTS.sessions)}`)).toEqual({
      view: "sessions",
    });

    expect(routeFromUrl(`${origin}${buildScopePath(SCOPE_ROUTE_SEGMENTS.sessions, { sessionId: "sess-1" })}`)).toEqual({
      view: "sessions",
      sessionId: "sess-1",
    });
  });

  test("scope agents maps to the agents directory", () => {
    expect(routeFromUrl(`${origin}${buildScopePath(SCOPE_ROUTE_SEGMENTS.agents)}`)).toEqual({
      view: "agents-v2",
    });
  });

  test("preserveLocationSearch carries only whitelisted global params", () => {
    // Whitelisted feature-flag keys follow the navigation…
    expect(preserveLocationSearch("/scope", "?ffBundle=scope-instrument&no-ops"))
      .toBe("/scope?ffBundle=scope-instrument&no-ops=");
    expect(preserveLocationSearch("/scope/tail?q=codex", "?ffBundle=scope-instrument"))
      .toBe("/scope/tail?q=codex&ffBundle=scope-instrument");
    expect(preserveLocationSearch("/mesh", "?ff.ops.control=off&ffAudience=power"))
      .toBe("/mesh?ff.ops.control=off&ffAudience=power");
    // …route-local params (layout, select, tab, q) never leak across…
    expect(preserveLocationSearch("/scope", "?ffBundle=scope-instrument&layout=grid"))
      .toBe("/scope?ffBundle=scope-instrument");
    expect(preserveLocationSearch("/messages", "?tab=observe&q=thread-1&select=a-1"))
      .toBe("/messages");
    // …and machineId is not whitelisted: it propagates only via the
    // MACHINE_SCOPED_VIEWS route rules, so generic preservation drops it.
    expect(preserveLocationSearch("/projects/pomo/sessions/s1", "?select=pomo.main&machineId=node-a"))
      .toBe("/projects/pomo/sessions/s1");
  });

  test("sessions route stays under /scope when the browser is in the scope namespace", () => {
    expect(routePath({ view: "sessions" }, "/scope/lanes")).toBe("/scope/sessions");
    expect(routePath({ view: "sessions" }, "/scope/sessions")).toBe("/scope/sessions");
    expect(routePath({ view: "sessions" }, "/sessions")).toBe("/sessions");
  });
});

describe("agents route parsing", () => {
  test("flight observe routes preserve explicit session and split selection", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/flights/flight-1/observe?session=session-2&compare=session-1",
    );

    expect(route).toEqual({
      view: "sessions",
      flightId: "flight-1",
      sessionId: "session-2",
      compareSessionId: "session-1",
    });
    expect(routePath(route)).toBe(
      "/flights/flight-1/observe?session=session-2&compare=session-1",
    );
  });

  test("legacy conversations path canonicalizes to messages", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/conversations")).toEqual({
      view: "messages",
    });
    expect(routePath({ view: "messages" })).toBe("/messages");
  });

  test("agent chat routes preserve opaque chat ids", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/agents/openscout-6.main.mini/c/c.openscout-chat");

    expect(route).toEqual({
      view: "agents-v2",
      agentId: "openscout-6.main.mini",
      conversationId: "c.openscout-chat",
      tab: "message",
    });
    expect(routePath(route)).toBe("/agents/openscout-6.main.mini/c/c.openscout-chat");
  });

  test("project agent session resource routes preserve session focus", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/projects/scope/agents/scope.main.arts-mac-mini-local/sessions/019efa89-4392-72f1-af6c-860951059bcb",
    );

    expect(route).toEqual({
      view: "agents-v2",
      agentId: "scope.main.arts-mac-mini-local",
      projectSlug: "scope",
      sessionId: "019efa89-4392-72f1-af6c-860951059bcb",
    });
    expect(routePath(route)).toBe(
      "/projects/scope/agents/scope.main.arts-mac-mini-local/sessions/019efa89-4392-72f1-af6c-860951059bcb",
    );
  });

  test("deprecated agents-v2 message hash routes open the message tab and serialize canonically", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/agents-v2/scope.main.arts-mac-mini-local#msg-msg-mqtjmvqd-n734dq",
    );

    expect(route).toEqual({
      view: "agents-v2",
      agentId: "scope.main.arts-mac-mini-local",
      tab: "message",
    });
    expect(routePath(route)).toBe(
      "/agents/scope.main.arts-mac-mini-local?tab=message",
    );
  });

  test("machine-scoped routes round-trip through URLs", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/fleet?machineId=node-b")).toEqual({
      view: "inbox",
      machineId: "node-b",
    });
    expect(routePath({ view: "inbox", machineId: "node-b" })).toBe("/?machineId=node-b");

    expect(routeFromUrl("http://127.0.0.1:43120/mesh?machineId=node-b")).toEqual({
      view: "mesh",
      machineId: "node-b",
    });
    expect(routePath({ view: "mesh", machineId: "node-b" })).toBe("/mesh?machineId=node-b");

    expect(routeFromUrl("http://127.0.0.1:43120/mesh-ops/wi-1?machineId=node-b")).toEqual({
      view: "mesh-ops",
      itemId: "wi-1",
      machineId: "node-b",
    });
    expect(routePath({ view: "mesh-ops", itemId: "wi-1", machineId: "node-b" })).toBe(
      "/mesh-ops/wi-1?machineId=node-b",
    );

    expect(routeFromUrl("http://127.0.0.1:43120/work/work-1?machineId=node-b")).toEqual({
      view: "work",
      workId: "work-1",
      machineId: "node-b",
    });
    expect(routePath({ view: "work", workId: "work-1", machineId: "node-b" })).toBe(
      "/work/work-1?machineId=node-b",
    );

    expect(routeFromUrl(
      "http://127.0.0.1:43120/follow?view=chat&workId=work-1&machineId=node-b",
    )).toEqual({
      view: "follow",
      preferredView: "chat",
      workId: "work-1",
      machineId: "node-b",
    });
    expect(routePath({
      view: "follow",
      preferredView: "chat",
      workId: "work-1",
      machineId: "node-b",
    })).toBe("/follow?view=chat&workId=work-1&machineId=node-b");

    expect(routeFromUrl("http://127.0.0.1:43120/providers?machineId=node-b")).toEqual({
      view: "harnesses",
      machineId: "node-b",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/harnesses?machineId=node-b")).toEqual({
      view: "harnesses",
      machineId: "node-b",
    });
    expect(routePath({ view: "harnesses", machineId: "node-b" })).toBe("/providers?machineId=node-b");
  });

  test("machine scope composes with existing route query params", () => {
    const agentRoute = routeFromUrl("http://127.0.0.1:43120/agents/hudson.main?tab=observe&machineId=node-b");
    expect(agentRoute).toEqual({
      view: "agents-v2",
      agentId: "hudson.main",
      tab: "observe",
      machineId: "node-b",
    });
    expect(routePath(agentRoute)).toBe("/agents/hudson.main?tab=observe&machineId=node-b");

    const conversationRoute = routeFromUrl("http://127.0.0.1:43120/c/c.hudson-chat?compose=ask&machineId=node-b");
    expect(conversationRoute).toEqual({
      view: "conversation",
      conversationId: "c.hudson-chat",
      machineId: "node-b",
    });
    expect(routePath(conversationRoute)).toBe("/c/c.hudson-chat?machineId=node-b");

    // Route unification retired filter/sort: legacy params are dropped, but the
    // machine scope still composes with the conversation route.
    const messagesRoute = routeFromUrl(
      "http://127.0.0.1:43120/messages/c.font-studio?filter=channel&sort=unread&machineId=node-b",
    );
    expect(messagesRoute).toEqual({
      view: "messages",
      conversationId: "c.font-studio",
      machineId: "node-b",
    });
    expect(routePath(messagesRoute)).toBe("/messages/c.font-studio?machineId=node-b");
  });

  test("machine scope helpers set and explicitly clear scoped routes", () => {
    expect(setRouteMachineScope({ view: "agents-v2" }, "node-b")).toEqual({
      view: "agents-v2",
      machineId: "node-b",
    });
    expect(routePath(clearRouteMachineScope({ view: "agents-v2", machineId: "node-b" }))).toBe("/projects");
    expect(setRouteMachineScope({ view: "settings" }, "node-b")).toEqual({ view: "settings" });
  });

  test("observe deep links preserve the explicit observe tab", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/agents/openscout-6.main.mini/c/c.openscout-chat?tab=observe");

    expect(route).toEqual({
      view: "agents-v2",
      agentId: "openscout-6.main.mini",
      conversationId: "c.openscout-chat",
      tab: "observe",
    });
    expect(routePath(route)).toBe("/agents/openscout-6.main.mini/c/c.openscout-chat?tab=observe");
  });

  test("synthetic agent observe links normalize to session observe", () => {
    const route = normalizeRoute(
      routeFromUrl(
        "http://127.0.0.1:43120/agents/native%3Aclaude%3A1e753cef-92ae-4e22-a365-0f5d23a07652?tab=observe",
      ),
    );

    expect(route).toEqual({
      view: "sessions",
      sessionId: "1e753cef-92ae-4e22-a365-0f5d23a07652",
    });
    expect(routePath(route)).toBe(
      "/sessions/1e753cef-92ae-4e22-a365-0f5d23a07652",
    );
  });


  test("agent-scoped session routes round-trip", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/agents/hudson.main/sessions/codex-thread-1");

    expect(route).toEqual({
      view: "agents-v2",
      agentId: "hudson.main",
      sessionId: "codex-thread-1",
    });
    expect(routePath(route)).toBe("/agents/hudson.main/sessions/codex-thread-1");
  });

  test("standalone session routes carry agent context as quiet query metadata", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/sessions/codex-thread-1?agentId=hudson.main");

    expect(route).toEqual({
      view: "sessions",
      sessionId: "codex-thread-1",
      agentId: "hudson.main",
    });
    expect(routePath(route)).toBe("/sessions/codex-thread-1?agentId=hudson.main");
    if (route.view !== "sessions") throw new Error("expected a sessions route");
    expect(routePath({ ...route, machineId: "node-b" })).toBe(
      "/sessions/codex-thread-1?agentId=hudson.main&machineId=node-b",
    );
  });

  test("follow routes preserve Scout ids and preferred view", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/follow?view=tail&flightId=flight-1&invocationId=inv-1&conversationId=c.hudson-chat&workId=work-1&targetAgentId=hudson.main",
    );

    expect(route).toEqual({
      view: "follow",
      preferredView: "tail",
      flightId: "flight-1",
      invocationId: "inv-1",
      conversationId: "c.hudson-chat",
      workId: "work-1",
      targetAgentId: "hudson.main",
    });
    expect(routePath(route)).toBe(
      "/follow?view=tail&flightId=flight-1&invocationId=inv-1&conversationId=c.hudson-chat&workId=work-1&targetAgentId=hudson.main",
    );
  });

  test("tail routes preserve an optional focus query", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/ops/tail?q=019ddb1b-test-thread");

    expect(route).toEqual({
      view: "ops",
      mode: "tail",
      tailQuery: "019ddb1b-test-thread",
    });
    expect(routePath(route)).toBe("/ops/tail?q=019ddb1b-test-thread");
  });

  test("agent lanes bypass the broad ops feature gate", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/ops/lanes?no-ops")).toEqual({
      view: "ops",
      mode: "lanes",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/ops/control?no-ops")).toEqual({
      view: "inbox",
    });
  });

  test("terminal routes tolerate trailing punctuation on mode deep links", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/terminal/hero.master?mode=takeover.")).toEqual({
      view: "terminal",
      agentId: "hero.master",
      mode: "takeover",
    });
  });

  test("terminal routes preserve registered session surface deep links", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/terminal?session=ts.123&surface=zellij%3Ascout-zj&mode=observe");

    expect(route).toEqual({
      view: "terminal",
      terminalSessionId: "ts.123",
      terminalSurfaceKey: surfaceId("zellij", "scout-zj"),
      mode: "observe",
    });
    expect(routePath(route)).toBe("/terminal/zellij/scout-zj?mode=observe");
  });

  test("terminal routes support backend/session path deep links", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/terminal/tmux/relay-atelier-card-w-eury8m-master-arts-mac-mini-local-claude?mode=takeover",
    );

    expect(route).toEqual({
      view: "terminal",
      terminalSurfaceKey: surfaceId("tmux", "relay-atelier-card-w-eury8m-master-arts-mac-mini-local-claude"),
      mode: "takeover",
    });
    expect(routePath(route)).toBe(
      "/terminal/tmux/relay-atelier-card-w-eury8m-master-arts-mac-mini-local-claude?mode=takeover",
    );
  });

  test("terminal routes support fresh backend tabs", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/terminal/new?backend=zellij&agent=codex&name=scout-zj-tab-1&tab=tab-1&socketDir=/tmp/z",
    );

    expect(route).toEqual({
      view: "terminal",
      terminalBackend: "zellij",
      terminalAgent: "codex",
      terminalSessionName: "scout-zj-tab-1",
      terminalTabId: "tab-1",
      zellijSocketDir: "/tmp/z",
    });
    expect(routePath(route)).toBe(
      "/terminal/new?backend=zellij&agent=codex&name=scout-zj-tab-1&tab=tab-1&socketDir=%2Ftmp%2Fz",
    );
  });

  test("ops issues route accepts error-oriented aliases", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/ops/advisor")).toEqual({
      view: "ops",
      mode: "advisor",
    });
    // Legacy slug — the surface was never a plan reader.
    expect(routeFromUrl("http://127.0.0.1:43120/ops/plan")).toEqual({
      view: "ops",
      mode: "advisor",
    });
    expect(routePath({ view: "ops", mode: "advisor" })).toBe("/ops/advisor");
    expect(routeFromUrl("http://127.0.0.1:43120/ops/issues")).toEqual({
      view: "ops",
      mode: "issues",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/ops/errors")).toEqual({
      view: "ops",
      mode: "issues",
    });
    expect(routePath({ view: "ops", mode: "issues" })).toBe("/ops/issues");
  });

  test("messages index route round-trips", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/messages")).toEqual({
      view: "messages",
    });
    expect(routePath({ view: "messages" })).toBe("/messages");
  });

  test("search route round-trips", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/search")).toEqual({
      view: "search",
    });
    expect(routePath({ view: "search" })).toBe("/search");
    expect(routeFromUrl("http://127.0.0.1:43120/search/knowledge")).toEqual({
      view: "search",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/search/indexer")).toEqual({
      view: "search",
      mode: "indexer",
    });
    expect(routePath({ view: "search", mode: "knowledge" })).toBe("/search");
    expect(routePath({ view: "search", mode: "indexer" })).toBe("/search/indexer");
  });

  test("briefings routes round-trip", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/briefings")).toEqual({
      view: "briefings",
    });
    expect(routePath({ view: "briefings" })).toBe("/briefings");
    expect(routeFromUrl("http://127.0.0.1:43120/briefings/brief-42")).toEqual({
      view: "briefings",
      briefingId: "brief-42",
    });
    expect(routePath({ view: "briefings", briefingId: "brief-42" })).toBe(
      "/briefings/brief-42",
    );
    // Encoded ids survive the round trip — parse and serialization must agree
    // on decoding.
    expect(routeFromUrl("http://127.0.0.1:43120/briefings/b%2F1")).toEqual({
      view: "briefings",
      briefingId: "b/1",
    });
    expect(routePath({ view: "briefings", briefingId: "b/1" })).toBe(
      "/briefings/b%2F1",
    );
  });

  test("static view prefixes round-trip", () => {
    // Simple static views: URL and Route must round-trip exactly.
    for (const view of [
      "repos",
      "mesh",
      "activity",
    ] as const) {
      expect(routeFromUrl(`http://127.0.0.1:43120/${view}`)).toEqual({ view });
      expect(routePath({ view })).toBe(`/${view}`);
    }
    expect(routeFromUrl("http://127.0.0.1:43120/providers")).toEqual({ view: "harnesses" });
    expect(routeFromUrl("http://127.0.0.1:43120/harnesses")).toEqual({ view: "harnesses" });
    expect(routePath({ view: "harnesses" })).toBe("/providers");
    // Removed legacy aliases still parse, but serialize to their canonical destinations.
    expect(routeFromUrl("http://127.0.0.1:43120/fleet")).toEqual({ view: "inbox" });
    expect(routePath({ view: "inbox" })).toBe("/");
    expect(routeFromUrl("http://127.0.0.1:43120/conversations")).toEqual({ view: "messages" });
    expect(routePath({ view: "messages" })).toBe("/messages");
    expect(routeFromUrl("http://127.0.0.1:43120/dispatch")).toEqual({ view: "broker" });
    expect(routeFromUrl("http://127.0.0.1:43120/broker")).toEqual({ view: "broker" });
    expect(routePath({ view: "broker" })).toBe("/dispatch");
    expect(routeFromUrl("http://127.0.0.1:43120/dispatch?filter=delivered")).toEqual({
      view: "broker",
      filter: "delivered",
    });
    expect(routePath({ view: "broker", filter: "failed" })).toBe(
      "/dispatch?filter=failed",
    );
    // /channels is a legacy alias onto the unified conversation route; it parses
    // but never serializes back — canonical form is /messages/<id>.
    expect(routeFromUrl("http://127.0.0.1:43120/channels/chan-1")).toEqual({
      view: "messages",
      conversationId: "chan-1",
    });
    expect(routePath({ view: "messages", conversationId: "chan-1" })).toBe("/messages/chan-1");
    expect(routeFromUrl("http://127.0.0.1:43120/channels")).toEqual({ view: "messages" });
    expect(routeFromUrl("http://127.0.0.1:43120/work/w-1")).toEqual({
      view: "work",
      workId: "w-1",
    });
    expect(routePath({ view: "work", workId: "w-1" })).toBe("/work/w-1");
    // Mesh Ops: bare index plus deep-linked item, mirroring /work.
    expect(routeFromUrl("http://127.0.0.1:43120/mesh-ops")).toEqual({ view: "mesh-ops" });
    expect(routePath({ view: "mesh-ops" })).toBe("/mesh-ops");
    expect(routeFromUrl("http://127.0.0.1:43120/mesh-ops/wi-1")).toEqual({
      view: "mesh-ops",
      itemId: "wi-1",
    });
    expect(routePath({ view: "mesh-ops", itemId: "wi-1" })).toBe("/mesh-ops/wi-1");
    // Encoded ids survive the round trip.
    expect(routeFromUrl("http://127.0.0.1:43120/mesh-ops/wi%2F1")).toEqual({
      view: "mesh-ops",
      itemId: "wi/1",
    });
    expect(routePath({ view: "mesh-ops", itemId: "wi/1" })).toBe("/mesh-ops/wi%2F1");
    // Bare /work has no route: the parser sends it to the inbox default.
    expect(routeFromUrl("http://127.0.0.1:43120/work")).toEqual({ view: "inbox" });
    expect(routeFromUrl("http://127.0.0.1:43120/settings/agents/a-1")).toEqual({
      view: "settings",
      section: "agents",
      agentId: "a-1",
    });
    expect(routePath({ view: "settings", section: "agents", agentId: "a-1" })).toBe(
      "/settings/agents/a-1",
    );
  });

  test("nested resource prefixes round-trip", () => {
    // Sessions surface: bare + session-scoped, both view "sessions".
    expect(routeFromUrl("http://127.0.0.1:43120/sessions")).toEqual({ view: "sessions" });
    expect(routePath({ view: "sessions" })).toBe("/sessions");
    expect(routeFromUrl("http://127.0.0.1:43120/sessions/sess-1")).toEqual({
      view: "sessions",
      sessionId: "sess-1",
    });
    expect(routePath({ view: "sessions", sessionId: "sess-1" })).toBe("/sessions/sess-1");
    // Percent-encoded session id survives the round trip.
    expect(routeFromUrl("http://127.0.0.1:43120/sessions/s%2F1")).toEqual({
      view: "sessions",
      sessionId: "s/1",
    });
    expect(routePath({ view: "sessions", sessionId: "s/1" })).toBe("/sessions/s%2F1");

    // Messages surface: bare + conversation-scoped, both view "messages".
    expect(routeFromUrl("http://127.0.0.1:43120/messages")).toEqual({ view: "messages" });
    expect(routePath({ view: "messages" })).toBe("/messages");
    expect(routeFromUrl("http://127.0.0.1:43120/messages/c.font-studio")).toEqual({
      view: "messages",
      conversationId: "c.font-studio",
    });
    expect(routePath({ view: "messages", conversationId: "c.font-studio" })).toBe(
      "/messages/c.font-studio",
    );
    expect(
      routeFromUrl(
        "http://127.0.0.1:43120/messages/agent/worker%2Fmain?thread=conv%2Fthread&machineId=node-a",
      ),
    ).toEqual({
      view: "messages",
      agentId: "worker/main",
      threadId: "conv/thread",
      machineId: "node-a",
    });
    expect(routePath({
      view: "messages",
      agentId: "worker/main",
      threadId: "conv/thread",
      machineId: "node-a",
    })).toBe(
      "/messages/agent/worker%2Fmain?thread=conv%2Fthread&machineId=node-a",
    );

    // Conversation detail (/c/{id}) and agent-info (/agent/{id}).
    expect(routeFromUrl("http://127.0.0.1:43120/c/c.hudson-chat")).toEqual({
      view: "conversation",
      conversationId: "c.hudson-chat",
    });
    expect(routePath({ view: "conversation", conversationId: "c.hudson-chat" })).toBe(
      "/c/c.hudson-chat",
    );
    expect(routeFromUrl("http://127.0.0.1:43120/agent/c.hudson-chat")).toEqual({
      view: "agent-info",
      conversationId: "c.hudson-chat",
    });
    expect(routePath({ view: "agent-info", conversationId: "c.hudson-chat" })).toBe(
      "/agent/c.hudson-chat",
    );
    // Percent-encoded conversation id round-trips through /c/$conversationId.
    expect(routeFromUrl("http://127.0.0.1:43120/c/c%2Fslash")).toEqual({
      view: "conversation",
      conversationId: "c/slash",
    });
    expect(routePath({ view: "conversation", conversationId: "c/slash" })).toBe("/c/c%2Fslash");

    // Follow: bare canonical form is view "follow".
    expect(routeFromUrl("http://127.0.0.1:43120/follow")).toEqual({ view: "follow" });
    expect(routePath({ view: "follow" })).toBe("/follow");

    // Terminal: bare + agent + backend/session path shapes, all view "terminal".
    expect(routeFromUrl("http://127.0.0.1:43120/terminal")).toEqual({ view: "terminal" });
    expect(routePath({ view: "terminal" })).toBe("/terminal");
    expect(routeFromUrl("http://127.0.0.1:43120/terminal/hero.master")).toEqual({
      view: "terminal",
      agentId: "hero.master",
    });
    expect(routePath({ view: "terminal", agentId: "hero.master" })).toBe("/terminal/hero.master");
    expect(routeFromUrl("http://127.0.0.1:43120/terminal/tmux/scout-zj")).toEqual({
      view: "terminal",
      terminalSurfaceKey: surfaceId("tmux", "scout-zj"),
    });
    expect(routePath({ view: "terminal", terminalSurfaceKey: surfaceId("tmux", "scout-zj") })).toBe(
      "/terminal/tmux/scout-zj",
    );

    // Project registry shapes — every /projects/* path parses to view "agents-v2".
    expect(routeFromUrl("http://127.0.0.1:43120/projects")).toEqual({ view: "agents-v2" });
    expect(routeFromUrl("http://127.0.0.1:43120/projects/lattices")).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
    });
    expect(routePath({ view: "agents-v2", projectSlug: "lattices" })).toBe("/projects/lattices");
    expect(routeFromUrl("http://127.0.0.1:43120/projects/lattices/agents")).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
      indexView: "agents",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/projects/lattices/agents/lattices.main")).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
      agentId: "lattices.main",
    });
    expect(
      routePath({ view: "agents-v2", projectSlug: "lattices", agentId: "lattices.main" }),
    ).toBe("/projects/lattices/agents/lattices.main");
    expect(
      routeFromUrl("http://127.0.0.1:43120/projects/lattices/agents/lattices.main/c/c.foo"),
    ).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
      agentId: "lattices.main",
      conversationId: "c.foo",
      tab: "message",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/projects/lattices/sessions")).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
      indexView: "sessions",
    });

    // Canonical /agents/* agent detail shapes — all view "agents-v2".
    expect(routeFromUrl("http://127.0.0.1:43120/agents")).toEqual({ view: "agents-v2" });
    expect(routeFromUrl("http://127.0.0.1:43120/agents/hudson.main")).toEqual({
      view: "agents-v2",
      agentId: "hudson.main",
    });
    expect(routePath({ view: "agents-v2", agentId: "hudson.main" })).toBe("/agents/hudson.main");

    // Legacy /agents-v2/* input parses to agents-v2 and serializes canonically to /agents.
    expect(routeFromUrl("http://127.0.0.1:43120/agents-v2/hudson.main")).toEqual({
      view: "agents-v2",
      agentId: "hudson.main",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/agents-v2/sessions/sess-9")).toEqual({
      view: "agents-v2",
      sessionId: "sess-9",
    });

    // Legacy /agents.deprecated/* → agents-v2 (canonical /projects / /agents/:id).
    expect(routeFromUrl("http://127.0.0.1:43120/agents.deprecated")).toEqual({ view: "agents-v2" });
    expect(routePath({ view: "agents-v2" })).toBe("/projects");
    expect(routeFromUrl("http://127.0.0.1:43120/agents.deprecated/hudson.main")).toEqual({
      view: "agents-v2",
      agentId: "hudson.main",
    });
    expect(routePath({ view: "agents-v2", agentId: "hudson.main" })).toBe(
      "/agents/hudson.main",
    );
    expect(routeFromUrl("http://127.0.0.1:43120/agents.deprecated/hudson.main/c/c.foo")).toEqual({
      view: "agents-v2",
      agentId: "hudson.main",
      conversationId: "c.foo",
      tab: "message",
    });
    // The session-resource shape is a session observe surface, not agents-v2.
    expect(
      routeFromUrl("http://127.0.0.1:43120/agents.deprecated/hudson.main/sessions/sess-1"),
    ).toEqual({
      view: "sessions",
      agentId: "hudson.main",
      sessionId: "sess-1",
    });

    // ops and repo-diff views are not a function of the path prefix alone.
    // /ops/* can resolve to "inbox" when the ops gate is off or ?no-ops is set.
    expect(routeFromUrl("http://127.0.0.1:43120/ops/control?no-ops")).toEqual({ view: "inbox" });
    // /repo-diff without ?path falls through to the inbox default.
    expect(routeFromUrl("http://127.0.0.1:43120/repo-diff")).toEqual({ view: "inbox" });
  });

  test("messages route keeps conversationId and drops legacy filter/sort params", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/messages/c.font-studio?filter=channel&sort=unread",
    );
    expect(route).toEqual({ view: "messages", conversationId: "c.font-studio" });
    expect(routePath(route)).toBe("/messages/c.font-studio");
  });

  test("messages routes carry no query params of their own", () => {
    expect(routePath({ view: "messages" })).toBe("/messages");
    expect(routePath({ view: "messages", conversationId: "c.foo" })).toBe("/messages/c.foo");
  });

  test("project registry routes round-trip and old agents-v2 input serializes canonically", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/agents-v2")).toEqual({
      view: "agents-v2",
    });
    expect(routePath({ view: "agents-v2" })).toBe("/projects");

    const scoped = routeFromUrl(
      "http://127.0.0.1:43120/projects/lattices/sessions?state=needs",
    );
    expect(scoped).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
      stateFilter: "needs",
      indexView: "sessions",
    });
    expect(routeFromUrl(`http://127.0.0.1:43120${routePath(scoped)}`)).toEqual(scoped);

    const agent = routeFromUrl("http://127.0.0.1:43120/projects/lattices/agents/lattices.main/sessions/c.foo");
    expect(agent).toEqual({
      view: "agents-v2",
      agentId: "lattices.main",
      projectSlug: "lattices",
      sessionId: "c.foo",
    });
    expect(routePath(agent)).toBe("/projects/lattices/agents/lattices.main/sessions/c.foo");

    const session = routeFromUrl("http://127.0.0.1:43120/projects/lattices/sessions/c.foo");
    expect(session).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
      indexView: "sessions",
      sessionId: "c.foo",
    });
    expect(routePath(session)).toBe("/projects/lattices/sessions/c.foo");

    const oldNoisySession = routeFromUrl(
      "http://127.0.0.1:43120/projects/lattices/sessions/c.foo?select=lattices.main",
    );
    expect(oldNoisySession).toEqual({
      view: "agents-v2",
      projectSlug: "lattices",
      indexView: "sessions",
      sessionId: "c.foo",
      selectedAgentId: "lattices.main",
    });
    expect(routePath(oldNoisySession)).toBe("/projects/lattices/sessions/c.foo");

    const selected = routeFromUrl(
      "http://127.0.0.1:43120/projects/hudson?select=grok.main",
    );
    expect(selected).toEqual({
      view: "agents-v2",
      projectSlug: "hudson",
      selectedAgentId: "grok.main",
    });
    expect(routePath(selected)).toBe("/projects/hudson?select=grok.main");
  });

  test("agent config tab routes round-trip and legacy definitions alias", () => {
    const configRoute = routeFromUrl("http://127.0.0.1:43120/agents/codex.main?tab=config");
    expect(configRoute).toEqual({
      view: "agents-v2",
      agentId: "codex.main",
      tab: "config",
    });
    expect(routePath(configRoute)).toBe("/agents/codex.main?tab=config");

    const legacyRoute = routeFromUrl("http://127.0.0.1:43120/agents.deprecated/hudson.main?tab=definitions");
    expect(legacyRoute).toEqual({
      view: "agents-v2",
      agentId: "hudson.main",
      tab: "config",
    });
    expect(routePath(legacyRoute)).toBe("/agents/hudson.main?tab=config");
  });

  test("agent configuration settings routes round-trip", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/settings/agents")).toEqual({
      view: "settings",
      section: "agents",
    });
    expect(routePath({ view: "settings", section: "agents" })).toBe("/settings/agents");

    const detailRoute = routeFromUrl("http://127.0.0.1:43120/settings/agents/openscout-6.main.mini");
    expect(detailRoute).toEqual({
      view: "settings",
      section: "agents",
      agentId: "openscout-6.main.mini",
    });
    expect(routePath(detailRoute)).toBe("/settings/agents/openscout-6.main.mini");
  });
});

describe("session catalog selection", () => {
  const sessions = [
    {
      id: "active-session",
      startedAt: 300,
      cwd: "/repo",
    },
    {
      id: "routed-session",
      startedAt: 200,
      cwd: "/repo",
      surfaceSessionId: "tmux:routed",
    },
    {
      id: "scope-catalog-session",
      startedAt: 150,
      cwd: "/Users/art/dev/scope",
      harness: "codex",
      surfaceSessionId: "relay-scope-live-arts-mac-mini-local-codex",
      harnessSessionId: "relay-scope-codex",
      runtimeSessionId: "runtime-scope-codex",
    },
    {
      id: "scope-claude-session",
      startedAt: 125,
      cwd: "/Users/art/dev/scope",
      harness: "claude",
      surfaceSessionId: "relay-scope-live-arts-mac-mini-local-claude",
    },
    {
      id: "focused-session",
      startedAt: 100,
      cwd: "/repo",
    },
  ];

  test("normalizes routed surface ids to catalog session ids", () => {
    expect(resolveRoutedSessionId("tmux:routed", sessions)).toBe("routed-session");
    expect(resolveRoutedSessionId("missing-session", sessions)).toBeNull();
  });

  test("normalizes routed stable aliases to catalog session ids", () => {
    expect(resolveRoutedSessionId("relay-scope-codex", sessions)).toBe("scope-catalog-session");
    expect(resolveRoutedSessionId("runtime-scope-codex", sessions)).toBe("scope-catalog-session");
  });

  test("normalizes compact relay refs to matching harness surfaces", () => {
    expect(resolveRoutedSessionId("relay-scope-claude", sessions)).toBe("scope-claude-session");
    expect(resolveRoutedSessionId("relay-scope-codex", sessions)).toBe("scope-catalog-session");
  });

  test("prefers a valid routed session over stale focused and active sessions", () => {
    const sorted = sortSessionsByRecency(sessions, "active-session");

    expect(
      resolveSelectedSessionId(
        "agent-1",
        { agentId: "agent-1", sessionId: "focused-session" },
        "active-session",
        sorted,
        "relay-scope-codex",
      ),
    ).toBe("scope-catalog-session");
  });

  test("falls back to active session when routed session is invalid (no parallel focus)", () => {
    const sorted = sortSessionsByRecency(sessions, "active-session");

    expect(
      resolveSelectedSessionId(
        "agent-1",
        { agentId: "agent-1", sessionId: "focused-session" },
        "active-session",
        sorted,
        "missing-session",
      ),
    ).toBe("active-session");
  });
});
