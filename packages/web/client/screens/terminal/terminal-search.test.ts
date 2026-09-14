import { expect, test } from "bun:test";
import {
  markMatches,
  parseTerminalQuery,
  screenExcerpt,
  searchTerminalTargets,
  terminalSearchHighlight,
  terminalSearchNeedsDelivery,
  terminalSearchNeedsPanes,
  terminalSearchNeedsScreens,
  terminalSearchTargetOfAgent,
  type TerminalSearchTarget,
} from "./terminal-search.ts";
import type { Agent } from "../../lib/types.ts";

const NOW = 1_760_000_000_000;

function target(overrides: Partial<TerminalSearchTarget> & { id: string; name: string }): TerminalSearchTarget {
  return {
    project: "openscout",
    cwd: "/Users/art/dev/openscout",
    harness: "claude",
    backend: "tmux",
    command: "",
    condition: "detached",
    kind: "session",
    live: true,
    activityAt: NOW - 60_000,
    ...overrides,
  };
}

const FLEET: TerminalSearchTarget[] = [
  target({ id: "a", name: "openscout", command: "bun test" }),
  target({ id: "b", name: "deploy", harness: "codex", command: "bun run build", activityAt: NOW - 3_600_000 }),
  target({ id: "c", name: "openscout-devtools", live: false, condition: "exited", activityAt: NOW - 86_400_000 }),
  target({ id: "d", name: "woolf", project: "project-woolf", cwd: "/Users/art/dev/woolf", backend: "herdr", kind: "multiplexer" }),
];

const entries = FLEET.map((entry) => ({ target: entry, item: entry.id }));
const ids = (query: string) => searchTerminalTargets(entries, query, NOW).map((hit) => hit.item);

test("a query is a ranked search, not a substring filter", () => {
  // Three of these live under /Users/art/dev/openscout, so a blob filter kept
  // them all in whatever order the list had. The one NAMED openscout has to
  // come first, and the one that matches only in its directory still comes
  // back — behind the rows that match by name.
  expect(ids("openscout")).toEqual(["a", "c", "b"]);
});

test("a name beats a directory, and a word start beats a buried substring", () => {
  const hits = searchTerminalTargets(entries, "dev", NOW);
  // "openscout-devtools" starts a word with dev; the others only have it deep
  // inside /Users/art/dev/...
  expect(hits[0]!.item).toBe("c");
  expect(hits[0]!.matchedOn[0]).toBe("name");
});

test("fields can be named, and aliases are the ones people type", () => {
  expect(ids("harness:codex")).toEqual(["b"]);
  expect(ids("agent:codex")).toEqual(["b"]);
  expect(ids("in:project-woolf")).toEqual(["d"]);
  expect(ids("host:herdr")).toEqual(["d"]);
  expect(ids("cmd:build")).toEqual(["b"]);
});

test("every clause has to land — adding a word narrows", () => {
  expect(ids("openscout claude")).toEqual(["a", "c"]);
  // "codex" lands on b's harness and "openscout" on its cwd — both clauses do
  // hold, and b is the answer. A clause nothing satisfies empties the result.
  expect(ids("openscout codex")).toEqual(["b"]);
  expect(ids("woolf codex")).toEqual([]);
  // Both run bun and both sit under openscout, so both survive — but a matches
  // "openscout" in its NAME, so it is the one on top.
  expect(ids("bun openscout")).toEqual(["a", "b"]);
});

test("a minus takes rows out", () => {
  expect(ids("openscout -devtools")).not.toContain("c");
  expect(ids("-harness:codex")).not.toContain("b");
});

test("state is asked with is:, including states only the host words", () => {
  expect(ids("is:live").sort()).toEqual(["a", "b", "d"]);
  expect(ids("is:idle")).toEqual(["c"]);
  expect(ids("is:multiplexer")).toEqual(["d"]);
  expect(ids("is:exited")).toEqual(["c"]);
  // Unknown values fall through to the host's own wording rather than erroring.
  expect(ids("is:detached").length).toBe(3);
});

test("quoted values stay whole", () => {
  expect(parseTerminalQuery('cmd:"bun test"')).toEqual([{ field: "command", value: "bun test", negated: false }]);
  expect(ids('cmd:"bun test"')).toEqual(["a"]);
  // Unquoted, the same words are two clauses: a scoped one and a loose one.
  expect(parseTerminalQuery("cmd:bun test")).toEqual([
    { field: "command", value: "bun", negated: false },
    { field: null, value: "test", negated: false },
  ]);
});

