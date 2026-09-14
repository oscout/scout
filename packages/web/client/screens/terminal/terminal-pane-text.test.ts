import { expect, test } from "bun:test";

import type { HerdrSessionTopology } from "@openscout/protocol";

import { herdrPaneSearchText } from "./terminal-pane-text.ts";

/**
 * A herdr session is one row in the list and a dozen places to be. What this
 * flattening has to preserve is WHICH place: the desk and tab a pane sits in
 * travel on the pane's own line, so a hit can be shown as the line it matched.
 */

const topology = (workspaces: HerdrSessionTopology["workspaces"]): HerdrSessionTopology => ({
  session: "openscout",
  running: true,
  workspaces,
  observedAt: 0,
});

const pane = (over: Record<string, unknown>) => ({
  paneId: "p1",
  terminalId: null,
  tabId: "t1",
  workspaceId: "w1",
  label: null,
  agent: null,
  agentStatus: "unknown",
  agentSession: null,
  cwd: null,
  foregroundCwd: null,
  focused: false,
  scroll: null,
  ...over,
}) as HerdrSessionTopology["workspaces"][number]["tabs"][number]["panes"][number];

const tab = (over: Record<string, unknown>) => ({
  tabId: "t1",
  workspaceId: "w1",
  label: null,
  number: 1,
  focused: false,
  agentStatus: "unknown",
  panes: [],
  layout: null,
  ...over,
}) as HerdrSessionTopology["workspaces"][number]["tabs"][number];

const workspace = (over: Record<string, unknown>) => ({
  workspaceId: "w1",
  label: null,
  number: 1,
  focused: false,
  activeTabId: null,
  agentStatus: "unknown",
  tabs: [],
  ...over,
}) as HerdrSessionTopology["workspaces"][number];

// Herdr's own labels are full of interpuncts ("OpenScout · Grok + portal"), so
// the level separator has to be something else or the excerpt cannot be read.
test("each pane is one line, carrying the desk and tab it sits in", () => {
  const text = herdrPaneSearchText(topology([
    workspace({
      label: "Mix desk",
      number: 1,
      tabs: [tab({
        label: "migrations",
        panes: [
          pane({ paneId: "p1", label: "vera · reviewing 0004", agent: "claude", agentStatus: "working" }),
          pane({ paneId: "p2", label: null, agent: null }),
        ],
      })],
    }),
  ]));
  expect(text.split("\n")).toEqual([
    "Mix desk 1 › migrations › vera · reviewing 0004 › claude › working",
    "Mix desk 1 › migrations › shell",
  ]);
});

test("a desk or tab herdr only numbered reads as its number, not as an empty gap", () => {
  const text = herdrPaneSearchText(topology([
    workspace({ label: null, number: 2, tabs: [tab({ label: null, number: 3, panes: [pane({ agent: "codex" })] })] }),
  ]));
  expect(text).toBe("2 › 3 › codex");
});

test("a label herdr set to the number itself is not said twice", () => {
  const text = herdrPaneSearchText(topology([
    workspace({ label: "1", number: 1, tabs: [tab({ label: "2", number: 2, panes: [pane({ agent: "claude" })] })] }),
  ]));
  expect(text).toBe("1 › 2 › claude");
});

test("a named tab is not also numbered — every tab has a number, so it distinguishes nothing", () => {
  const text = herdrPaneSearchText(topology([
    workspace({ label: "Mix desk", number: 1, tabs: [tab({ label: "migrations", number: 4, panes: [pane({})] })] }),
  ]));
  expect(text).toBe("Mix desk 1 › migrations › shell");
});

test("an unknown agent status is left unsaid rather than asserted", () => {
  const text = herdrPaneSearchText(topology([
    workspace({ label: "desk", tabs: [tab({ label: "tab", panes: [pane({ agent: "claude", agentStatus: "unknown" })] })] }),
  ]));
  expect(text).toBe("desk 1 › tab › claude");
});

test("a session with no workspaces flattens to nothing at all", () => {
  expect(herdrPaneSearchText(topology([]))).toBe("");
});
