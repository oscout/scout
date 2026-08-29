import { describe, expect, test } from "bun:test";

import type { TailEvent } from "../../lib/types.ts";
import {
  createReplyBurstCoalescer,
  deferProjectsInboxWork,
  latestObservedAssistantReplies,
} from "./projects-inbox-replies.ts";

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
});