test("a half-typed scope does not empty the list under your fingers", () => {
  expect(parseTerminalQuery("project:")).toEqual([]);
  expect(ids("project:").length).toBe(FLEET.length);
  // An unknown scope narrows oddly rather than matching everything.
  expect(parseTerminalQuery("nope:x")).toEqual([{ field: null, value: "nope:x", negated: false }]);
});

test("an empty query is already the list you usually want", () => {
  const order = ids("");
  expect(order[order.length - 1]).toBe("c");
  expect(order.slice(0, 3)).not.toContain("c");
});

test("the screen is searchable, and the hit says which line it was", () => {
  const withScreen = [
    { target: target({ id: "a", name: "openscout", screen: "$ bun test\n 3 fail\nmigration 0004 failed: column exists" }), item: "a" },
    { target: target({ id: "b", name: "deploy", screen: "$ ls\nREADME.md" }), item: "b" },
  ];
  const hits = searchTerminalTargets(withScreen, "migration", NOW);
  expect(hits.map((hit) => hit.item)).toEqual(["a"]);
  expect(hits[0]!.excerpt).toBe("migration 0004 failed: column exists");
  expect(hits[0]!.matchedOn).toContain("screen");
});

test("screens are only fetched when the query actually asks for them", () => {
  expect(terminalSearchNeedsScreens(parseTerminalQuery("openscout"))).toBe(false);
  expect(terminalSearchNeedsScreens(parseTerminalQuery("screen:migration"))).toBe(true);
  expect(terminalSearchNeedsScreens(parseTerminalQuery("output:error"))).toBe(true);
  // A target with no capture yet is not a match, and is not an error either.
  expect(searchTerminalTargets(entries, "screen:anything", NOW)).toEqual([]);
});

test("an excerpt keeps the match in frame on a long line", () => {
  const line = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
  const excerpt = screenExcerpt(line, "needle", 60)!;
  expect(excerpt).toContain("needle");
  expect(excerpt.length).toBeLessThanOrEqual(64);
  expect(excerpt.startsWith("…")).toBe(true);
  expect(screenExcerpt("no match here", "needle")).toBeNull();
});

test("recency separates equal matches without overruling the name", () => {
  const older = target({ id: "old", name: "build", activityAt: NOW - 30 * 86_400_000 });
  const newer = target({ id: "new", name: "build", activityAt: NOW - 30_000 });
  const named = target({ id: "named", name: "buildbot", activityAt: NOW - 30 * 86_400_000 });
  const ranked = searchTerminalTargets(
    [older, newer, named].map((entry) => ({ target: entry, item: entry.id })),
    "build",
    NOW,
  );
  // Same field, same strength → the fresher one wins.
  expect(ranked.map((hit) => hit.item).slice(0, 2)).toEqual(["new", "old"]);
  // But a whole-name match outranks a stale prefix match, not the other way.
  expect(ranked[2]!.item).toBe("named");
});

test("ordering is stable, so the list does not shuffle between keystrokes", () => {
  const twins = ["one", "two", "three"].map((name) =>
    target({ id: name, name, activityAt: NOW - 1_000, command: "bun test" }));
  const run = () => searchTerminalTargets(twins.map((entry) => ({ target: entry, item: entry.id })), "bun", NOW)
    .map((hit) => hit.item);
  expect(run()).toEqual(run());
  expect(run()).toEqual(["one", "three", "two"]);
});

test("a hit can say what to mark: bare words on the row, screen: words on the quoted line", () => {
  const highlight = terminalSearchHighlight(parseTerminalQuery("hudson screen:migration -exited harness:claude"));
  expect(highlight).toEqual({ text: ["hudson"], screen: ["migration"] });
});

test("marking is case-insensitive and keeps the text whole", () => {
  const runs = markMatches("~/dev/Hudson/apps", ["hudson"]);
  expect(runs.map((run) => run.text).join("")).toBe("~/dev/Hudson/apps");
  expect(runs.filter((run) => run.match).map((run) => run.text)).toEqual(["Hudson"]);
  expect(markMatches("plain", [])).toEqual([{ text: "plain", match: false }]);
  expect(markMatches("a.b", ["."]).filter((run) => run.match)).toEqual([{ text: ".", match: true }]);
});


