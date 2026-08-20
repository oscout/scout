import { describe, expect, mock, test } from "bun:test";
import type * as ReactModule from "react";

// @ts-expect-error -- the relative .js path keeps bun's runtime resolution to the real react
// module; a bare "react" specifier would be hijacked by tsconfig `paths` to the .d.ts. The cast
// restores the proper types that the path import otherwise loses.
const React = (await import("../../node_modules/react/index.js")) as typeof ReactModule;

mock.module("react", () => React);

import { formatTerminalSurfaceId } from "@openscout/protocol";
import type { Route } from "./types.ts";
import type { BrowserLocationEnv, BrowserLocationState } from "./router.ts";

const {
  applyLocationUpdate,
  buildNavigateState,
  canonicalHrefForRoute,
  createBrowserLocationStore,
  isSettingsHistoryEntry,
  planNavigation,
  readReturnToFromState,
  routeFromUrl,
  routeKey,
  routePath,
  shouldUseHistoryBack,
} = await import("./router.ts");

const ORIGIN = "http://127.0.0.1:43120";

/* ── URL → Route → canonical path fixtures: all 22 view variants ── */

describe("route fixtures", () => {
  const fixtures: Array<{ url: string; route: Route; canonical: string }> = [
    { url: "/", route: { view: "inbox" }, canonical: "/" },
    {
      url: "/c/c.hudson-chat",
      route: { view: "conversation", conversationId: "c.hudson-chat" },
      canonical: "/c/c.hudson-chat",
    },
    {
      url: "/agent/c.hudson-chat",
      route: { view: "agent-info", conversationId: "c.hudson-chat" },
      canonical: "/agent/c.hudson-chat",
    },
    {
      url: "/agents/hudson.main",
      route: { view: "agents-v2", agentId: "hudson.main" },
      canonical: "/agents/hudson.main",
    },
    {
      url: "/projects/lattices/agents/lattices.main",
      route: { view: "agents-v2", projectSlug: "lattices", agentId: "lattices.main" },
      canonical: "/projects/lattices/agents/lattices.main",
    },
    { url: "/fleet", route: { view: "inbox" }, canonical: "/" },
    { url: "/conversations", route: { view: "messages" }, canonical: "/messages" },
    {
      url: "/messages/c.foo?filter=dm",
      route: { view: "messages", conversationId: "c.foo" },
      canonical: "/messages/c.foo",
    },
    {
      url: "/sessions/sess-1",
      route: { view: "sessions", sessionId: "sess-1" },
      canonical: "/sessions/sess-1",
    },
    {
      url: "/repos?root=repo-a",
      route: { view: "repos", root: "repo-a" },
      canonical: "/repos?root=repo-a",
    },
    { url: "/providers", route: { view: "harnesses" }, canonical: "/providers" },
    {
      url: "/repo-diff?path=repo-a",
      route: { view: "repo-diff", path: "repo-a" },
      canonical: "/repo-diff?path=repo-a",
    },
    {
      url: "/search/indexer",
      route: { view: "search", mode: "indexer" },
      canonical: "/search/indexer",
    },
    {
      url: "/channels/chan-1",
      route: { view: "messages", conversationId: "chan-1" },
      canonical: "/messages/chan-1",
    },
    { url: "/mesh", route: { view: "mesh" }, canonical: "/mesh" },
    { url: "/dispatch", route: { view: "broker" }, canonical: "/dispatch" },
    {
      url: "/code?root=repo-a&file=repo-a%2Fsrc%2Fa.ts&fromConversation=c.thread",
      route: {
        view: "code",
        root: "repo-a",
        file: "repo-a/src/a.ts",
        returnConversationId: "c.thread",
      },
      canonical: "/code?root=repo-a&file=repo-a%2Fsrc%2Fa.ts&fromConversation=c.thread",
    },
    {
      url: "/code/openscout/packages/web/client.ts?wt=voice-nav&line=40&endLine=44&fromConversation=c.thread",
      route: {
        view: "code",
        project: "openscout",
        path: "packages/web/client.ts",
        wt: "voice-nav",
        line: 40,
        endLine: 44,
        returnConversationId: "c.thread",
      },
      canonical: "/code/openscout/packages/web/client.ts?wt=voice-nav&line=40&endLine=44&fromConversation=c.thread",
    },
    {
      url: "/briefings/brief-1",
      route: { view: "briefings", briefingId: "brief-1" },
      canonical: "/briefings/brief-1",
    },
    { url: "/activity", route: { view: "activity" }, canonical: "/activity" },
    { url: "/voice", route: { view: "voice" }, canonical: "/voice" },
    { url: "/work/w-1", route: { view: "work", workId: "w-1" }, canonical: "/work/w-1" },
    {
      url: "/settings/agents",
      route: { view: "settings", section: "agents" },
      canonical: "/settings/agents",
    },
    {
      url: "/ops/tail?q=thread-1",
      route: { view: "ops", mode: "tail", tailQuery: "thread-1" },
      canonical: "/ops/tail?q=thread-1",
    },
    {
      url: "/follow?flightId=f-1",
      route: { view: "follow", flightId: "f-1" },
      canonical: "/follow?flightId=f-1",
    },
    {
      url: "/terminal/tmux/scout-zj",
      route: { view: "terminal", terminalSurfaceKey: formatTerminalSurfaceId({ backend: "tmux", hostSession: "scout-zj" }) },
      canonical: "/terminal/tmux/scout-zj",
    },
  ];

  test("fixtures cover all 21 view variants", () => {
    expect(new Set(fixtures.map((f) => f.route.view)).size).toBe(21);
  });

  for (const { url, route, canonical } of fixtures) {
    test(`${url} parses and serializes canonically`, () => {
      const parsed = routeFromUrl(`${ORIGIN}${url}`);
      expect(parsed).toEqual(route);
      expect(routePath(parsed)).toBe(canonical);
      // Canonical output is a fixed point.
      expect(routeFromUrl(`${ORIGIN}${canonical}`)).toEqual(route);
    });
  }

  const aliases: Array<{ url: string; canonical: string }> = [
    // Legacy brand namespace → canonical scope paths (namespace-aware routePath).
    { url: "/scout/sessions/s-1", canonical: "/scope/sessions/s-1" },
    { url: "/scout/tail?q=codex", canonical: "/scope/tail?q=codex" },
    // Legacy agents-v2 input → canonical project registry paths.
    { url: "/agents-v2", canonical: "/projects" },
    { url: "/agents-v2/hudson.main", canonical: "/agents/hudson.main" },
    { url: "/agents-v2/sessions/sess-9", canonical: "/sessions/sess-9" },
    // Bare /agents is the canonical unscoped directory alias for /projects.
    { url: "/agents", canonical: "/projects" },
    // broker alias → canonical dispatch path.
    { url: "/broker", canonical: "/dispatch" },
    // Default-mode aliases collapse out of the URL.
    { url: "/search/knowledge", canonical: "/search" },
    { url: "/ops/errors", canonical: "/ops/issues" },
    { url: "/ops/command", canonical: "/ops/control" },
    // Legacy deprecated-agents session resource → canonical session observe.
    { url: "/agents.deprecated/h.main/sessions/s-1", canonical: "/sessions/s-1?agentId=h.main" },
    // Legacy fleet / conversations aliases → home / messages.
    { url: "/fleet", canonical: "/" },
    { url: "/conversations", canonical: "/messages" },
    { url: "/harnesses", canonical: "/providers" },
    { url: "/agents.deprecated", canonical: "/projects" },
    { url: "/agents.deprecated/hudson.main", canonical: "/agents/hudson.main" },
  ];

  for (const { url, canonical } of aliases) {
    test(`alias ${url} serializes to ${canonical}`, () => {
      const parsed = routeFromUrl(`${ORIGIN}${url}`);
      expect(routePath(parsed, url.split("?")[0])).toBe(canonical);
    });
  }
});

