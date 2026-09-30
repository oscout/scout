import { describe, expect, test } from "bun:test";
import type { Agent, FleetActivity, FleetAsk, FleetState, TailEvent } from "../../lib/types.ts";
import { agentLookup, buildHomeFeed, cleanText, dayOffset, displayName, isAck, leadSentence, liftStatus, seenBoundary, verdictOf } from "./agents-home-feed-model.ts";

function activity(partial: Partial<FleetActivity>): FleetActivity {
  return {
    id: "a", kind: "agent_message", ts: 1_000, actorName: "hudson", title: "hello", summary: null,
    conversationId: "c1", workspaceRoot: "~/dev/openscout", agentId: null, agentName: null,
    flightId: null, invocationId: null, sessionId: null, messageId: null, recordId: null, actorId: null,
    ...partial,
  };
}

function ask(partial: Partial<FleetAsk>): FleetAsk {
  return {
    invocationId: "i", flightId: null, agentId: "x", agentName: "dirac", conversationId: "c9",
    collaborationRecordId: null, task: "do it", status: "failed", statusLabel: "", acknowledgedAt: null,
    attention: "silent", agentState: "offline", harness: "codex", transport: null, summary: "stopped",
    startedAt: 1, completedAt: 500, updatedAt: 500, ...partial,
  };
}

function fleet(partial: Partial<FleetState>): FleetState {
  return {
    generatedAt: 0, totals: { active: 0, recentCompleted: 0, needsAttention: 0, activity: 0 },
    activeAsks: [], recentCompleted: [], needsAttention: [], activity: [], ...partial,
  };
}

describe("agents home feed projection", () => {
  test("strips routing tags from post text", () => {
    expect(cleanText("[ask:f-abc] DONE — landed")).toBe("DONE — landed");
    expect(cleanText("**Approve** it")).toBe("Approve it");
  });

  test("drops System and bookkeeping rows, keeps agent speech", () => {
    const feed = buildHomeFeed({
      fleet: fleet({
        activity: [
          activity({ id: "1", ts: 30, title: "shipped it" }),
          activity({ id: "2", ts: 20, kind: "message_posted", actorName: "System", title: "could not route" }),
          activity({ id: "3", ts: 10, kind: "invocation_recorded", title: "consult" }),
        ],
      }),
      agents: [],
    });
    expect(feed.posts.map((p) => p.text)).toEqual(["shipped it"]);
    expect(feed.posts[0]?.project).toBe("openscout");
  });

  test("folds a same-agent run in one conversation into one post", () => {
    const feed = buildHomeFeed({
      fleet: fleet({
        activity: [
          activity({ id: "1", ts: 3 * 60_000, title: "latest" }),
          activity({ id: "2", ts: 2 * 60_000, title: "middle" }),
          activity({ id: "3", ts: 1 * 60_000, title: "first" }),
          activity({ id: "4", ts: 0, title: "other thread", conversationId: "c2" }),
        ],
      }),
      agents: [],
    });
    expect(feed.posts.map((p) => [p.text, p.attachment])).toEqual([
      ["latest", "+2 more in the thread"],
      ["other thread", null],
    ]);
  });

  test("failed asks become failed posts with their outcome; completed ones do not", () => {
    const feed = buildHomeFeed({
      fleet: fleet({ recentCompleted: [ask({}), ask({ invocationId: "j", status: "completed" })] }),
      agents: [],
    });
    expect(feed.posts).toHaveLength(1);
    expect(feed.posts[0]).toMatchObject({ state: "failed", text: "do it", attachment: "stopped" });
  });

  test("folds a dispatch prompt into the reply it produced", () => {
    const feed = buildHomeFeed({
      fleet: fleet({
        activity: [
          activity({ id: "r", ts: 50, kind: "ask_opened", actorName: "fourier", title: "DONE — landed" }),
          activity({ id: "p", ts: 40, kind: "agent_message", actorName: "Agent 2", title: "Build the study" }),
          activity({ id: "q", ts: 30, kind: "agent_message", actorName: "Agent 2", title: "Unanswered ask", conversationId: "c2" }),
        ],
      }),
      agents: [],
    });
    expect(feed.posts.map((p) => [p.agent, p.text, p.context?.text ?? null])).toEqual([
      ["fourier", "DONE — landed", "Build the study"],
      ["Agent 2", "Unanswered ask", null],
    ]);
  });

  test("seen boundary skips a rule above the first row", () => {
    const posts = buildHomeFeed({
      fleet: fleet({ activity: [activity({ id: "1", ts: 100, conversationId: "a" }), activity({ id: "2", ts: 10, conversationId: "b" })] }),
      agents: [],
    }).posts;
    expect(seenBoundary(posts, 50)).toBe(1);
    expect(seenBoundary(posts, 500)).toBe(-1);
    expect(seenBoundary(posts, null)).toBe(-1);
  });
});

