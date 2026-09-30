import { describe, expect, test } from "bun:test";

import type { ScoutAskResult } from "../broker/service.ts";
import { askMobileHarnessSession } from "./ask-session.ts";
import { deliverInPlace, type InPlaceDelivery } from "./deliver-in-place.ts";
import type { ClaudeSessionRecord } from "@openscout/runtime";
import { mobileAskSessionInputSchema } from "../pairing/runtime/bridge/router.ts";

const SOURCE = "4fad8bb9-b4d3-4432-be75-8cfd636e78c0";
const notLive = async (): Promise<InPlaceDelivery> => ({ ok: false, code: "not_live" });
const FORK = "9b1c2d3e-0000-4000-8000-000000000001";

function fakeAsk(result: ScoutAskResult) {
  const calls: Array<Parameters<typeof import("../broker/service.ts").askScoutQuestion>[0]> = [];
  const ask = (async (input) => {
    calls.push(input);
    return result;
  }) as typeof import("../broker/service.ts").askScoutQuestion;
  return { ask, calls };
}

describe("mobile.askSession", () => {
  test("resumes a session nothing holds with an exact-session ask that never forks", async () => {
    const { ask, calls } = fakeAsk({ usedBroker: true, conversationId: "dm.1", messageId: "msg.1", targetSessionId: SOURCE, flight: { id: "flt.1" } as never });
    const result = await askMobileHarnessSession(
      { sessionId: ` ${SOURCE} `, harness: "claude", cwd: "/Users/art/dev/openscout", body: " keep going ", clientMessageId: "c-1" },
      { ask, senderId: "art", deliverInPlace: notLive },
    );
    expect(calls).toEqual([{
      senderId: "art",
      target: { kind: "session_id", sessionId: SOURCE, harness: "claude", forkIfLive: false },
      body: "keep going",
      clientMessageId: "c-1",
      currentDirectory: "/Users/art/dev/openscout",
      source: "scout-mobile",
    }]);
    expect(result).toEqual({ ok: true, mode: "resumed", delivery: "resumed", sessionId: SOURCE, sourceSessionId: SOURCE, conversationId: "dm.1", flightId: "flt.1", messageId: "msg.1" });
  });

  test("reports a fork when the broker delivered to a different session", async () => {
    const { ask } = fakeAsk({ usedBroker: true, conversationId: "dm.1", messageId: "msg.1", targetSessionId: FORK });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "claude", body: "hi" }, { ask, senderId: "art", deliverInPlace: notLive }))
      .toMatchObject({ ok: true, mode: "forked", sessionId: FORK, sourceSessionId: SOURCE });
  });

  test("turns known wake refusals into plain operator messages", async () => {
    for (const [code, fragment] of [
      ["session_unknown", "couldn't find this session"],
      ["session_live_fork_unsupported", "Close it there"],
      ["session_cwd_conflict", "different folder"],
    ] as const) {
      const { ask } = fakeAsk({
        usedBroker: true,
        unresolvedTarget: `session:claude:${SOURCE}`,
        targetDiagnostic: { agentId: `session:claude:${SOURCE}`, state: "unknown", registrationKind: null, projectRoot: null, sessionWakeReason: code, detail: "raw" },
      });
      const result = await askMobileHarnessSession({ sessionId: SOURCE, harness: "claude", body: "hi" }, { ask, senderId: "art", deliverInPlace: notLive });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.message).toContain(fragment);
      }
    }
  });

  test("does not throw for a missing broker, an empty body, or an unexpected failure", async () => {
    const offline = fakeAsk({ usedBroker: false, unresolvedTarget: "x" });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "hi" }, { ask: offline.ask, senderId: "art", deliverInPlace: notLive }))
      .toMatchObject({ ok: false, code: "broker_unavailable" });

    const empty = fakeAsk({ usedBroker: true });
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "   " }, { ask: empty.ask, senderId: "art", deliverInPlace: notLive }))
      .toMatchObject({ ok: false, code: "empty_body" });
    expect(empty.calls).toHaveLength(0);

    const thrown = (async () => { throw new Error("socket closed"); }) as unknown as typeof import("../broker/service.ts").askScoutQuestion;
    expect(await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "hi" }, { ask: thrown, senderId: "art", deliverInPlace: notLive }))
      .toMatchObject({ ok: false, code: "delivery_failed" });
  });

  test("router input schema accepts the phone payload and rejects a missing session id", () => {
    expect(mobileAskSessionInputSchema.safeParse({ sessionId: SOURCE, harness: "claude", cwd: null, body: "hi" }).success).toBe(true);
    expect(mobileAskSessionInputSchema.safeParse({ sessionId: "", harness: "claude", body: "hi" }).success).toBe(false);
  });

  test("a Codex resume keeps fork-if-live, which only refuses a thread open elsewhere", async () => {
    const { ask, calls } = fakeAsk({ usedBroker: true, conversationId: "dm.1", targetSessionId: SOURCE });
    await askMobileHarnessSession({ sessionId: SOURCE, harness: "codex", body: "hi" }, { ask, senderId: "art", deliverInPlace: notLive });
    expect(calls[0]?.target).toMatchObject({ kind: "session_id", harness: "codex", forkIfLive: true });
  });

  test("a live session gets the reply in place and the broker is never asked", async () => {
    const { ask, calls } = fakeAsk({ usedBroker: true, conversationId: "dm.1" });
    const result = await askMobileHarnessSession(
      { sessionId: SOURCE, harness: "claude", body: "keep going" },
      { ask, senderId: "art", deliverInPlace: async () => ({ ok: true, via: "herdr", location: "Herdr scout · w1:p1" }) },
    );
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ ok: true, mode: "resumed", delivery: "in_place", via: "herdr", location: "Herdr scout · w1:p1", sessionId: SOURCE, sourceSessionId: SOURCE });
  });

  test("a live session Scout can't type into is refused, never copied", async () => {
    for (const inPlace of [
      { ok: false, code: "session_blocked", via: "herdr", location: "Herdr scout · w1:p1" },
      { ok: false, code: "in_place_failed", via: "tmux", location: "tmux work · %3", detail: "boom" },
    ] as InPlaceDelivery[]) {
      const { ask, calls } = fakeAsk({ usedBroker: true, conversationId: "dm.1" });
      const result = await askMobileHarnessSession({ sessionId: SOURCE, harness: "claude", body: "hi" }, { ask, senderId: "art", deliverInPlace: async () => inPlace });
      expect(calls).toHaveLength(0);
      expect(result.ok).toBe(false);
    }
  });
});