/* ── planNavigation: URL policy ── */

describe("planNavigation URL policy", () => {
  test("route-local search params never leak across navigation", () => {
    const { href } = planNavigation(
      { pathname: "/ops/tail", searchStr: "?q=thread-1&layout=grid&tab=observe&select=a-1&session=s-1" },
      { view: "mesh" },
    );
    expect(href).toBe("/mesh");
  });

  test("whitelisted global feature-flag params carry across navigation", () => {
    const { href } = planNavigation(
      { pathname: "/ops/tail", searchStr: "?q=thread-1&ffBundle=max-pro&no-ops&ff.ops.control=off&studioMode=after" },
      { view: "mesh" },
    );
    expect(href).toBe("/mesh?ffBundle=max-pro&no-ops=&ff.ops.control=off&studioMode=after");
  });

  test("preserveSearch:false drops even whitelisted params", () => {
    const { href } = planNavigation(
      { pathname: "/fleet", searchStr: "?ffBundle=max-pro" },
      { view: "mesh" },
      { preserveSearch: false },
    );
    expect(href).toBe("/mesh");
  });

  test("hash clears by default and sets only on explicit request", () => {
    const cleared = planNavigation(
      { pathname: "/ops/lanes", searchStr: "" },
      { view: "sessions" },
    );
    expect(cleared.href).toBe("/sessions");

    const explicit = planNavigation(
      { pathname: "/ops/lanes", searchStr: "" },
      { view: "sessions", sessionId: "s-1" },
      { hash: "s-lane-sheet-vitals" },
    );
    expect(explicit.href).toBe("/sessions/s-1#s-lane-sheet-vitals");

    const prefixed = planNavigation(
      { pathname: "/ops/lanes", searchStr: "" },
      { view: "sessions", sessionId: "s-1" },
      { hash: "#msg-1" },
    );
    expect(prefixed.href).toBe("/sessions/s-1#msg-1");
  });

  test("machineId follows the MACHINE_SCOPED_VIEWS propagation rules only", () => {
    // scoped → scoped: machineId carries through the route.
    const carried = planNavigation(
      { pathname: "/", searchStr: "?machineId=node-b" },
      { view: "sessions" },
    );
    expect(carried.route).toEqual({ view: "sessions", machineId: "node-b" });
    expect(carried.href).toBe("/sessions?machineId=node-b");

    const followed = planNavigation(
      { pathname: "/", searchStr: "?machineId=node-b" },
      { view: "follow", workId: "work-1", preferredView: "chat" },
    );
    expect(followed.route).toEqual({
      view: "follow",
      workId: "work-1",
      preferredView: "chat",
      machineId: "node-b",
    });
    expect(followed.href).toBe("/follow?view=chat&workId=work-1&machineId=node-b");

    // scoped → unscoped: machineId drops.
    const dropped = planNavigation(
      { pathname: "/", searchStr: "?machineId=node-b" },
      { view: "settings" },
    );
    expect(dropped.href).toBe("/settings");

    // unscoped current URL with a stray machineId: it never enters the route
    // model, so it cannot reappear on a later scoped navigation.
    const stray = planNavigation(
      { pathname: "/settings", searchStr: "?machineId=node-b" },
      { view: "inbox" },
    );
    expect(stray.href).toBe("/");

    // explicit machineId on the destination wins over the current scope.
    const overridden = planNavigation(
      { pathname: "/", searchStr: "?machineId=node-b" },
      { view: "sessions", machineId: "node-c" },
    );
    expect(overridden.href).toBe("/sessions?machineId=node-c");

    // explicit empty machineId clears the scope.
    const clearedScope = planNavigation(
      { pathname: "/", searchStr: "?machineId=node-b" },
      { view: "sessions", machineId: "" },
    );
    expect(clearedScope.href).toBe("/sessions");
  });

  test("scope namespace is retained for scope-mapped routes", () => {
    const sessions = planNavigation(
      { pathname: "/scope/lanes", searchStr: "" },
      { view: "sessions" },
    );
    expect(sessions.href).toBe("/scope/sessions");

    const tail = planNavigation(
      { pathname: "/scope/lanes", searchStr: "" },
      { view: "ops", mode: "tail", tailQuery: "codex" },
    );
    expect(tail.href).toBe("/scope/tail?q=codex");

    // Routes with no scope segment escape the namespace on purpose.
    const mesh = planNavigation(
      { pathname: "/scope/lanes", searchStr: "" },
      { view: "mesh" },
    );
    expect(mesh.href).toBe("/mesh");
  });
});

