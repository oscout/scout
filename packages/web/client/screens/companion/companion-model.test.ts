import { describe, expect, test } from "bun:test";

import type { TailEvent, WorkDetail, WorkItem } from "../../lib/types.ts";
import {
  MAX_SURFACE_AGENT_READS,
  QUIET_AFTER_MS,
  SURFACE_ATTENTION_WINDOW_MS,
  SURFACE_PROGRESS_WINDOW_MS,
  ageLabel,
  sessionHistory,
  groupByState,
  groupLabel,
  selectSurfaced,
  summaryState,
  surfaceAgentIds,
  bringIntoView,
  buildCompanionCard,
  cleanReportText,
  isCompanionRelevantEvent,
  overflowSummary,
  projectInitials,
  type CompanionCardState,
} from "./companion-model.ts";

const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);
const MIN = 60_000;

type Timeline = WorkDetail["timeline"][number];
type Flight = WorkDetail["allFlights"][number];

function event(at: number, detailKind: string, summary: string): Timeline {
  return {
    id: `evt-${at}-${detailKind}`,
    kind: "collaboration_event",
    at,
    actorId: "agent-1",
    actorName: "builder",
    title: null,
    summary,
    detailKind,
    flightId: null,
    messageId: null,
    conversationId: null,
  };
}

function flightRow(at: number, kind: "flight_started" | "flight_completed", detailKind: string | null = null): Timeline {
  return { ...event(at, detailKind ?? "", ""), id: `flt-row-${at}`, kind, summary: null, detailKind, actorName: "builder" };
}

function flight(state: string): Flight {
  return { id: `flt-${state}`, state } as unknown as Flight;
}

function work(overrides: Partial<WorkDetail> = {}): WorkDetail {
  return {
    id: "work-1",
    title: "Port the companion",
    summary: null,
    ownerId: "agent-1",
    ownerName: "builder",
    nextMoveOwnerId: "agent-1",
    nextMoveOwnerName: "builder",
    conversationId: "chn-1",
    createdAt: NOW - 30 * MIN,
    updatedAt: NOW - 30 * 1000,
    parentId: null,
    parentTitle: null,
    state: "working",
    acceptanceState: "none",
    priority: null,
    currentPhase: "working",
    attention: "silent",
    activeChildWorkCount: 0,
    activeFlightCount: 1,
    lastMeaningfulAt: NOW - 30 * 1000,
    lastMeaningfulSummary: "[ask:f-1] Wiring the panel",
    childWork: [],
    activeFlights: [flight("running")],
    allFlights: [flight("running")],
    timeline: [event(NOW - 30 * 1000, "progressed", "[ask:f-1] Wiring the panel")],
    primaryInvocation: null,
    ...overrides,
  } as WorkDetail;
}

function tail(ts: number, summary: string, kind = "tool"): TailEvent {
  return { id: `t-${ts}`, ts, source: "claude", sessionId: "s-1", kind, summary } as unknown as TailEvent;
}

describe("text helpers", () => {
  test("strips the ask routing tag and collapses whitespace", () => {
    expect(cleanReportText("[ask:f-murpb191-ybzg]  Done\n with it")).toBe("Done with it");
    expect(cleanReportText(null)).toBe("");
  });

  test("age labels never claim more precision than they have", () => {
    expect(ageLabel(NOW - 20_000, NOW)).toBe("<1m");
    expect(ageLabel(NOW - 5 * MIN, NOW)).toBe("5m");
    expect(ageLabel(NOW - 3 * 60 * MIN, NOW)).toBe("3h");
    expect(ageLabel(NOW - 72 * 60 * MIN, NOW)).toBe("3d");
    expect(ageLabel(NOW + MIN, NOW)).toBe("<1m");
  });

  test("project initials fall back honestly", () => {
    expect(projectInitials("openscout", "x")).toBe("Op");
    expect(projectInitials("scout-desktop", "x")).toBe("SD");
    expect(projectInitials(null, "Port the companion")).toBe("PT");
    expect(projectInitials("", "  ")).toBe("?");
  });
});

