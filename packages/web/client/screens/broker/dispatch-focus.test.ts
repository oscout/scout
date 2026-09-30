import { describe, expect, test } from "bun:test";
import type { Agent, BrokerRouteAttempt } from "../../lib/types.ts";
import {
  applyDispatchScope,
  conciseAddressLabel,
  dispatchGraph,
  dispatchNodeCatalog,
  dispatchRecovery,
  dispatchRequestSummary,
  dispatchRowModel,
  type DispatchScope,
} from "./dispatch-focus.ts";

const NOW = Date.UTC(2026, 8, 28, 20, 0, 0);

function attempt(overrides: Partial<BrokerRouteAttempt> = {}): BrokerRouteAttempt {
  return {
    id: "message:msg-1",
    kind: "success",
    status: "sent",
    ts: NOW - 60_000,
    actorName: "Arach",
    target: "opus",
    route: "dm",
    detail: "Review the Console focus model",
    conversationId: "chn-1",
    messageId: "msg-1",
    deliveryId: null,
    invocationId: null,
    metadata: { actorId: "operator" },
    ...overrides,
  };
}

function agent(id: string, name: string, extra: Partial<Agent> = {}): Agent {
  return { id, name, handle: id, authorityNodeName: "arts-mini", ...extra } as Agent;
}

const AGENTS = [agent("opus", "Opus"), agent("codex", "Codex"), agent("muse", "Muse")];

function scope(overrides: Partial<DispatchScope> = {}): DispatchScope {
  return { nodes: [], between: false, window: "all", query: "", outcome: "all", ...overrides };
}

const failedFork = attempt({
  id: "dispatch:d-1",
  kind: "failed_query",
  status: "failed",
  target: "session:codex:01a0e90f-877e-7352-9017-c42333094543",
  route: null,
  detail: "codex session 01a0e90f-877e-7352-9017-c42333094543 is open in another Codex app and cannot be forked from Scout yet",
  conversationId: null,
  messageId: null,
  metadata: {
    source: "scout_dispatches",
    dispatchKind: "unknown",
    requestedLabel: "session:codex:01a0e90f-877e-7352-9017-c42333094543",
    requesterId: "Arach",
    sessionWakeReason: "session_live_fork_unsupported",
  },
});

describe("dispatch identity", () => {
  test("keeps the real sender and destination instead of assuming the operator", () => {
    const row = dispatchRowModel(
      attempt({ actorName: "Codex", target: "muse", metadata: { actorId: "codex", class: "agent" } }),
      AGENTS,
      "Arach",
    );
    expect(row.from.key).toBe("agent:codex");
    expect(row.to.key).toBe("agent:muse");
  });

  test("merges the operator's name and the operator address into one person node", () => {
    const sent = dispatchRowModel(attempt(), AGENTS, "Arach");
    const received = dispatchRowModel(attempt({ actorName: "Opus", target: "operator", metadata: { actorId: "opus" } }), AGENTS, "Arach");
    const byName = dispatchRowModel(attempt({ actorName: "Opus", target: "Arach", metadata: { actorId: "opus" } }), AGENTS, "Arach");
    expect(sent.from.key).toBe("operator");
    expect(received.to.key).toBe("operator");
    expect(byName.to.key).toBe("operator");
    expect(sent.from.kind).toBe("operator");
  });

  test("a session addressed as session:<id> is the same node as its agent", () => {
    const sessionAgent = agent("session-mukm8vyr-3n4ftc.repo.arts-mini", "Session Mukm8vyr 3n4ftc", { handle: "session-mukm8vyr-3n4ftc" });
    const direct = dispatchRowModel(attempt({ target: "session-mukm8vyr-3n4ftc" }), [sessionAgent], "Arach");
    const routed = dispatchRowModel(attempt({ target: "session:session-mukm8vyr-3n4ftc" }), [sessionAgent], "Arach");
    expect(routed.to.key).toBe(direct.to.key);
    expect(routed.to.label).toBe("Session mukm8vyr");
  });

  test("a machine is a fact about an agent, never a node of its own", () => {
    const row = dispatchRowModel(attempt(), AGENTS, "Arach");
    expect(row.to.key).toBe("agent:opus");
    expect(row.to.machine).toBe("arts-mini");
    const catalog = dispatchNodeCatalog([row], AGENTS);
    expect([...catalog.keys()].some((key) => key.includes("arts-mini"))).toBe(false);
  });

  test("shortens session addresses but keeps the full id for details", () => {
    expect(conciseAddressLabel("session:codex:01a0e90f-877e-7352-9017-c42333094543")).toBe("Codex session 01a0e90f");
    expect(conciseAddressLabel("session-mulj6ybu-fiskm1")).toBe("Session mulj6ybu");
    expect(conciseAddressLabel("Flat Claude 587e138a 9575 4a03 A4df C0a3d83fed5e")).toBe("Claude session 587e138a");
    const row = dispatchRowModel(failedFork, AGENTS, "Arach");
    expect(row.to.label).toBe("Codex session 01a0e90f");
    expect(row.to.address).toBe("session:codex:01a0e90f-877e-7352-9017-c42333094543");
    expect(row.to.kind).toBe("session");
  });
});