/* ── updateLocation href computation ── */

describe("applyLocationUpdate", () => {
  const current = { pathname: "/ops/lanes", searchStr: "?layout=grid&q=x", hash: "old" };

  test("patches search keys and deletes on null", () => {
    expect(applyLocationUpdate(current, { searchPatch: { layout: "floor" }, hash: undefined }))
      .toBe("/ops/lanes?layout=floor&q=x#old");
    expect(applyLocationUpdate(current, { searchPatch: { layout: null }, hash: undefined }))
      .toBe("/ops/lanes?q=x#old");
  });

  test("hash: undefined keeps, null clears, value sets", () => {
    expect(applyLocationUpdate(current, { hash: undefined })).toBe("/ops/lanes?layout=grid&q=x#old");
    expect(applyLocationUpdate(current, { hash: null })).toBe("/ops/lanes?layout=grid&q=x");
    expect(applyLocationUpdate(current, { hash: "s-lane-sheet-vitals" }))
      .toBe("/ops/lanes?layout=grid&q=x#s-lane-sheet-vitals");
    expect(applyLocationUpdate({ ...current, hash: "" }, { hash: "#section" }))
      .toBe("/ops/lanes?layout=grid&q=x#section");
  });
});

/* ── location store: push/replace, back/forward, entry state ── */