describe("buildCompanionCard", () => {
  test("working: reported headline, fresh age only while live", () => {
    const card = buildCompanionCard(work(), { now: NOW, live: true });
    expect(card.state).toBe("working");
    expect(card.headline).toBe("Wiring the panel");
    expect(card.ageLabel).toBe("now");
    expect(buildCompanionCard(work(), { now: NOW, live: false }).ageLabel).toBe("<1m");
  });

  test("question when the next move is the operator's", () => {
    const card = buildCompanionCard(work({
      state: "waiting",
      nextMoveOwnerId: "operator",
      timeline: [
        event(NOW - 10 * MIN, "progressed", "Halfway"),
        event(NOW - 4 * MIN, "waiting", "[ask:x] Which corner should it default to?"),
      ],
    }), { now: NOW, live: true });
    expect(card.state).toBe("question");
    expect(card.status).toBe("Asks you");
    expect(card.callout).toEqual({ tone: "question", label: "Question · reported 4m ago", text: "Which corner should it default to?" });
  });

  test("review owned by the operator reads as ready for review", () => {
    const card = buildCompanionCard(work({
      state: "review",
      nextMoveOwnerId: "operator",
      timeline: [event(NOW - 2 * MIN, "review_requested", "Please review the diff")],
    }), { now: NOW, live: true });
    expect(card.status).toBe("Ready for review");
    expect(card.callout?.label).toBe("Review · reported 2m ago");
  });

  test("waiting on someone else is muted, not a question", () => {
    const card = buildCompanionCard(work({ state: "waiting", nextMoveOwnerId: "agent-2", nextMoveOwnerName: "reviewer" }), { now: NOW, live: true });
    expect(card.state).toBe("waiting");
    expect(card.status).toBe("Waiting on reviewer");
    expect(card.statusTone).toBe("muted");
  });

  test("interrupt attention is a blocker with the reported reason", () => {
    const card = buildCompanionCard(work({
      attention: "interrupt",
      state: "waiting",
      timeline: [event(NOW - MIN, "waiting", "Signing identity missing")],
    }), { now: NOW, live: true });
    expect(card.state).toBe("blocked");
    expect(card.statusTone).toBe("error");
    expect(card.callout).toEqual({ tone: "blocker", label: "Blocker · reported", text: "Signing identity missing" });
  });

  test("done shows the reported output", () => {
    const card = buildCompanionCard(work({
      state: "done",
      timeline: [event(NOW - 3 * MIN, "progressed", "Almost"), event(NOW - MIN, "done", "Shipped 4 files")],
    }), { now: NOW, live: true });
    expect(card.state).toBe("done");
    expect(card.callout?.text).toBe("Shipped 4 files");
    expect(card.observedLine).toBeNull();
  });

  test("a finished flight with no completion report reads as session ended, not done", () => {
    const card = buildCompanionCard(work({
      activeFlights: [],
      activeFlightCount: 0,
      allFlights: [flight("completed")],
    }), { now: NOW, live: true });
    expect(card.state).toBe("ended");
    expect(card.headline).toBe("no completion reported");
  });

  test("quiet after eight minutes without activity", () => {
    const at = NOW - QUIET_AFTER_MS - MIN;
    const card = buildCompanionCard(work({
      updatedAt: at,
      lastMeaningfulAt: at,
      timeline: [event(at, "progressed", "Reading the shell")],
    }), { now: NOW, live: true });
    expect(card.state).toBe("quiet");
    expect(card.status).toBe("Quiet 9m");
    expect(card.headline).toBe("last reported: Reading the shell");
  });

  test("observed activity keeps a quiet-looking report working", () => {
    const at = NOW - 20 * MIN;
    const card = buildCompanionCard(work({
      updatedAt: at,
      lastMeaningfulAt: at,
      timeline: [event(at, "progressed", "Reading the shell")],
    }), { now: NOW, live: true, tail: [tail(NOW - 30_000, "Edit OverlayPanelShell.swift")], tailMatched: true });
    expect(card.state).toBe("working");
    expect(card.observedLine).toBe("Edit OverlayPanelShell.swift");
    // Reported and observed stay separate lanes.
    expect(card.headline).toBe("Reading the shell");
  });

  test("observed lane merges flights and non-user tail lines, newest last, bounded", () => {
    const rows = [flightRow(NOW - 9 * MIN, "flight_started")];
    const lines = Array.from({ length: 10 }, (_, index) => tail(NOW - (8 - index) * MIN, `step ${index}`));
    const card = buildCompanionCard(work({ timeline: [...rows, event(NOW - MIN, "progressed", "go")] }), {
      now: NOW,
      live: true,
      tail: [...lines, tail(NOW - 2000, "[attachment]", "assistant"), tail(NOW - 1000, "operator typed this", "user")],
    });
    expect(card.observed).toHaveLength(7);
    expect(card.observed.at(-1)?.text).toBe("step 9");
    expect(card.observed.some((line) => line.text.includes("operator typed"))).toBe(false);
    expect(card.observed.some((line) => line.text === "[attachment]")).toBe(false);
  });

  test("reported lane keeps the last four non-empty reports", () => {
    const timeline = Array.from({ length: 6 }, (_, index) => event(NOW - (6 - index) * MIN, "progressed", `r${index}`));
    const card = buildCompanionCard(work({ timeline }), { now: NOW, live: true });
    expect(card.reported.map((line) => line.text)).toEqual(["r2", "r3", "r4", "r5"]);
  });

  test("who line joins project, owner and harness; no invented fields", () => {
    const card = buildCompanionCard(work(), { now: NOW, live: true, project: "openscout", harness: "claude" });
    expect(card.who).toBe("openscout · builder · claude");
    expect(card.initials).toBe("Op");
    expect(JSON.stringify(card)).not.toContain("%");
  });
});