test("an agent with no terminal on the host still searches by name, handle and harness", () => {
  const agent = {
    id: "grok-reviewer.main",
    name: "Grok Reviewer",
    handle: "grok-reviewer",
    harness: "grok",
    state: "offline",
    project: null,
    projectRoot: "/Users/art/dev/openscout",
    cwd: null,
    transport: "tmux",
    updatedAt: NOW - 3_600_000,
  } as unknown as Agent;
  const own = terminalSearchTargetOfAgent(agent);
  expect(own.id).toBe("agent:grok-reviewer.main");
  expect(own.kind).toBe("agent");
  const fleet = [...entries, { target: own, item: own.id }];
  expect(searchTerminalTargets(fleet, "grok").map((hit) => hit.item)).toEqual(["agent:grok-reviewer.main"]);
  expect(searchTerminalTargets(fleet, "by:reviewer").map((hit) => hit.item)).toEqual(["agent:grok-reviewer.main"]);
  expect(searchTerminalTargets(fleet, "harness:grok is:agent").map((hit) => hit.item)).toEqual(["agent:grok-reviewer.main"]);
});

test("a terminal an agent owns answers to the agent's name as well as its own", () => {
  const owned = target({ id: "e", name: "relay-main-tmux", owner: "Grok Reviewer @grok-reviewer" });
  const hits = searchTerminalTargets([...entries, { target: owned, item: "e" }], "reviewer");
  expect(hits.map((hit) => hit.item)).toEqual(["e"]);
  expect(hits[0]!.matchedOn[0]).toBe("owner");
});

test("a multiplexer is named by its backend, whichever list found the row", () => {
  // `is:tmux` used to answer only for rows discovered as multiplexer setups, so
  // an agent's own surface running under tmux was not a tmux terminal.
  expect(ids("is:tmux").sort()).toEqual(["a", "b", "c"]);
  expect(ids("is:herdr")).toEqual(["d"]);
  expect(ids("is:multiplexer")).toEqual(["d"]);
  // The backend answers to the word an operator would reach for.
  expect(ids("mux:herdr")).toEqual(["d"]);
  expect(ids("multiplexer:herdr")).toEqual(["d"]);
});

test("an owning agent lends its branch, model, role and node to the row", () => {
  const agent = {
    id: "hudson.main",
    name: "Hudson",
    handle: "hudson",
    harness: "claude",
    agentClass: "worker",
    role: "reviewer",
    model: "opus",
    branch: "codex/current-product-work",
    homeNodeName: "arts-mini",
    authorityNodeName: "arts-mini",
    state: "online",
    project: "openscout",
    projectRoot: "/Users/art/dev/openscout",
    cwd: null,
    transport: "tmux",
    updatedAt: NOW - 60_000,
  } as unknown as Agent;
  const own = terminalSearchTargetOfAgent(agent);
  expect(own.branch).toBe("codex/current-product-work");
  expect(own.role).toBe("reviewer");
  // One node name, not the same one twice.
  expect(own.node).toBe("arts-mini");
  const fleet = [...entries, { target: own, item: own.id }];
  expect(searchTerminalTargets(fleet, "branch:codex").map((hit) => hit.item)).toEqual(["agent:hudson.main"]);
  expect(searchTerminalTargets(fleet, "model:opus").map((hit) => hit.item)).toEqual(["agent:hudson.main"]);
  expect(searchTerminalTargets(fleet, "role:reviewer").map((hit) => hit.item)).toEqual(["agent:hudson.main"]);
  expect(searchTerminalTargets(fleet, "node:arts-mini").map((hit) => hit.item)).toEqual(["agent:hudson.main"]);
});

test("role falls back to the registry's class when the agent has no role of its own", () => {
  const agent = {
    id: "plain.main",
    name: "Plain",
    agentClass: "relay",
    state: "online",
    updatedAt: NOW,
  } as unknown as Agent;
  expect(terminalSearchTargetOfAgent(agent).role).toBe("relay");
});

test("what the broker delivered is searchable, scoped and bare", () => {
  const agent = {
    id: "courier.main",
    name: "Courier",
    state: "online",
    updatedAt: NOW - 60_000,
    brokerActivity: [
      { id: "1", kind: "message", at: NOW - 120_000, state: "delivered", summary: "migration 0004 needs a decision", conversationId: null },
      { id: "2", kind: "invocation", at: NOW - 60_000, state: "failed", summary: "publish the release notes", conversationId: null },
    ],
  } as unknown as Agent;
  const own = terminalSearchTargetOfAgent(agent);
  const fleet = [...entries, { target: own, item: own.id }];
  expect(searchTerminalTargets(fleet, "msg:migration").map((hit) => hit.item)).toEqual(["agent:courier.main"]);
  expect(searchTerminalTargets(fleet, "delivery:failed").map((hit) => hit.item)).toEqual(["agent:courier.main"]);
  const bare = searchTerminalTargets(fleet, "release notes");
  expect(bare.map((hit) => hit.item)).toEqual(["agent:courier.main"]);
  expect(bare[0]!.matchedOn).toContain("delivery");
  // Each event is its own line, so a match cannot be assembled across two.
  expect(searchTerminalTargets(fleet, '"decision publish"')).toEqual([]);
});