function locationOf(href: string, state: unknown = null): BrowserLocationState {
  const url = new URL(href, ORIGIN);
  return {
    pathname: url.pathname,
    searchStr: url.search,
    hash: url.hash.replace(/^#/, ""),
    state,
  };
}

function createFakeEnv(initialHref: string) {
  let current = locationOf(initialHref);
  const calls: Array<{ kind: "push" | "replace"; href: string; state: unknown }> = [];
  const observers = new Set<() => void>();
  const env: BrowserLocationEnv = {
    read: () => current,
    push: (href, state) => {
      calls.push({ kind: "push", href, state });
      current = locationOf(href, state);
    },
    replace: (href, state) => {
      calls.push({ kind: "replace", href, state });
      current = locationOf(href, state);
    },
    observe: (onChange) => {
      observers.add(onChange);
      return () => observers.delete(onChange);
    },
  };
  return {
    env,
    calls,
    /** Simulate a browser-driven change (Back/Forward, manual hash edit). */
    emitExternal(href: string, state: unknown = null) {
      current = locationOf(href, state);
      for (const onChange of observers) onChange();
    },
  };
}

describe("browser location store", () => {
  test("navigateTo pushes by default and publishes the new snapshot", () => {
    const { env, calls } = createFakeEnv("/");
    const store = createBrowserLocationStore(env);
    const seen: BrowserLocationState[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));

    store.navigateTo("/sessions?s=1#frag");

    expect(calls).toEqual([{ kind: "push", href: "/sessions?s=1#frag", state: null }]);
    expect(store.getSnapshot()).toEqual(locationOf("/sessions?s=1#frag"));
    expect(seen).toHaveLength(1);
  });

  test("navigateTo with replace swaps the current entry", () => {
    const { env, calls } = createFakeEnv("/fleet");
    const store = createBrowserLocationStore(env);
    store.navigateTo("/mesh", { replace: true });
    expect(calls).toEqual([{ kind: "replace", href: "/mesh", state: null }]);
    expect(store.getSnapshot().pathname).toBe("/mesh");
  });

  test("history entry state carries forward unless overridden", () => {
    const { env, calls } = createFakeEnv("/");
    const store = createBrowserLocationStore(env);
    store.navigateTo("/a", { state: { returnTo: "home" } });
    store.navigateTo("/b");
    store.navigateTo("/c", { state: null });
    expect(calls.map((c) => c.state)).toEqual([{ returnTo: "home" }, { returnTo: "home" }, null]);
  });

  test("back/forward-style external changes update the snapshot and notify", () => {
    const { env, emitExternal } = createFakeEnv("/");
    const store = createBrowserLocationStore(env);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().pathname));

    store.navigateTo("/sessions");
    store.navigateTo("/mesh");
    emitExternal("/sessions"); // Back
    emitExternal("/mesh"); // Forward

    expect(seen).toEqual(["/sessions", "/mesh", "/sessions", "/mesh"]);
  });

  test("identical locations do not republish", () => {
    const { env, emitExternal } = createFakeEnv("/");
    const store = createBrowserLocationStore(env);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    emitExternal("/");
    store.navigateTo("/sessions");
    emitExternal("/sessions");
    expect(notified).toBe(1);
  });

  test("unsubscribed listeners stop receiving updates", () => {
    const { env } = createFakeEnv("/");
    const store = createBrowserLocationStore(env);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.navigateTo("/a");
    unsubscribe();
    store.navigateTo("/b");
    expect(notified).toBe(1);
  });
});

