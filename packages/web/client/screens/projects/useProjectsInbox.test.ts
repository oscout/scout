import { describe, expect, test } from "bun:test";

import type { FleetState, TailEvent } from "../../lib/types.ts";
import {
  createHistoricalReplayHydrator,
  createReplyBurstCoalescer,
  deferProjectsInboxWork,
  latestObservedAssistantReplies,
} from "./projects-inbox-replies.ts";
import {
  retainProjectAliases,
  reuseFleetIfUnchanged,
} from "./projects-inbox-model.ts";

function fleet(input: Partial<FleetState> = {}): FleetState {
  return {
    generatedAt: 1,
    totals: { active: 0, recentCompleted: 0, needsAttention: 0, activity: 0 },
    activeAsks: [],
    recentCompleted: [],
    needsAttention: [],
    activity: [],
    ...input,
  };
}

function reply(input: Partial<TailEvent> & { id: string; ts: number }): TailEvent {
  return {
    source: "codex",
    sessionId: "session-1",
    pid: 1,
    parentPid: null,
    project: "openscout",
    cwd: "/tmp/openscout",
    harness: "scout-managed",
    kind: "assistant",
    summary: input.id,
    ...input,
  };
}

describe("Projects inbox assistant reply feed", () => {
  test("keeps the latest user-facing reply per source and session", () => {
    const events = [
      reply({ id: "codex-old", ts: 10, summary: "partial reply" }),
      reply({ id: "tool", ts: 40, kind: "tool", summary: "technical chatter" }),
      reply({ id: "codex-new", ts: 20, summary: "finished reply" }),
      reply({ id: "claude-new", ts: 30, source: "claude", summary: "Claude reply" }),
    ];

    expect(latestObservedAssistantReplies(events, 10).map((event) => event.id)).toEqual([
      "claude-new",
      "codex-new",
    ]);
  });

  test("coalesces a streaming burst into one deferred flush", () => {
    const scheduled: Array<() => void> = [];
    const flushes: TailEvent[][] = [];
    const coalescer = createReplyBurstCoalescer(
      (events) => flushes.push(events),
      (flush) => {
        scheduled.push(flush);
        return () => undefined;
      },
    );

    coalescer.push(reply({ id: "fragment-1", ts: 10, summary: "Starting" }));
    coalescer.push(reply({ id: "fragment-2", ts: 11, summary: "Finished" }));
    coalescer.push(reply({
      id: "other-session",
      ts: 12,
      sessionId: "session-2",
      summary: "Other reply",
    }));

    expect(scheduled).toHaveLength(1);
    expect(flushes).toHaveLength(0);

    scheduled[0]!();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.map((event) => event.id)).toEqual(["fragment-2", "other-session"]);
  });

  test("defers cold replay work instead of running it in the shell fetch task", async () => {
    const completed = Promise.withResolvers<void>();
    let ran = false;

    deferProjectsInboxWork(() => {
      ran = true;
      completed.resolve();
    });

    expect(ran).toBe(false);
    await completed.promise;
    expect(ran).toBe(true);
  });

  test("hydrates historical replies once while live events carry later updates", async () => {
    let loads = 0;
    const hydrator = createHistoricalReplayHydrator({
      retryDelayMs: 5_000,
      load: async () => { loads += 1; },
    });

    await Promise.all([hydrator.run(), hydrator.run()]);
    await hydrator.run();

    expect(loads).toBe(1);
    expect(hydrator.shouldRun()).toBe(false);

    hydrator.reset();
    await hydrator.run();

    expect(loads).toBe(2);
    expect(hydrator.shouldRun()).toBe(false);
  });

  test("retries a failed historical reply load after backoff", async () => {
    let now = 1_000;
    let loads = 0;
    const hydrator = createHistoricalReplayHydrator({
      retryDelayMs: 5_000,
      now: () => now,
      load: async () => {
        loads += 1;
        if (loads === 1) throw new Error("tail unavailable");
      },
    });

    await hydrator.run();
    expect(hydrator.shouldRun()).toBe(false);
    await hydrator.run();
    expect(loads).toBe(1);

    now += 5_000;
    expect(hydrator.shouldRun()).toBe(true);
    await hydrator.run();

    expect(loads).toBe(2);
    expect(hydrator.shouldRun()).toBe(false);
  });
});

describe("Projects inbox project aliases", () => {
  test("retains a folded slug while its canonical project remains", () => {
    expect(retainProjectAliases(
      { "openscout-worktree": "openscout" },
      {},
      [{ slug: "openscout" }],
    )).toEqual({ "openscout-worktree": "openscout" });
  });

  test("drops stale aliases and lets a direct project slug win", () => {
    expect(retainProjectAliases(
      {
        "removed-worktree": "removed-project",
        "openscout-worktree": "openscout",
      },
      {},
      [{ slug: "openscout" }, { slug: "openscout-worktree" }],
    )).toEqual({});
  });
});

describe("Projects inbox fleet memoization", () => {
  test("reuses a fleet snapshot only when asks and attention are both unchanged", () => {
    const previous = fleet({ generatedAt: 1 });
    const equivalent = fleet({ generatedAt: 2 });

    expect(reuseFleetIfUnchanged(previous, equivalent)).toBe(previous);

    const changedAttention = fleet({
      generatedAt: 3,
      needsAttention: [{
        kind: "work_item",
        recordId: "work-1",
        title: "Review this",
        summary: null,
        agentId: "agent-1",
        agentName: "Agent One",
        conversationId: "conv-1",
        state: "review",
        acceptanceState: "pending",
        updatedAt: 3,
      }],
    });
    expect(reuseFleetIfUnchanged(previous, changedAttention)).toBe(changedAttention);
  });
});
