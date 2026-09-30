import { beforeEach, describe, expect, test } from "bun:test";

import type { HerdrPaneProjection, HerdrSessionTopology } from "@openscout/protocol";

import {
  collectHerdrContinuationStops,
  formatContinuationAttention,
  herdrBlockedClaudePanes,
  resetHerdrContinuationActuation,
  type HerdrContinuationAuditRecord,
} from "./herdr-continuation.ts";

const BASH_PERMISSION = `
 Bash command

   bun test packages/web/server

 Permission rule Bash(bun:*) requires confirmation for this command.

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for this command
   3. No

 Esc to cancel · Tab to amend
`;

const CURL_PERMISSION = `
 Bash command

   curl -sS https://example.com

 Permission rule Bash(curl:*) requires confirmation for this command.

 Do you want to proceed?
   1. Yes
 ❯ 2. No

 Esc to cancel   Tab to amend
`;

function pane(overrides: Partial<HerdrPaneProjection> = {}): HerdrPaneProjection {
  return {
    paneId: "w1:p2",
    terminalId: "term-p2",
    tabId: "w1:t1",
    workspaceId: "w1",
    label: "claude · openscout",
    agent: "claude",
    agentStatus: "blocked",
    agentSession: null,
    cwd: "/Users/art/dev/openscout",
    foregroundCwd: "/Users/art/dev/openscout",
    focused: true,
    scroll: null,
    ...overrides,
  };
}

function topology(panes: HerdrPaneProjection[]): HerdrSessionTopology {
  return {
    session: "default",
    running: true,
    observedAt: 1,
    workspaces: [{
      workspaceId: "w1",
      label: "main",
      number: 1,
      focused: true,
      activeTabId: "w1:t1",
      agentStatus: "blocked",
      tabs: [{
        tabId: "w1:t1",
        workspaceId: "w1",
        label: "build",
        number: 1,
        focused: true,
        agentStatus: "blocked",
        panes,
        layout: null,
      }],
    }],
  };
}

let audits: HerdrContinuationAuditRecord[] = [];

const host = {
  listSessions: async () => [{ name: "default", running: true }],
  readTopology: async () => topology([pane()]),
  audit: (record: HerdrContinuationAuditRecord) => {
    audits.push(record);
  },
};

const WORKSPACE_GRANT = () => ({ level: "workspace" as const, source: "test", allowModel: true });

beforeEach(() => {
  resetHerdrContinuationActuation();
  audits = [];
});

describe("herdrBlockedClaudePanes", () => {
  test("keeps live blocked Claude panes and ignores shells and working agents", () => {
    expect(herdrBlockedClaudePanes(topology([
      pane(),
      pane({ paneId: "w1:p3", agent: "codex", agentStatus: "blocked" }),
      pane({ paneId: "w1:p4", agent: "claude", agentStatus: "working" }),
      pane({ paneId: "w1:p5", agent: null, agentStatus: "blocked" }),
    ])).map((entry) => entry.paneId)).toEqual(["w1:p2"]);
  });

  test("does not scrape a stopped session", () => {
    expect(herdrBlockedClaudePanes({ ...topology([pane()]), running: false })).toEqual([]);
  });
});