/* ── scroll memory keys ── */

describe("routeKey scroll ownership", () => {
  test("distinct destinations get distinct scroll keys", () => {
    expect(routeKey({ view: "sessions" })).not.toBe(routeKey({ view: "sessions", sessionId: "s-1" }));
    expect(routeKey({ view: "mesh" })).not.toBe(routeKey({ view: "activity" }));
    expect(routeKey({ view: "ops", mode: "tail" })).not.toBe(routeKey({ view: "ops", mode: "lanes" }));
  });

  test("machine scope variants scroll independently", () => {
    expect(routeKey({ view: "inbox", machineId: "node-a" }))
      .not.toBe(routeKey({ view: "inbox", machineId: "node-b" }));
    expect(routeKey({ view: "inbox" })).not.toBe(routeKey({ view: "inbox", machineId: "node-a" }));
    expect(routeKey({ view: "follow", workId: "work-1", machineId: "node-a" }))
      .not.toBe(routeKey({ view: "follow", workId: "work-1", machineId: "node-b" }));
  });

  test("identical routes share a scroll key", () => {
    expect(routeKey({ view: "sessions", sessionId: "s-1" }))
      .toBe(routeKey({ view: "sessions", sessionId: "s-1" }));
  });
});

/* ── canonicalization policy ── */

describe("canonicalHrefForRoute", () => {
  test("retains the current hash while rewriting the path", () => {
    expect(canonicalHrefForRoute("/scout/sessions/s-1", "", "msg-1"))
      .toBe("/scope/sessions/s-1#msg-1");
  });

  test("keeps whitelisted flags but drops route-local params", () => {
    expect(canonicalHrefForRoute("/agents-v2/hudson.main", "?ffBundle=max-pro&tab=observe", ""))
      .toBe("/agents/hudson.main?tab=observe&ffBundle=max-pro");
    expect(canonicalHrefForRoute("/projects", "?layout=grid&ffBundle=max-pro", ""))
      .toBe("/projects?ffBundle=max-pro");
  });

  test("rewrites the legacy harnesses path without losing machine scope", () => {
    expect(canonicalHrefForRoute("/harnesses", "?machineId=node-b", ""))
      .toBe("/providers?machineId=node-b");
  });

  test("embed paths are never canonicalized", () => {
    expect(canonicalHrefForRoute("/embed/terminal", "?route=/terminal", "")).toBeNull();
    expect(canonicalHrefForRoute("/ops/lanes/embed", "?profile=macos.lanes", "")).toBeNull();
  });
});

/* ── SCO-082 Phase B: selection params + returnTo ── */

