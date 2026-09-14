import { describe, expect, test } from "bun:test";

import type { ActorIdentity, AgentEndpoint, NodeDefinition } from "@openscout/protocol";

import {
  MESH_SESSION_WAKE_PATH,
  flatDispatchSessionId,
  wakeLocalHarnessSession,
  wakeSessionOnPeers,
  type LocalSessionWakeDeps,
  type PeerSessionWakeResponse,
} from "./broker-session-wake.js";
import type { SessionLocateResult } from "./session-locator.js";

const NATIVE_SESSION_ID = "4fad8bb9-b4d3-4432-be75-8cfd636e78c0";

function locatedSession(): SessionLocateResult {
  return {
    ok: true,
    session: {
      harness: "claude",
      nativeSessionId: NATIVE_SESSION_ID,
      cwd: "/Users/art/dev/openscout",
      path: `/Users/art/.claude/projects/-Users-art-dev-openscout/${NATIVE_SESSION_ID}.jsonl`,
      lastActivityAt: 100,
      match: "filename",
    },
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: flatDispatchSessionId("claude", NATIVE_SESSION_ID),
    nodeId: "node-local",
    harness: "claude",
    transport: "claude_stream_json",
    state: "idle",
    sessionId: NATIVE_SESSION_ID,
    metadata: { cardless: true },
    ...input,
  } as AgentEndpoint;
}

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "mesh-1",
    name: "Peer",
    advertiseScope: "mesh",
    registeredAt: 100,
    brokerUrl: "http://peer.example:43110",
    ...input,
  };
}

function createLocalDeps(input: {
  locate?: SessionLocateResult;
  endpoints?: Record<string, AgentEndpoint>;
  resumable?: boolean;
} = {}) {
  const upsertedActors: ActorIdentity[] = [];
  const upsertedEndpoints: AgentEndpoint[] = [];
  const deps: LocalSessionWakeDeps = {
    nodeId: "node-local",
    registry: {
      async upsertActor(actor) {
        upsertedActors.push(actor);
      },
      async upsertEndpoint(nextEndpoint) {
        upsertedEndpoints.push(nextEndpoint);
      },
    },
    snapshotEndpoints: () => input.endpoints ?? {},
    harnessSupportsResume: () => input.resumable ?? true,
    locate: () => input.locate ?? locatedSession(),
    findLiveClaudeSession: async () => null,
  };
  return { deps, upsertedActors, upsertedEndpoints };
}