describe("collectHerdrContinuationStops", () => {
  test("shadow-notifies a blocked Claude pane and records would-continue for workspace tests", async () => {
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      policyFor: WORKSPACE_GRANT,
      now: 1_700_000_000_000,
      agents: [{
        id: "claude.openscout",
        name: "claude · openscout",
        harness: "claude",
        cwd: "/Users/art/dev/openscout",
        terminalSurface: { backend: "herdr", sessionName: "default", paneId: "w1:p2" },
      }],
    });

    expect(stops).toEqual([
      expect.objectContaining({
        id: "herdr-continuation:default:term-p2",
        agentId: "claude.openscout",
        sourceLabel: "Herdr continuation (shadow)",
        summary: "Would continue · bun test packages/web/server",
        verdict: expect.objectContaining({
          act: "continue",
          keys: ["enter"],
          shadow: true,
        }),
      }),
    ]);
  });

  test("without sendKeys, does not send and still notifies when the verdict is continue", async () => {
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      policyFor: WORKSPACE_GRANT,
    });
    expect(stops[0]?.verdict.act).toBe("continue");
    expect(stops[0]?.verdict.keys).toEqual(["enter"]);
    expect(stops[0]?.sourceLabel).toContain("shadow");
  });

  test("sends the recorded Yes keys after a confirming re-read and drops attention", async () => {
    const sent: Array<{ session: string; target: string; keys: readonly string[] }> = [];
    let captures = 0;
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => {
        captures += 1;
        return BASH_PERMISSION;
      },
      sendKeys: async (session, target, keys) => {
        sent.push({ session, target, keys });
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(captures).toBe(2);
    expect(sent).toEqual([{ session: "default", target: "term-p2", keys: ["enter"] }]);
    expect(stops).toEqual([]);
  });

  test("does not send keys for a workspace network prompt", async () => {
    const sent: unknown[] = [];
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => CURL_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(sent).toEqual([]);
    expect(stops[0]).toMatchObject({
      summary: "curl -sS https://example.com",
      sourceLabel: "Herdr continuation",
      verdict: { act: "notify", keys: null, shadow: false },
    });
  });

  test("does not send when the confirming read is a different command", async () => {
    const sent: unknown[] = [];
    const bodies = [BASH_PERMISSION, CURL_PERMISSION];
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => bodies.shift() ?? CURL_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(sent).toEqual([]);
    expect(stops[0]?.verdict.act).toBe("notify");
    expect(stops[0]?.verdict.command).toBe("curl -sS https://example.com");
  });

  test("notifies when sendKeys fails", async () => {
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        throw new Error("herdr refused");
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(stops[0]?.summary).toBe("Could not continue · bun test packages/web/server");
  });

  test("does not send the same command twice within the actuation window", async () => {
    const sent: unknown[] = [];
    const sendKeys = async () => {
      sent.push("sent");
    };
    await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      sendKeys,
      policyFor: WORKSPACE_GRANT,
      now: 1_000,
    });
    await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      sendKeys,
      policyFor: WORKSPACE_GRANT,
      now: 2_000,
    });
    expect(sent).toHaveLength(1);
  });

  test("skips stale snapshots even when Herdr still says blocked", async () => {
    const sent: unknown[] = [];
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => `${BASH_PERMISSION}\n❯ `,
      sendKeys: async () => {
        sent.push("sent");
      },
    });
    expect(sent).toEqual([]);
    expect(stops).toEqual([]);
  });

  test("sends the model allow index on an unparsed live dialog", async () => {
    const sent: Array<{ keys: readonly string[] }> = [];
    const unparsed = `
 Bash command

   bun test packages/web/server

 Do you want to proceed?
 ❯ 1) Yes
   2) No

 Esc to cancel · Tab to amend
`;
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => unparsed,
      sendKeys: async (_session, _target, keys) => {
        sent.push({ keys });
      },
      model: async () => ({
        kind: "permission",
        command: "bun test packages/web/server",
        risk: "workspace",
        allowIndex: 1,
        confidence: "high",
        reason: "yes/no",
      }),
      policyFor: WORKSPACE_GRANT,
    });
    expect(sent).toEqual([{ keys: ["1"] }]);
    expect(stops).toEqual([]);
  });

  test("fail-closed: missing herdr is an empty list, not a throw", async () => {
    const stops = await collectHerdrContinuationStops({
      listSessions: async () => {
        throw new Error("herdr: command not found");
      },
      readTopology: async () => topology([pane()]),
      capture: async () => BASH_PERMISSION,
    });
    expect(stops).toEqual([]);
  });
});