describe("Phase B selection state in the URL", () => {
  test("broker attemptId round-trips and does not leak off dispatch", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/dispatch?attempt=att-1");
    expect(route).toEqual({ view: "broker", attemptId: "att-1" });
    expect(routePath(route)).toBe("/dispatch?attempt=att-1");

    const away = planNavigation(
      { pathname: "/dispatch", searchStr: "?attempt=att-1" },
      { view: "sessions" },
    );
    expect(away.href).toBe("/sessions");
    expect(away.href).not.toContain("attempt=");
  });

  test("dispatch filter round-trips with selection state", () => {
    const route = routeFromUrl(
      "http://127.0.0.1:43120/dispatch?filter=failed&attempt=att-1",
    );
    expect(route).toEqual({ view: "broker", attemptId: "att-1", filter: "failed" });
    expect(routePath(route)).toBe("/dispatch?attempt=att-1&filter=failed");
    expect(routeFromUrl("http://127.0.0.1:43120/dispatch?filter=all")).toEqual({
      view: "broker",
    });
  });

  test("search hitId round-trips and does not leak off search", () => {
    const route = routeFromUrl("http://127.0.0.1:43120/search?hit=hit-9");
    expect(route).toEqual({ view: "search", hitId: "hit-9" });
    expect(routePath(route)).toBe("/search?hit=hit-9");

    const away = planNavigation(
      { pathname: "/search", searchStr: "?hit=hit-9" },
      { view: "inbox" },
    );
    expect(away.href).toBe("/");
    expect(away.href).not.toContain("hit=");
  });

  test("settings sections round-trip", () => {
    expect(routeFromUrl("http://127.0.0.1:43120/settings")).toEqual({ view: "settings" });
    expect(routeFromUrl("http://127.0.0.1:43120/settings/appearance")).toEqual({
      view: "settings",
      section: "appearance",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/settings/operator")).toEqual({
      view: "settings",
      section: "operator",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/settings/comms")).toEqual({
      view: "settings",
      section: "comms",
    });
    expect(routeFromUrl("http://127.0.0.1:43120/settings/communications")).toEqual({
      view: "settings",
      section: "comms",
    });
    expect(routePath({ view: "settings", section: "voice" })).toBe("/settings/voice");
    expect(routeFromUrl("http://127.0.0.1:43120/settings/about")).toEqual({
      view: "settings",
      section: "about",
    });
    expect(routePath({ view: "settings", section: "about" })).toBe("/settings/about");
    expect(routeFromUrl("http://127.0.0.1:43120/voice")).toEqual({ view: "voice" });
    expect(routePath({ view: "voice" })).toBe("/voice");
    expect(routePath({ view: "settings", section: "pairing" })).toBe("/settings/pairing");
    expect(routePath({ view: "settings", section: "agents" })).toBe("/settings/agents");
  });

  test("returnTo is readable from history state and deep-link falls back to null", () => {
    const origin: Route = { view: "mesh" };
    expect(readReturnToFromState({ returnTo: origin, returnUseHistory: true })).toEqual(origin);
    expect(shouldUseHistoryBack({ returnTo: origin, returnUseHistory: true })).toBe(true);
    expect(readReturnToFromState(null)).toBeNull();
    expect(readReturnToFromState({})).toBeNull();
    expect(shouldUseHistoryBack({})).toBe(false);
  });

  test("history entry state carries returnTo through the location store", () => {
    const { env, calls } = createFakeEnv("/mesh");
    const store = createBrowserLocationStore(env);
    const returnTo: Route = { view: "mesh" };
    store.navigateTo("/agents/hudson.main", {
      state: { returnTo, returnUseHistory: true },
    });
    expect(calls.at(-1)?.state).toEqual({ returnTo, returnUseHistory: true });
    expect(readReturnToFromState(store.getSnapshot().state)).toEqual(returnTo);
  });

  test("returnTo does not propagate to a subsequent plain navigate", () => {
    const origin: Route = { view: "mesh" };
    // openAgent-style navigate: entry state records the origin.
    const detailEntry = buildNavigateState(null, { returnTo: origin });
    expect(readReturnToFromState(detailEntry)).toEqual(origin);
    expect(shouldUseHistoryBack(detailEntry)).toBe(true);

    // A later unrelated navigate from that entry must NOT inherit the origin,
    // or BackToPicker would history.back() toward the wrong entry.
    const nextEntry = buildNavigateState(detailEntry, {});
    expect(readReturnToFromState(nextEntry)).toBeNull();
    expect(shouldUseHistoryBack(nextEntry)).toBe(false);

    // replace keeps the same history entry, so the origin stays accurate.
    const replaced = buildNavigateState(detailEntry, { replace: true });
    expect(readReturnToFromState(replaced)).toEqual(origin);
    expect(shouldUseHistoryBack(replaced)).toBe(true);

    // Explicit state passes through untouched.
    const explicit = buildNavigateState(detailEntry, { state: { keep: 1 } });
    expect(explicit).toEqual({ keep: 1 });

    // Unrelated custom keys still carry forward; only entry-scoped keys strip.
    const carried = buildNavigateState(
      { returnTo: origin, returnUseHistory: true, scroll: 42 },
      {},
    );
    expect(carried).toEqual({ scroll: 42 });
  });

  test("settings entry marker round-trips and does not propagate", () => {
    const marked = buildNavigateState(null, { state: { settingsEntry: true } });
    expect(isSettingsHistoryEntry(marked)).toBe(true);
    // Section rail replace keeps the marker (same entry).
    const sectionEntry = buildNavigateState(marked, { replace: true });
    expect(isSettingsHistoryEntry(sectionEntry)).toBe(true);
    // A plain navigate away strips the marker like returnTo.
    const away = buildNavigateState(sectionEntry, {});
    expect(isSettingsHistoryEntry(away)).toBe(false);
    expect(isSettingsHistoryEntry(null)).toBe(false);
    expect(isSettingsHistoryEntry({})).toBe(false);
  });
});