describe("wakeLocalHarnessSession", () => {
  test("passes locate misses through untouched", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps({
      locate: {
        ok: false,
        reason: "session_unknown",
        detail: "no harness session store entry",
        remediation: "check the id",
      },
    });

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result).toEqual({
      ok: false,
      reason: "session_unknown",
      detail: "no harness session store entry",
      remediation: "check the id",
    });
    expect(upsertedEndpoints).toEqual([]);
  });

  test("refuses harnesses without a resume command", async () => {
    const { deps } = createLocalDeps({ resumable: false });

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: "session_not_resumable",
    }));
  });

  test("registers a cardless flat-dispatch endpoint for a located session", async () => {
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps();

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    if (!result.ok) {
      throw new Error(`expected ok result, got ${result.reason}: ${result.detail}`);
    }
    expect(result.endpoint.nodeId).toBe("node-local");
    expect(result.endpoint.agentId).toBe(flatDispatchSessionId("claude", NATIVE_SESSION_ID));
    expect(result.endpoint.metadata?.nativeSessionId).toBe(NATIVE_SESSION_ID);
    expect(result.actor?.id).toBe(flatDispatchSessionId("claude", NATIVE_SESSION_ID));
    expect(upsertedActors).toHaveLength(1);
    expect(upsertedEndpoints).toHaveLength(1);
  });

  test("reuses a live endpoint already registered for the session", async () => {
    const existing = endpoint({ id: "endpoint-existing", state: "active" });
    const { deps, upsertedEndpoints } = createLocalDeps({
      endpoints: { [existing.id]: existing },
    });

    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result).toEqual({ ok: true, endpoint: existing });
    expect(upsertedEndpoints).toEqual([]);
  });

  test("correlates a pending live tmux endpoint before registering a flat worker", async () => {
    const pending = endpoint({ transport: "tmux", agentId: "original", sessionId: "scout-session", metadata: { pendingExternalSession: true } });
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps({ endpoints: { original: pending } });
    deps.observeEndpointSession = async () => ({ sessionId: NATIVE_SESSION_ID, runtime: { harness: "claude" }, runtimeSource: "process", evidence: { pid: 123 }, observedAt: 100 });
    deps.findLiveClaudeSession = async () => { throw new Error("must not scan after binding"); };
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.endpoint.agentId).toBe("original");
    expect(upsertedActors).toHaveLength(0);
    expect(upsertedEndpoints[0]?.metadata?.externalSessionId).toBe(NATIVE_SESSION_ID);
  });

  test("collapses registry and isolated projections of one observed pane", async () => {
    const registry = endpoint({ id: "registry", transport: "tmux", agentId: "original", sessionId: "scout-session", metadata: { lastStartedAt: 100 } });
    const isolated = endpoint({ ...registry, id: "isolated", metadata: { isolatedExecution: true, lastStartedAt: 200 } });
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps({ endpoints: { registry, isolated } });
    deps.observeEndpointSession = async () => ({ sessionId: NATIVE_SESSION_ID, runtime: { harness: "claude" }, runtimeSource: "process", evidence: { pid: 123, tmuxSession: "scout-session", tmuxPane: "%16" }, observedAt: 100 });
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.endpoint.id).toBe("isolated");
    expect(upsertedActors).toHaveLength(0);
    expect(upsertedEndpoints).toHaveLength(1);
  });

  test("refuses distinct live process owners of one native id", async () => {
    const one = endpoint({ id: "one", transport: "tmux" });
    const two = endpoint({ ...one, id: "two" });
    const { deps, upsertedEndpoints } = createLocalDeps({ endpoints: { one, two } });
    deps.observeEndpointSession = async (candidate) => ({ sessionId: NATIVE_SESSION_ID, runtime: { harness: "claude" }, runtimeSource: "process", evidence: { pid: candidate.id === "one" ? 123 : 124, tmuxSession: "scout-session", tmuxPane: "%16" }, observedAt: 100 });
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).toMatchObject({ ok: false, reason: "session_ambiguous" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("does not inspect unrelated terminal endpoints while waking a native session", async () => {
    const stopped = endpoint({ transport: "tmux", state: "stopped" });
    const { deps, upsertedEndpoints } = createLocalDeps({ endpoints: { stopped } });
    deps.observeEndpointSession = async () => { throw new Error("stopped pane is missing"); };
    expect((await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).ok).toBe(true);
    expect(upsertedEndpoints).toHaveLength(1);
  });

  test("refuses to launch another worker for an unbound live native session", async () => {
    const { deps, upsertedActors, upsertedEndpoints } = createLocalDeps();
    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });
    expect(result).toMatchObject({ ok: false, reason: "session_live_unbound" });
    expect(upsertedActors).toHaveLength(0);
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("fails closed when process ownership cannot be inspected", async () => {
    const { deps, upsertedEndpoints } = createLocalDeps();
    deps.findLiveClaudeSession = async () => { throw new Error("tmux unavailable"); };
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).toMatchObject({ ok: false, reason: "session_runtime_unobserved" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("does not reuse a stale adopted tmux alias", async () => {
    const stale = endpoint({ transport: "tmux", metadata: { externalSessionId: NATIVE_SESSION_ID, externalSessionAdoptedAt: 100 } });
    const { deps, upsertedEndpoints } = createLocalDeps({ endpoints: { stale } });
    deps.observeEndpointSession = async () => null;
    deps.findLiveClaudeSession = async () => ({ sessionId: NATIVE_SESSION_ID });
    expect(await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID })).toMatchObject({ ok: false, reason: "session_live_unbound" });
    expect(upsertedEndpoints).toHaveLength(0);
  });

  test("re-registers over a terminal endpoint instead of reusing it", async () => {
    const stopped = endpoint({ id: "endpoint-stopped", state: "stopped" });
    const { deps, upsertedEndpoints } = createLocalDeps({
      endpoints: { [stopped.id]: stopped },
    });

    const result = await wakeLocalHarnessSession(deps, { nativeSessionId: NATIVE_SESSION_ID });

    expect(result.ok).toBe(true);
    expect(upsertedEndpoints).toHaveLength(1);
  });
});

describe("wakeSessionOnPeers", () => {
  function createPeerDeps(input: {
    responses: Record<string, PeerSessionWakeResponse | Error>;
  }) {
    const upsertedActors: ActorIdentity[] = [];
    const upsertedEndpoints: AgentEndpoint[] = [];
    const posts: Array<{ brokerBaseUrl: string; path: string; payload: unknown }> = [];
    const deps = {
      localNodeId: "node-local",
      registry: {
        async upsertActor(actor: ActorIdentity) {
          upsertedActors.push(actor);
        },
        async upsertEndpoint(nextEndpoint: AgentEndpoint) {
          upsertedEndpoints.push(nextEndpoint);
        },
      },
      postJson: async <TResponse,>(brokerBaseUrl: string, path: string, payload: unknown): Promise<TResponse> => {
        posts.push({ brokerBaseUrl, path, payload });
        const response = input.responses[brokerBaseUrl];
        if (response instanceof Error) {
          throw response;
        }
        return response as TResponse;
      },
    };
    return { deps, posts, upsertedActors, upsertedEndpoints };
  }

  test("adopts the endpoint from the first peer that owns the session", async () => {
    const peerEndpoint = endpoint({ id: "endpoint-peer", nodeId: "node-b" });
    const peerActor: ActorIdentity = {
      id: peerEndpoint.agentId,
      kind: "session",
      displayName: "openscout:4fad8bb9",
      handle: peerEndpoint.agentId,
      metadata: { cardless: true },
    } as ActorIdentity;
    const { deps, posts, upsertedActors, upsertedEndpoints } = createPeerDeps({
      responses: {
        "http://a.example:43110": { ok: false, reason: "session_unknown", detail: "not here" },
        "http://b.example:43110": { ok: true, endpoint: peerEndpoint, actor: peerActor },
      },
    });
    const result = await wakeSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-a", brokerUrl: "http://a.example:43110" }),
        node({ id: "node-b", brokerUrl: "http://b.example:43110" }),
      ] },
      { nativeSessionId: NATIVE_SESSION_ID, harness: "claude" },
    );

    expect(result).toEqual({ ok: true, peerNodeId: "node-b", endpoint: peerEndpoint });
    expect(posts.map((post) => post.path)).toEqual([MESH_SESSION_WAKE_PATH, MESH_SESSION_WAKE_PATH]);
    expect(posts[0]?.payload).toEqual({ nativeSessionId: NATIVE_SESSION_ID, harness: "claude" });
    expect(upsertedActors).toEqual([peerActor]);
    expect(upsertedEndpoints).toEqual([peerEndpoint]);
  });

  test("ignores endpoints a peer claims but does not own", async () => {
    const { deps, upsertedEndpoints } = createPeerDeps({
      responses: {
        // A peer must return an endpoint bound to its own node id.
        "http://b.example:43110": { ok: true, endpoint: endpoint({ nodeId: "node-elsewhere" }) },
      },
    });

    const result = await wakeSessionOnPeers(
      { ...deps, peers: [node({ id: "node-b", brokerUrl: "http://b.example:43110" })] },
      { nativeSessionId: NATIVE_SESSION_ID },
    );

    expect(result).toEqual({ ok: false, peersTried: 1 });
    expect(upsertedEndpoints).toEqual([]);
  });

  test("continues past transport failures and reports peers tried", async () => {
    const { deps } = createPeerDeps({
      responses: {
        "http://a.example:43110": new Error("connect ECONNREFUSED"),
        "http://b.example:43110": { ok: false, reason: "session_unknown", detail: "not here" },
      },
    });

    const result = await wakeSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-a", brokerUrl: "http://a.example:43110" }),
        node({ id: "node-b", brokerUrl: "http://b.example:43110" }),
      ] },
      { nativeSessionId: NATIVE_SESSION_ID },
    );

    expect(result).toEqual({ ok: false, peersTried: 2 });
  });

  test("skips peers without a broker url and itself", async () => {
    const { deps, posts } = createPeerDeps({ responses: {} });

    const result = await wakeSessionOnPeers(
      { ...deps, peers: [
        node({ id: "node-local", brokerUrl: "http://self.example:43110" }),
        node({ id: "node-silent", brokerUrl: undefined }),
      ] },
      { nativeSessionId: NATIVE_SESSION_ID },
    );

    expect(result).toEqual({ ok: false, peersTried: 0 });
    expect(posts).toEqual([]);
  });
});