test("the usual dispatcher is the majority prompter, never a one-off", () => {
  const reply = (id: string, ts: number, conversationId: string) =>
    activity({ id, ts, kind: "ask_opened", actorName: "fourier", title: `DONE ${id}`, conversationId });
  const prompt = (id: string, ts: number, conversationId: string, actorName: string) =>
    activity({ id, ts: ts - 1, kind: "agent_message", actorName, title: `Do ${id}`, conversationId });
  const majority = buildHomeFeed({
    fleet: fleet({
      activity: [
        reply("r1", 90, "c1"), prompt("p1", 90, "c1", "Agent 2"),
        reply("r2", 80, "c2"), prompt("p2", 80, "c2", "Agent 2"),
        reply("r3", 70, "c3"), prompt("p3", 70, "c3", "hudson"),
      ],
    }),
    agents: [],
  });
  expect(majority.dispatcher).toBe("Agent 2");
  expect(majority.posts.map((p) => p.context?.agent)).toEqual(["Agent 2", "Agent 2", "hudson"]);

  const split = buildHomeFeed({
    fleet: fleet({
      activity: [
        reply("r1", 90, "c1"), prompt("p1", 90, "c1", "Agent 2"),
        reply("r2", 80, "c2"), prompt("p2", 80, "c2", "hudson"),
      ],
    }),
    agents: [],
  });
  expect(split.dispatcher).toBeNull();
});

test("cleanText shortens full commit hashes", () => {
  expect(cleanText("APPROVE at c39dc82eaf8ccffec21d6408ab2d5c51d96ec64a for merge"))
    .toBe("APPROVE at c39dc82 for merge");
});

describe("agent-day grouping", () => {
  const NOW = new Date(2026, 8, 23, 12, 0).getTime();
  const H = 3_600_000;

  test("a working day rolls over at 4am", () => {
    expect(dayOffset(new Date(2026, 8, 23, 0, 30).getTime(), new Date(2026, 8, 23, 1, 0).getTime())).toBe(0);
    expect(dayOffset(new Date(2026, 8, 22, 3, 0).getTime(), NOW)).toBe(2);
    expect(dayOffset(new Date(2026, 8, 22, 5, 0).getTime(), NOW)).toBe(1);
  });

  test("reads verdicts, including a VERDICT: prefix", () => {
    expect(verdictOf("APPROVE at c39dc82")).toBe("approved");
    expect(verdictOf("VERDICT: CHANGES. Reviewed de44055")).toBe("changes");
    expect(verdictOf("Approach looks fine")).toBeNull();
  });

  test("one row per agent per day, led by the newest post", () => {
    const feed = buildHomeFeed({
      nowMs: NOW,
      agents: [],
      fleet: fleet({
        activity: [
          activity({ id: "1", ts: NOW - 1 * H, actorName: "fourier", title: "landed the study", conversationId: "a" }),
          activity({ id: "2", ts: NOW - 3 * H, actorName: "fourier", title: "started the study", conversationId: "b" }),
          activity({ id: "3", ts: NOW - 2 * H, actorName: "hypatia", title: "edited the draft", conversationId: "c" }),
          activity({ id: "4", ts: NOW - 30 * H, actorName: "fourier", title: "yesterday's note", conversationId: "d" }),
        ],
      }),
    });
    expect(feed.days.map((d) => d.offset)).toEqual([0, 1]);
    expect(feed.days[0]!.rows.map((r) => [r.agent, r.count, r.headline])).toEqual([
      ["fourier", 2, "landed the study"],
      ["hypatia", 1, "edited the draft"],
    ]);
  });

  test("reviews of one PR roll up across agents; a re-check inherits the PR from its conversation", () => {
    const feed = buildHomeFeed({
      nowMs: NOW,
      agents: [],
      fleet: fleet({
        activity: [
          activity({ id: "1", ts: NOW - 1 * H, actorName: "m3ktab", title: "APPROVE at 04c79ad", conversationId: "r1" }),
          activity({ id: "2", ts: NOW - 2 * H, actorName: "m3ktab", title: "CHANGES at 186ff5e for PR #1017", conversationId: "r1" }),
          activity({ id: "3", ts: NOW - 3 * H, actorName: "cobalt", title: "CHANGES at de44055 (#1017)", conversationId: "r2" }),
          activity({ id: "4", ts: NOW - 4 * H, actorName: "fourier", title: "landed the study", conversationId: "x" }),
        ],
      }),
    });
    const rows = feed.days[0]!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.headline).toBe("Review of #1017 · 1 approved, 1 requested changes");
    expect(rows[0]!.reviewers?.map((r) => r.agent)).toEqual(["m3ktab", "cobalt"]);
    expect(rows[0]!.count).toBe(3);
  });
});