describe("overflow and bring-in", () => {
  const states = new Map<string, CompanionCardState>([
    ["a", "question"],
    ["b", "working"],
    ["c", "working"],
    ["d", "blocked"],
    ["e", "question"],
  ]);

  test("swaps into the least recently touched slot that does not need the operator", () => {
    const touched = new Map([["a", 1], ["b", 50], ["c", 10]]);
    expect(bringIntoView(["a", "b", "c", "d", "e"], "e", states, touched)).toEqual(["a", "b", "e", "d", "c"]);
  });

  test("visible or unknown ids leave the order alone", () => {
    expect(bringIntoView(["a", "b", "c", "d"], "b", states, new Map())).toEqual(["a", "b", "c", "d"]);
    expect(bringIntoView(["a", "b", "c", "d"], "zz", states, new Map())).toEqual(["a", "b", "c", "d"]);
  });

  test("when every slot needs the operator, the most recently touched one moves", () => {
    const urgent = new Map<string, CompanionCardState>([["a", "question"], ["b", "blocked"], ["c", "question"], ["d", "working"]]);
    const touched = new Map([["a", 5], ["b", 9], ["c", 1]]);
    expect(bringIntoView(["a", "b", "c", "d"], "d", urgent, touched)).toEqual(["a", "d", "c", "b"]);
  });

  test("overflow summary names only what needs the operator", () => {
    expect(overflowSummary(["question", "question", "blocked", "working"])).toBe("2 ask you · 1 blocked");
    expect(overflowSummary(["question"])).toBe("1 asks you");
    expect(overflowSummary(["working", undefined])).toBe("");
  });

  test("relevant broker events", () => {
    expect(isCompanionRelevantEvent({ kind: "collaboration.event.appended" })).toBe(true);
    expect(isCompanionRelevantEvent({ kind: "unknown" })).toBe(true);
    expect(isCompanionRelevantEvent({ kind: "node.heartbeat" })).toBe(false);
  });
});