test("an agent whose payload came without broker context simply does not match delivery", () => {
  const agent = { id: "quiet.main", name: "Quiet", state: "online", updatedAt: NOW } as unknown as Agent;
  const own = terminalSearchTargetOfAgent(agent);
  expect(own.delivery).toBe("");
  expect(searchTerminalTargets([{ target: own, item: own.id }], "msg:anything")).toEqual([]);
});

test("panes are asked for, never assumed — the read is per query like a screen capture", () => {
  expect(terminalSearchNeedsPanes(parseTerminalQuery("woolf"))).toBe(false);
  expect(terminalSearchNeedsPanes(parseTerminalQuery("pane:vera"))).toBe(true);
  expect(terminalSearchNeedsPanes(parseTerminalQuery("inside:migrations"))).toBe(true);
});

test("what is inside a session is searchable, and the row says which pane answered", () => {
  const inside = target({
    id: "e",
    name: "mix",
    backend: "herdr",
    kind: "multiplexer",
    panes: [
      "Mix desk 1 › migrations › vera · reviewing 0004 › claude › working",
      "Mix desk 1 › release › shell",
    ].join("\n"),
  });
  const fleet = [...entries, { target: inside, item: "e" }];
  expect(searchTerminalTargets(fleet, "pane:vera", NOW).map((hit) => hit.item)).toEqual(["e"]);
  const hit = searchTerminalTargets(fleet, "pane:0004", NOW)[0]!;
  // The session's own name is no help here; the line it matched is.
  expect(hit.excerpt).toBe("Mix desk 1 › migrations › vera · reviewing 0004 › claude › working");
  expect(hit.excerptField).toBe("panes");
  expect(hit.matchedOn).toContain("panes");
  // One line per pane, so a quoted run cannot straddle two unrelated panes.
  expect(searchTerminalTargets(fleet, '"working Mix desk"', NOW)).toEqual([]);
});

test("a session whose panes were never read does not match, which is not the same as no panes", () => {
  // `d` is a herdr row with no pane text on it — the query did not ask, so the
  // read never happened. It must not be reported as "nothing inside".
  expect(ids("pane:anything")).toEqual([]);
  expect(FLEET.find((entry) => entry.id === "d")!.panes).toBeUndefined();
});

test("a pane word marks the excerpt line, not the row's name", () => {
  expect(terminalSearchHighlight(parseTerminalQuery("pane:vera screen:migration woolf"))).toEqual({
    text: ["woolf"],
    screen: ["vera", "migration"],
  });
});

test("a delivery query is the one that needs the full roster, not the summary one", () => {
  expect(terminalSearchNeedsDelivery(parseTerminalQuery("woolf"))).toBe(false);
  expect(terminalSearchNeedsDelivery(parseTerminalQuery("msg:migration"))).toBe(true);
  expect(terminalSearchNeedsDelivery(parseTerminalQuery("delivery:failed"))).toBe(true);
  // Branch, model and role ride along on the summary, so they ask for nothing.
  expect(terminalSearchNeedsDelivery(parseTerminalQuery("branch:main model:opus"))).toBe(false);
});

test("a delivery hit quotes the message that answered, and says it was a message", () => {
  const agent = {
    id: "courier.main",
    name: "Courier",
    state: "online",
    updatedAt: NOW - 60_000,
    brokerActivity: [
      { id: "1", kind: "message", at: NOW - 120_000, state: null, summary: "migration 0004 needs a decision", conversationId: null },
      { id: "2", kind: "flight", at: NOW - 60_000, state: "failed", summary: "publish the release notes", conversationId: null },
    ],
  } as unknown as Agent;
  const own = terminalSearchTargetOfAgent(agent);
  const hit = searchTerminalTargets([{ target: own, item: own.id }], "msg:decision", NOW)[0]!;
  // Nothing on the row says why it is here; the line it matched does.
  expect(hit.excerpt).toBe("message migration 0004 needs a decision");
  expect(hit.excerptField).toBe("delivery");
});

test("a screen hit outranks a pane hit for the excerpt only when it is the one that matched", () => {
  const both = target({
    id: "f",
    name: "mix",
    backend: "herdr",
    kind: "multiplexer",
    panes: "Mix desk 1 › migrations › claude",
    screen: "error: migration 0004 failed to apply",
  });
  const entry = [{ target: both, item: "f" }];
  expect(searchTerminalTargets(entry, "screen:0004", NOW)[0]!.excerptField).toBe("screen");
  expect(searchTerminalTargets(entry, "pane:migrations", NOW)[0]!.excerptField).toBe("panes");
});