describe("request summary", () => {
  test("leads with the request, not the transport prefix", () => {
    expect(dispatchRequestSummary(attempt({ detail: "[ask:f-mul-1] Continue the integration review\nmore" })))
      .toBe("Continue the integration review");
    expect(dispatchRequestSummary(attempt({ detail: "session:587e138a-9575 Testing the lanes" }))).toBe("Testing the lanes");
    expect(dispatchRequestSummary(attempt({ detail: "# Add a herdr page\nbody" }))).toBe("Add a herdr page");
  });

  test("routing failures carry no request text, so none is invented", () => {
    expect(dispatchRequestSummary(failedFork)).toBeNull();
    const row = dispatchRowModel(failedFork, AGENTS, "Arach");
    expect(row.request).toBeNull();
    expect(row.title).toBe("This session can't receive the handoff through Scout");
  });
});

describe("scope", () => {
  const rows = [
    dispatchRowModel(attempt({ id: "a", target: "opus" }), AGENTS, "Arach"),
    dispatchRowModel(attempt({ id: "b", target: "codex", ts: NOW - 3 * 60 * 60 * 1000 }), AGENTS, "Arach"),
    dispatchRowModel(attempt({ id: "c", actorName: "Codex", target: "muse", metadata: { actorId: "codex" } }), AGENTS, "Arach"),
    dispatchRowModel({ ...failedFork, id: "d" }, AGENTS, "Arach"),
  ];
  const ids = (result: ReturnType<typeof applyDispatchScope>) => result.matching.map((row) => row.attempt.id);

  test("focus matches dispatches involving ANY focused node", () => {
    expect(ids(applyDispatchScope(rows, scope({ nodes: ["agent:codex"] }), NOW))).toEqual(["b", "c"]);
    expect(ids(applyDispatchScope(rows, scope({ nodes: ["agent:opus", "agent:muse"] }), NOW))).toEqual(["a", "c"]);
  });

  test("between keeps only dispatches whose both ends are focused", () => {
    expect(ids(applyDispatchScope(rows, scope({ nodes: ["operator", "agent:codex"], between: true }), NOW))).toEqual(["b"]);
    // One focused node cannot form a pair; between falls back to "involving".
    expect(ids(applyDispatchScope(rows, scope({ nodes: ["agent:codex"], between: true }), NOW))).toEqual(["b", "c"]);
  });

  test("AND across filter types; counts share focus, window and search", () => {
    const result = applyDispatchScope(rows, scope({ nodes: ["operator"], window: "1h", outcome: "failed" }), NOW);
    expect(ids(result)).toEqual(["d"]);
    expect(result.counts).toEqual({ all: 2, delivered: 1, failed: 1 });
  });

  test("search reaches ids and full addresses, not only visible labels", () => {
    expect(ids(applyDispatchScope(rows, scope({ query: "01a0e90f-877e" }), NOW))).toEqual(["d"]);
  });

  test("the graph draws the matching set, keeps focused quiet nodes, and marks attention", () => {
    const { matching } = applyDispatchScope(rows, scope({ nodes: ["operator", "agent:muse", "agent:ghost"] }), NOW);
    const catalog = dispatchNodeCatalog(rows, [...AGENTS, agent("ghost", "Ghost")]);
    const graph = dispatchGraph(matching, ["operator", "agent:muse", "agent:ghost"], catalog);
    expect(graph.senders.map((entry) => entry.node.key)).toEqual(["operator", "agent:codex"]);
    expect(graph.quiet.map((node) => node.label)).toEqual(["Ghost"]);
    const fork = graph.edges.find((edge) => edge.to.includes("session:codex"));
    expect(fork?.attention).toBe(1);
    expect(graph.senders.find((entry) => entry.node.key === "operator")?.focused).toBe(true);
    expect(graph.senders.find((entry) => entry.node.key === "agent:codex")?.focused).toBe(false);
  });
});

describe("recovery", () => {
  test("names the live-fork restriction and does not offer a retry that would repeat it", () => {
    const recovery = dispatchRecovery(failedFork);
    expect(recovery.stage).toBe("routing-stopped");
    expect(recovery.headline).toBe("This session can't receive the handoff through Scout");
    expect(recovery.body).toContain("open in another app");
    expect(recovery.retry).toBe("unavailable");
    expect(recovery.requestRecorded).toBe(false);
    expect(recovery.evidence).toContainEqual({ label: "Session wake", value: "session_live_fork_unsupported" });
  });

  test("without structured evidence it stays generic and quotes the broker", () => {
    const { sessionWakeReason: _dropped, ...metadata } = failedFork.metadata!;
    const recovery = dispatchRecovery({ ...failedFork, metadata });
    expect(recovery.headline).toBe("Scout couldn't route to “Codex session 01a0e90f”");
    expect(recovery.body).toBe(failedFork.detail);
  });

  test("ambiguous and unavailable targets use their own structured reasons", () => {
    expect(dispatchRecovery({ ...failedFork, metadata: { dispatchKind: "ambiguous", requestedLabel: "@codex" } }).headline)
      .toBe("“@codex” matches more than one agent");
    expect(dispatchRecovery({
      ...failedFork,
      metadata: { dispatchKind: "unavailable", requestedLabel: "vox", unavailableReason: "manual_wake_required" },
    }).headline).toBe("vox has to be woken by hand");
  });

  test("a delivery failure still has the request, so resending is offered", () => {
    const recovery = dispatchRecovery(attempt({
      kind: "failed_delivery",
      status: "failed",
      metadata: { failureDetail: "Stale running flight reconciled: endpoint was replayed" },
    }));
    expect(recovery.stage).toBe("delivery-failed");
    expect(recovery.retry).toBe("available");
    expect(recovery.requestRecorded).toBe(true);
  });

  test("delivered is not completed: the work outcome is reported separately", () => {
    const recovery = dispatchRecovery(attempt());
    expect(recovery.stage).toBe("delivered");
    expect(recovery.body).toContain("tracked separately");
  });
});