describe("deliverInPlace", () => {
  const record = (over: Partial<ClaudeSessionRecord>): ClaudeSessionRecord => ({
    pid: 42, sessionId: SOURCE, cwd: "/w", startedAt: null, procStart: null, kind: "interactive",
    entrypoint: "cli", version: null, tmux: null, name: null, nameSource: null, recordPath: "/r/42.json", ...over,
  });

  test("Herdr first: the pane that holds the session gets the prompt", async () => {
    const prompted: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      findHerdrPane: async () => ({ session: "scout", paneId: "w1:p1", status: "idle" }),
      promptHerdr: async (pane, body) => { prompted.push(`${pane.paneId}:${body}`); },
      findClaudeRecord: async () => { throw new Error("not reached"); },
    });
    expect(result).toEqual({ ok: true, via: "herdr", location: "Herdr scout · w1:p1" });
    expect(prompted).toEqual(["w1:p1:hi"]);
  });

  test("a Codex thread held by the ChatGPT app goes through the Scout app", async () => {
    const typed: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      findHerdrPane: async () => null,
      codexHeldByApp: async () => true,
      askScoutApp: async () => ({ ok: true, accessibility: "granted" }),
      typeIntoCodexApp: async (id, body) => { typed.push(`${id}:${body}`); },
    });
    expect(result).toEqual({ ok: true, via: "scout-app", location: "the ChatGPT app’s Codex" });
    expect(typed).toEqual([`${SOURCE}:hi`]);
  });

  test("without the Scout app's grant, nothing reaches the ChatGPT composer", async () => {
    const typeIntoCodexApp = async () => { throw new Error("must not open the link"); };
    const base = { findHerdrPane: async () => null, codexHeldByApp: async () => true, typeIntoCodexApp };
    expect(await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      ...base,
      askScoutApp: async () => ({ ok: true, accessibility: "not-granted" }),
    })).toMatchObject({ ok: false, code: "scout_app_accessibility" });
    expect(await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      ...base,
      askScoutApp: async () => ({ ok: false, code: "scout_app_unavailable", message: "not running" }),
    })).toMatchObject({ ok: false, code: "scout_app_unavailable" });
  });

  test("a Herdr pane at a prompt is not typed into", async () => {
    const result = await deliverInPlace({ sessionId: SOURCE, body: "hi" }, {
      findHerdrPane: async () => ({ session: "scout", paneId: "w1:p1", status: "blocked" }),
      promptHerdr: async () => { throw new Error("must not type"); },
    });
    expect(result).toMatchObject({ ok: false, code: "session_blocked" });
  });

  test("then tmux, by the pane Claude's own record names", async () => {
    const targets: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "claude", body: "hi" }, {
      findHerdrPane: async () => null,
      findClaudeRecord: async () => record({ tmux: { session: "work", window: "@1", pane: "%3" } }),
      promptTmux: async (target) => { targets.push(target); },
    });
    expect(result).toEqual({ ok: true, via: "tmux", location: "tmux work · %3" });
    expect(targets).toEqual(["%3"]);
  });

  test("then Lattices, by the tty of a Claude in a plain terminal tab", async () => {
    const typed: string[] = [];
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "claude", body: "hi" }, {
      findHerdrPane: async () => null,
      findClaudeRecord: async () => record({}),
      ttyForPid: async () => "ttys007",
      typeIntoTty: async (tty, body) => { typed.push(`${tty}:${body}`); },
    });
    expect(result).toEqual({ ok: true, via: "lattices", location: "terminal ttys007" });
    expect(typed).toEqual(["ttys007:hi"]);
  });

  test("Scout's own background copy is never a place to deliver", async () => {
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "claude", body: "hi" }, {
      findHerdrPane: async () => null,
      findClaudeRecord: async () => record({ tmux: { session: `flat-claude-${SOURCE}`, window: null, pane: "%58" } }),
      promptTmux: async () => { throw new Error("must not type"); },
    });
    expect(result).toEqual({ ok: false, code: "not_live" });
  });

  test("a Codex session nothing holds has no live place", async () => {
    const result = await deliverInPlace({ sessionId: SOURCE, harness: "codex", body: "hi" }, {
      findHerdrPane: async () => null,
      codexHeldByApp: async () => false,
      findClaudeRecord: async () => { throw new Error("not reached"); },
    });
    expect(result).toEqual({ ok: false, code: "not_live" });
  });
});