function row(id: string, patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Title ${id}`,
    summary: null,
    ownerId: "agent-1",
    ownerName: "Hudson",
    nextMoveOwnerId: "agent-1",
    nextMoveOwnerName: "Hudson",
    conversationId: `chn-${id}`,
    createdAt: 0,
    updatedAt: NOW - 60_000,
    parentId: null,
    parentTitle: null,
    state: "working",
    acceptanceState: "none",
    priority: null,
    currentPhase: "working",
    attention: "silent",
    activeChildWorkCount: 0,
    activeFlightCount: 0,
    lastMeaningfulAt: NOW - 60_000,
    lastMeaningfulSummary: null,
    ...patch,
  };
}

describe("summaryState", () => {
  test("classifies list rows with the same precedence as cards", () => {
    expect(summaryState(row("a", { state: "done" }), NOW)).toBe("done");
    expect(summaryState(row("a", { state: "cancelled" }), NOW)).toBe("cancelled");
    expect(summaryState(row("a", { attention: "interrupt", state: "waiting" }), NOW)).toBe("blocked");
    expect(summaryState(row("a", { state: "waiting", nextMoveOwnerId: "operator" }), NOW)).toBe("question");
    expect(summaryState(row("a", { state: "review", nextMoveOwnerId: "operator" }), NOW)).toBe("question");
    expect(summaryState(row("a", { state: "waiting" }), NOW)).toBe("waiting");
    expect(summaryState(row("a"), NOW)).toBe("working");
    expect(summaryState(row("a", { updatedAt: NOW - QUIET_AFTER_MS - 1, lastMeaningfulAt: 0 }), NOW)).toBe("quiet");
  });
});

describe("groupByState", () => {
  test("urgent groups first, operator order inside a group, unknown last", () => {
    const states = new Map<string, CompanionCardState>([["a", "working"], ["b", "question"], ["c", "working"], ["d", "done"]]);
    expect(groupByState(["a", "b", "c", "d", "e"], states)).toEqual([
      { key: "question", ids: ["b"] },
      { key: "working", ids: ["a", "c"] },
      { key: "done", ids: ["d"] },
      { key: "unknown", ids: ["e"] },
    ]);
    expect(groupLabel("question")).toBe("Asks you");
  });
});

describe("surfacing", () => {
  const agents = [
    { id: "agent-1", name: "Hudson", projectRoot: "/dev/openscout" },
    { id: "agent-2", name: "Vera", projectRoot: "/dev/openscout" },
    { id: "agent-3", name: "Other", projectRoot: "/dev/elsewhere" },
  ];

  test("nothing surfaces without a grant", () => {
    expect(selectSurfaced([row("a", { state: "waiting", nextMoveOwnerId: "operator" })], {
      scopes: [], agents, pinnedIds: new Set(), now: NOW,
    })).toEqual([]);
  });

  test("agent reads are bounded and narrowest grants come first", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `p-${index}`, projectRoot: "/big" }));
    const ids = surfaceAgentIds(
      [{ kind: "project", id: "/big", label: null }, { kind: "agent", id: "agent-9", label: null }],
      many,
    );
    expect(ids[0]).toBe("agent-9");
    expect(ids).toHaveLength(MAX_SURFACE_AGENT_READS);
  });

  test("admits by work, then agent, then project; says why", () => {
    const scopes = [
      { kind: "project" as const, id: "/dev/openscout", label: null },
      { kind: "agent" as const, id: "agent-1", label: "Hudson" },
      { kind: "work" as const, id: "w-3", label: null },
    ];
    const surfaced = selectSurfaced([
      row("w-1"),
      row("w-2", { ownerId: "agent-2", nextMoveOwnerId: "operator", state: "waiting" }),
      row("w-3", { ownerId: "agent-3", nextMoveOwnerId: "agent-3" }),
      row("w-4", { ownerId: "agent-3", nextMoveOwnerId: "agent-3" }),
      row("w-1"),
    ], { scopes, agents, pinnedIds: new Set(), now: NOW });
    expect(surfaced.map((item) => [item.workId, item.origin, item.needsOperator])).toEqual([
      ["w-2", "via openscout", true],
      ["w-1", "via Hudson", false],
      ["w-3", "allowed work", false],
    ]);
  });

  test("pinned work stays a card; stale progress drops out, attention lasts", () => {
    const scopes = [{ kind: "agent" as const, id: "agent-1", label: null }];
    const old = NOW - SURFACE_PROGRESS_WINDOW_MS - 1;
    const surfaced = selectSurfaced([
      row("pinned"),
      row("stale", { updatedAt: old, lastMeaningfulAt: old }),
      row("old-ask", { updatedAt: old, lastMeaningfulAt: old, state: "review", nextMoveOwnerId: "operator" }),
      row("ancient-ask", { updatedAt: NOW - SURFACE_ATTENTION_WINDOW_MS - 1, lastMeaningfulAt: 0, state: "waiting", nextMoveOwnerId: "operator" }),
    ], { scopes, agents, pinnedIds: new Set(["pinned"]), now: NOW });
    expect(surfaced.map((item) => item.workId)).toEqual(["old-ask"]);
  });
});


describe("session tail preview", () => {
  test("shows historical activity on review cards without making it current", () => {
    const at = NOW - 5 * 60 * MIN;
    const card = buildCompanionCard(work({ state: "review", nextMoveOwnerId: "operator" }), {
      now: NOW, live: true, tailMatched: true, history: [{ at, text: "Read companion controller" }],
    });
    expect(card.state).toBe("question");
    expect(card.sessionTail).toEqual([{ at, text: "Read companion controller" }]);
    expect(card.lastActivityAt).not.toBe(NOW);
  });
  test("history never invents dates for synthetic offsets or exposes thinking", () => {
    const payload = { data: { events: [
      { id: "a", kind: "tool", t: 4, text: "Read a file" },
      { id: "b", kind: "message", t: 5, at: NOW - MIN, text: "Checks passed" },
      { id: "c", kind: "think", t: 6, at: NOW, text: "Private reasoning" },
    ] } } as Parameters<typeof sessionHistory>[0];
    expect(sessionHistory(payload)).toEqual([{ at: NOW - MIN, text: "Checks passed" }]);
  });
});