describe("row copy", () => {
  test("drops a project prefix the /project line already says", () => {
    expect(displayName("openscout-fourier", "openscout")).toBe("fourier");
    expect(displayName("Openscout Agent 2", "openscout")).toBe("Openscout Agent 2");
    expect(displayName("openscout", "openscout")).toBe("openscout");
  });

  test("lifts a leading status word out of the sentence", () => {
    expect(liftStatus("DONE — Workflow Planner study landed")).toEqual({ status: "done", text: "Workflow Planner study landed" });
    expect(liftStatus("Done. shipped it")).toEqual({ status: "done", text: "Shipped it" });
    expect(liftStatus("Donezo is a word")).toEqual({ status: null, text: "Donezo is a word" });
  });

  test("home paths read as ~/", () => {
    expect(cleanText("Changed /Users/art/dev/openscout/docs/a.md")).toBe("Changed ~/dev/openscout/docs/a.md");
  });
});

test("acknowledgments are told apart from results", () => {
  expect(isAck("I'll review the draft as an editorial pass")).toBe(true);
  expect(isAck("Starting the migration now")).toBe(true);
  expect(isAck("Study is in: design/host-identity-study")).toBe(false);
  expect(isAck("Illustrated the flow")).toBe(false);
});

test("rows lead with the first sentence", () => {
  expect(leadSentence("Workflow Planner study landed in the studio. LOCATION design/studio/views/x")).toBe("Workflow Planner study landed in the studio.");
  expect(leadSentence("Done. Shipped the fix to main.")).toBe("Done. Shipped the fix to main.");
  expect(leadSentence("Head at v1.2.3 is clean")).toBe("Head at v1.2.3 is clean");
});

describe("agentLookup", () => {
  const session = {
    id: "session-mudh0n5h-x8vmjn.codex-chat-multi-user-workspace.arts-mini",
    definitionId: "session-mudh0n5h-x8vmjn",
    name: "Session Mudh0n5h X8vmjn",
    handle: "session-mudh0n5h-x8vmjn",
    harness: "claude",
  } as Agent;
  test("activity's bare actor id finds the roster's qualified agent", () => {
    expect(agentLookup([session])("session-mudh0n5h-x8vmjn", "fourier")?.harness).toBe("claude");
  });
  test("an exact id beats a bare-id match", () => {
    const exact = { ...session, id: "session-mudh0n5h-x8vmjn", definitionId: "x", harness: "codex" } as Agent;
    expect(agentLookup([session, exact])("session-mudh0n5h-x8vmjn", null)?.harness).toBe("codex");
  });
});

function tailEvent(partial: Partial<TailEvent>): TailEvent {
  return {
    id: "t1", ts: 5 * 60_000, source: "claude", sessionId: "a2da73bf-7685-462a", pid: 1, parentPid: null,
    project: "openscout", cwd: "/Users/art/dev/openscout", harness: "unattributed", kind: "assistant",
    summary: "The tail processor is in.", ...partial,
  };
}

describe("harness sessions in the feed", () => {
  test("a session's latest reply is a post, named plainly and routed to the session", () => {
    const feed = buildHomeFeed({ fleet: fleet({}), agents: [], tail: [tailEvent({})] });
    expect(feed.posts).toHaveLength(1);
    expect(feed.posts[0]).toMatchObject({
      agent: "claude session a2da73bf",
      harness: "claude",
      project: "openscout",
      text: "The tail processor is in.",
      route: { view: "sessions", sessionId: "a2da73bf-7685-462a" },
    });
  });

  test("thinking and bare markers are not posts", () => {
    const feed = buildHomeFeed({
      fleet: fleet({}),
      agents: [],
      tail: [tailEvent({ id: "a", summary: "[thinking] weighing it" }), tailEvent({ id: "b", summary: "[assistant]" })],
    });
    expect(feed.posts).toEqual([]);
  });

  test("a session a Scout agent owns joins that agent, and its broker echo is dropped", () => {
    const owner = { id: "hudson.main.mini", name: "hudson", harness: "claude", harnessSessionId: "s-1" } as Agent;
    const echoed = buildHomeFeed({
      fleet: fleet({ activity: [activity({ id: "1", ts: 5 * 60_000, actorId: "hudson.main.mini", title: "shipped it" })] }),
      agents: [owner],
      tail: [tailEvent({ sessionId: "s-1", ts: 5 * 60_000 + 1_000 })],
    });
    expect(echoed.posts.map((p) => p.text)).toEqual(["shipped it"]);

    const later = buildHomeFeed({
      fleet: fleet({ activity: [activity({ id: "1", ts: 0, actorId: "hudson.main.mini", title: "shipped it" })] }),
      agents: [owner],
      tail: [tailEvent({ sessionId: "s-1", ts: 30 * 60_000 })],
    });
    expect(later.posts.map((p) => [p.agent, p.text])).toEqual([["hudson", "The tail processor is in."], ["hudson", "shipped it"]]);
  });
});