describe("continuation opt-in gate", () => {
  test("with no grant, never sends keys even when sendKeys and audit are wired", async () => {
    const sent: unknown[] = [];
    let modelCalls = 0;
    const stops = await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      model: async () => {
        modelCalls += 1;
        return null;
      },
    });
    expect(sent).toEqual([]);
    expect(modelCalls).toBe(0);
    expect(audits).toEqual([]);
    expect(stops[0]?.verdict).toMatchObject({ act: "notify", policy: "ask", keys: null });
  });

  test("an ask grant never consults the model on an unparsed dialog", async () => {
    let modelCalls = 0;
    await collectHerdrContinuationStops({
      ...host,
      capture: async () => " Do you want to proceed?\n\n Esc to cancel · Tab to amend\n",
      sendKeys: async () => {},
      model: async () => {
        modelCalls += 1;
        return null;
      },
      policyFor: () => ({ level: "ask", source: "test", allowModel: true }),
    });
    expect(modelCalls).toBe(0);
  });

  test("a grant without allowModel keeps pane text away from the model", async () => {
    let modelCalls = 0;
    const sent: unknown[] = [];
    await collectHerdrContinuationStops({
      ...host,
      capture: async () => " Do you want to proceed?\n\n Esc to cancel · Tab to amend\n",
      sendKeys: async () => {
        sent.push("sent");
      },
      model: async () => {
        modelCalls += 1;
        return null;
      },
      policyFor: () => ({ level: "silent", source: "test", allowModel: false }),
    });
    expect(modelCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  test("without an audit sink, stays shadow and sends nothing", async () => {
    const sent: unknown[] = [];
    const stops = await collectHerdrContinuationStops({
      listSessions: host.listSessions,
      readTopology: host.readTopology,
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(sent).toEqual([]);
    expect(stops[0]?.verdict.shadow).toBe(true);
  });

  test("audits the attempt before sending and the result after", async () => {
    const order: string[] = [];
    await collectHerdrContinuationStops({
      ...host,
      audit: (record) => {
        order.push(`audit:${record.outcome}`);
        audits.push(record);
      },
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        order.push("send");
      },
      policyFor: () => ({ level: "workspace", source: "project:/Users/art/dev/openscout", allowModel: false }),
    });
    expect(order).toEqual(["audit:attempt", "send", "audit:sent"]);
    expect(audits[0]).toMatchObject({
      herdrSession: "default",
      paneId: "term-p2",
      level: "workspace",
      grant: "project:/Users/art/dev/openscout",
      command: "bun test packages/web/server",
      keys: ["enter"],
    });
  });

  test("an audit write failure blocks the send", async () => {
    const sent: unknown[] = [];
    const stops = await collectHerdrContinuationStops({
      ...host,
      audit: () => {
        throw new Error("disk full");
      },
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(sent).toEqual([]);
    expect(stops[0]?.summary).toBe("Could not continue · bun test packages/web/server");
  });

  test("a prompt another process claimed is not answered twice", async () => {
    const sent: unknown[] = [];
    await collectHerdrContinuationStops({
      ...host,
      claim: () => false,
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(sent).toEqual([]);
    expect(audits.map((record) => record.outcome)).toEqual(["claimed-elsewhere"]);
  });

  test("concurrent snapshots in one process send once", async () => {
    const sent: unknown[] = [];
    const run = () => collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: WORKSPACE_GRANT,
    });
    await Promise.all([run(), run()]);
    expect(sent).toHaveLength(1);
  });

  test("a grant revoked between the first read and the send stops the send", async () => {
    const sent: unknown[] = [];
    let lookups = 0;
    await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: () => {
        lookups += 1;
        return lookups === 1
          ? { level: "workspace", source: "project:/Users/art/dev/openscout", allowModel: false }
          : { level: "ask", source: "default", allowModel: false };
      },
    });
    expect(lookups).toBe(2);
    expect(sent).toEqual([]);
    expect(audits.map((record) => record.outcome)).toEqual(["mismatch"]);
  });

  test("a pane that stopped blocking or moved out of the project is not answered", async () => {
    const sent: unknown[] = [];
    let reads = 0;
    await collectHerdrContinuationStops({
      ...host,
      readTopology: async () => {
        reads += 1;
        return reads === 1 ? topology([pane()]) : topology([pane({ agentStatus: "working" })]);
      },
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: WORKSPACE_GRANT,
    });
    expect(sent).toEqual([]);

    reads = 0;
    resetHerdrContinuationActuation();
    await collectHerdrContinuationStops({
      ...host,
      readTopology: async () => {
        reads += 1;
        return reads === 1 ? topology([pane()]) : topology([pane({ foregroundCwd: "/tmp/elsewhere" })]);
      },
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: (_session, livePane) => livePane.foregroundCwd === "/Users/art/dev/openscout"
        ? { level: "workspace", source: "project:/Users/art/dev/openscout", allowModel: false }
        : { level: "ask", source: "default", allowModel: false },
    });
    expect(sent).toEqual([]);
  });

  test("a throwing policy lookup falls back to ask", async () => {
    const sent: unknown[] = [];
    await collectHerdrContinuationStops({
      ...host,
      capture: async () => BASH_PERMISSION,
      sendKeys: async () => {
        sent.push("sent");
      },
      policyFor: () => {
        throw new Error("bad grant file");
      },
    });
    expect(sent).toEqual([]);
  });
});

describe("formatContinuationAttention", () => {
  test("leads with the would-be act so shadow logs are comparable", () => {
    expect(formatContinuationAttention({
      kind: "permission",
      live: true,
      policyFor: WORKSPACE_GRANT,
      risk: "network",
      act: "notify",
      keys: null,
      command: "curl https://example.com",
      reason: "workspace does not auto-continue network",
      source: "rules",
      shadow: true,
    }).summary).toBe("Would notify · curl https://example.com");
  });
});
