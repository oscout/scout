import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActionBlock, Session, SessionState, TurnState } from "@openscout/agent-sessions";
import type { InvocationRequest } from "@openscout/protocol";

import {
  buildManagedPairingEndpointBinding,
  buildPairingSessionCandidate,
  invokePairingSessionEndpoint,
  listPairingSessions,
  type PairingBridgeClient,
} from "./pairing-session-agents.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "abc12345-6789",
    name: "Codex OpenScout",
    adapterType: "codex",
    status: "active",
    cwd: "/tmp/openscout",
    ...overrides,
  };
}

function makeInvocation(task = "Summarize the runtime status."): InvocationRequest {
  return {
    id: "invocation-1",
    requesterId: "operator",
    requesterNodeId: "node-main",
    targetAgentId: "target-agent",
    action: "consult",
    task,
    ensureAwake: false,
    stream: false,
    createdAt: 1,
  };
}

function makeTextTurn(input: {
  id: string;
  text: string;
  status?: TurnState["status"];
}): TurnState {
  return {
    id: input.id,
    status: input.status ?? "completed",
    startedAt: 1,
    endedAt: input.status === "completed" ? 2 : undefined,
    blocks: [
      {
        status: "completed",
        block: {
          id: `${input.id}-block`,
          turnId: input.id,
          type: "text",
          status: "completed",
          index: 0,
          text: input.text,
        },
      },
    ],
  };
}

function makeApprovalTurn(input: {
  id: string;
  description: string;
}): TurnState {
  const actionBlock: ActionBlock = {
    id: `${input.id}-approval`,
    turnId: input.id,
    type: "action",
    status: "started",
    index: 0,
    action: {
      kind: "command",
      status: "awaiting_approval",
      output: "",
      command: "git commit",
      approval: {
        version: 1,
        description: input.description,
        risk: "medium",
      },
    },
  };

  return {
    id: input.id,
    status: "streaming",
    startedAt: 1,
    blocks: [
      {
        status: "streaming",
        block: actionBlock,
      },
    ],
  };
}

function snapshotFor(session: Session, turns: TurnState[]): SessionState {
  return {
    session,
    turns,
    currentTurnId: turns[turns.length - 1]?.id,
  };
}

function createFakeClient(snapshots: SessionState[]): {
  client: PairingBridgeClient;
  sentPrompts: string[];
} {
  const sentPrompts: string[] = [];
  let snapshotIndex = 0;

  return {
    client: {
      async query<T>(path: string): Promise<T> {
        if (path !== "session.snapshot") {
          throw new Error(`Unexpected query path: ${path}`);
        }
        const next = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return next as T;
      },
      async mutation<T>(path: string, input?: Record<string, unknown>): Promise<T> {
        if (path !== "prompt.send") {
          throw new Error(`Unexpected mutation path: ${path}`);
        }
        sentPrompts.push(String(input?.text ?? ""));
        return { ok: true } as T;
      },
      close() {},
    },
    sentPrompts,
  };
}

describe("pairing session agents", () => {
  test("builds an ephemeral pairing session candidate from a live session", () => {
    const session = makeSession();
    const candidate = buildPairingSessionCandidate(session);

    expect(candidate.externalSessionId).toBe(session.id);
    expect(candidate.name).toBe("Codex OpenScout");
    expect(candidate.suggestedSelector).toBe("@codex-openscout-abc12345");
    expect(candidate.adapterType).toBe("codex");
  });

  test("builds a managed pairing endpoint binding for a stable Scout agent", () => {
    const session = makeSession();
    const endpoint = buildManagedPairingEndpointBinding({
      agentId: "pairing-agent-1",
      nodeId: "node-main",
      session,
      agentName: "newell",
    });

    expect(endpoint.id).toBe("endpoint.pairing-agent-1.node-main.pairing");
    expect(endpoint.agentId).toBe("pairing-agent-1");
    expect(endpoint.transport).toBe("pairing_bridge");
    expect(endpoint.harness).toBe("codex");
    expect(endpoint.sessionId).toBe(session.id);
    expect(endpoint.metadata?.managedByScout).toBe(true);
    expect(endpoint.metadata?.externalSessionId).toBe(session.id);
  });

  test("uses the bridge default port when pairing config omits one", async () => {
    const originalHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), "openscout-pairing-home-"));
    try {
      const pairingRoot = join(tempHome, ".scout", "pairing");
      mkdirSync(pairingRoot, { recursive: true });
      writeFileSync(join(pairingRoot, "config.json"), JSON.stringify({ workspace: { root: "/tmp" } }), "utf8");
      writeFileSync(join(pairingRoot, "runtime.json"), JSON.stringify({ status: "paired" }), "utf8");
      process.env.HOME = tempHome;

      let observedPort = 0;
      await listPairingSessions({
        createClient: async (port) => {
          observedPort = port;
          return {
            async query<T>() {
              return [] as T;
            },
            async mutation<T>() {
              return {} as T;
            },
            close() {},
          };
        },
      });

      expect(observedPort).toBe(43_130);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("invokes a pairing session and returns the completed turn text", async () => {
    const session = makeSession();
    const endpoint = buildManagedPairingEndpointBinding({
      agentId: "pairing-agent-1",
      nodeId: "node-main",
      session,
      agentName: "newell",
    });
    const { client, sentPrompts } = createFakeClient([
      snapshotFor(session, []),
      snapshotFor(session, [makeTextTurn({ id: "turn-1", text: "Pairing reply." })]),
    ]);

    const result = await invokePairingSessionEndpoint(
      endpoint,
      makeInvocation(),
      {
        createClient: async () => client,
        port: 1,
        sleep: async () => undefined,
      },
    );

    expect(result.output).toBe("Pairing reply.");
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toBe("Summarize the runtime status.");
  });

  test("invokes attached local-session endpoints with the raw task text", async () => {
    const session = makeSession();
    const endpoint = buildManagedPairingEndpointBinding({
      agentId: "local-session-agent-1",
      nodeId: "node-main",
      session,
      agentName: "codex-023e",
    });
    endpoint.metadata = {
      ...(endpoint.metadata ?? {}),
      source: "local-session",
      externalSource: "local-session",
      attachedTransport: "codex_app_server",
      sessionBacked: true,
    };

    const task = "hi arach — this should be direct in-thread text.";
    const { client, sentPrompts } = createFakeClient([
      snapshotFor(session, []),
      snapshotFor(session, [makeTextTurn({ id: "turn-1", text: "ack" })]),
    ]);

    await invokePairingSessionEndpoint(
      endpoint,
      makeInvocation(task),
      {
        createClient: async () => client,
        port: 1,
        sleep: async () => undefined,
      },
    );

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toBe(task);
  });

  test("returns an attention message when the live session blocks on approval", async () => {
    const session = makeSession({ id: "attention-1234", name: "Codex Attention" });
    const endpoint = buildManagedPairingEndpointBinding({
      agentId: "pairing-agent-1",
      nodeId: "node-main",
      session,
      agentName: "newell",
    });
    const { client } = createFakeClient([
      snapshotFor(session, []),
      snapshotFor(session, [makeApprovalTurn({
        id: "turn-approval",
        description: "Allow the session to commit runtime changes.",
      })]),
    ]);

    const result = await invokePairingSessionEndpoint(
      endpoint,
      makeInvocation("Please finish the runtime change."),
      {
        createClient: async () => client,
        port: 1,
        sleep: async () => undefined,
      },
    );

    expect(result.output).toContain("Waiting for approval");
    expect(result.output).toContain("Allow the session to commit runtime changes.");
  });
});
