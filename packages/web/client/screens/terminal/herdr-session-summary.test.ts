import { expect, test } from "bun:test";
import type { HerdrSessionTopology } from "@openscout/protocol";
import { herdrSessionSummary } from "./herdr-session-summary.ts";

test("counts multiple agents of the same harness and keeps workspaces separate from tabs", () => {
  const topology = {
    session: "scout", running: true, observedAt: 1,
    workspaces: [
      { tabs: [
        { panes: [{ agent: "claude" }, { agent: "claude" }, { agent: "claude" }] },
        { panes: [{ agent: "opencode" }] },
        { panes: [{ agent: null }] },
      ] },
      { tabs: [{ panes: [{ agent: "grok" }] }] },
    ],
  } as HerdrSessionTopology;
  expect(herdrSessionSummary(topology)).toBe("2 workspaces · 4 tabs · 6 panes · 5 agents");
  expect(herdrSessionSummary({ ...topology, workspaces: [] })).toBe("0 workspaces · 0 tabs · 0 panes · 0 agents");
});
