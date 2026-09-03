import { afterEach, describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  ConversationDefinition,
  ConversationReadCursor,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
} from "@openscout/protocol";
import { stableChannelId } from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import type { ObservedSessionProjectionUpdate } from "./observed-session-reducer.js";
import {
  ConversationProjectionStore,
  CONVERSATION_PROJECTION_LAUNCH_LIMIT,
  type ConversationProjectionStoreOptions,
} from "./conversation-projection-store.js";
import {
  configureControlPlaneDatabase,
  migrateControlPlaneDatabaseSchema,
} from "./control-plane-migrations.js";
import {
  openControlPlaneSqliteDatabase,
  type ControlPlaneSqliteTransactionalDatabase,
} from "./sqlite-adapter.js";

const BASE = 1_800_000_000_000;
const NODE_ID = "node-local";
const OPERATOR_ID = "operator";

type Harness = {
  db: ControlPlaneSqliteTransactionalDatabase;
  projection: ConversationProjectionStore;
  setNow(value: number): void;
};

const databases: ControlPlaneSqliteTransactionalDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close?.();
  }
});

function setup(
  eventOptions: Pick<
    ConversationProjectionStoreOptions,
    "eventRetentionMs" | "eventMaxRows" | "eventMaxBytes" | "eventPruneInterval"
  > = {},
): Harness {
  const db = openControlPlaneSqliteDatabase(":memory:", { create: true }) as ControlPlaneSqliteTransactionalDatabase;
  databases.push(db);
  configureControlPlaneDatabase(db);
  migrateControlPlaneDatabaseSchema(db);
  let now = BASE + 10_000;
  const projection = new ConversationProjectionStore(db, {
    ...eventOptions,
    now: () => now,
    createProjectionId: () => "projection-test-1",
    operatorActorIds: [OPERATOR_ID, "Arach"],
  });
  db.query(
    `INSERT INTO nodes (
       id, mesh_id, name, advertise_scope, registered_at
     ) VALUES (?1, 'mesh-test', 'Local Mac', 'local', ?2)`,
  ).run(NODE_ID, BASE);
  db.query(
    `INSERT INTO actors (id, kind, display_name, created_at)
     VALUES (?1, 'person', 'Operator', ?2)`,
  ).run(OPERATOR_ID, BASE);
  db.query(
    `INSERT INTO actors (id, kind, display_name, created_at)
     VALUES ('Arach', 'person', 'Arach', ?1)`,
  ).run(BASE);
  return {
    db,
    projection,
    setNow(value: number) {
      now = value;
    },
  };
}

function seedAgent(
  db: ControlPlaneSqliteTransactionalDatabase,
  input: {
    id: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  },
): AgentDefinition {
  const displayName = input.displayName ?? input.id;
  const metadataJson = JSON.stringify(input.metadata ?? {});
  db.query(
    `INSERT INTO actors (id, kind, display_name, metadata_json, created_at)
     VALUES (?1, 'agent', ?2, ?3, ?4)`,
  ).run(input.id, displayName, metadataJson, BASE);
  db.query(
    `INSERT INTO agents (
       id, definition_id, agent_class, capabilities_json, wake_policy,
       home_node_id, authority_node_id, advertise_scope, metadata_json
     ) VALUES (?1, ?1, 'general', '["chat"]', 'on_demand', ?2, ?2, 'local', ?3)`,
  ).run(input.id, NODE_ID, metadataJson);
  return {
    id: input.id,
    kind: "agent",
    definitionId: input.id,
    displayName,
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "on_demand",
    homeNodeId: NODE_ID,
    authorityNodeId: NODE_ID,
    advertiseScope: "local",
    metadata: input.metadata,
  };
}

function seedEndpoint(
  db: ControlPlaneSqliteTransactionalDatabase,
  input: {
    id: string;
    agentId: string;
    state?: AgentEndpoint["state"];
    projectRoot?: string;
    sessionId?: string;
    harness?: AgentEndpoint["harness"];
    metadata?: Record<string, unknown>;
    updatedAt?: number;
  },
): AgentEndpoint {
  const metadata = input.metadata ?? {};
  const endpoint: AgentEndpoint = {
    id: input.id,
    agentId: input.agentId,
    nodeId: NODE_ID,
    harness: input.harness ?? "codex",
    transport: "codex_app_server",
    state: input.state ?? "active",
    sessionId: input.sessionId,
    cwd: input.projectRoot,
    projectRoot: input.projectRoot,
    metadata,
  };
  db.query(
    `INSERT INTO agent_endpoints (
       id, agent_id, node_id, harness, transport, state, session_id, cwd,
       project_root, metadata_json, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10)`,
  ).run(
    endpoint.id,
    endpoint.agentId,
    endpoint.nodeId,
    endpoint.harness,
    endpoint.transport,
    endpoint.state,
    endpoint.sessionId ?? null,
    endpoint.projectRoot ?? null,
    JSON.stringify(metadata),
    input.updatedAt ?? BASE + 500,
  );
  return endpoint;
}

function seedInvocation(
  db: ControlPlaneSqliteTransactionalDatabase,
  input: {
    id: string;
    targetAgentId: string;
    conversationId: string;
    createdAt: number;
  },
): InvocationRequest {
  const invocation: InvocationRequest = {
    id: input.id,
    requesterId: OPERATOR_ID,
    requesterNodeId: NODE_ID,
    targetAgentId: input.targetAgentId,
    action: "execute",
    task: "Project current work",
    conversationId: input.conversationId,
    ensureAwake: true,
    stream: true,
    createdAt: input.createdAt,
  };
  db.query(
    `INSERT INTO invocations (
       id, requester_id, requester_node_id, target_agent_id, action, task,
       conversation_id, ensure_awake, stream, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8)`,
  ).run(
    invocation.id,
    invocation.requesterId,
    invocation.requesterNodeId,
    invocation.targetAgentId,
    invocation.action,
    invocation.task,
    invocation.conversationId!,
    invocation.createdAt,
  );
  return invocation;
}

function seedFlight(
  db: ControlPlaneSqliteTransactionalDatabase,
  invocation: InvocationRequest,
  input: {
    id: string;
    state: FlightRecord["state"];
    startedAt?: number;
    completedAt?: number;
  },
): FlightRecord {
  const flight: FlightRecord = {
    id: input.id,
    invocationId: invocation.id,
    requesterId: invocation.requesterId,
    targetAgentId: invocation.targetAgentId,
    state: input.state,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  db.query(
    `INSERT INTO flights (
       id, invocation_id, requester_id, target_agent_id, state, started_at, completed_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at`,
  ).run(
    flight.id,
    flight.invocationId,
    flight.requesterId,
    flight.targetAgentId,
    flight.state,
    flight.startedAt ?? null,
    flight.completedAt ?? null,
  );
  db.query(
    `UPDATE invocations
     SET flight_id = ?2, state = ?3, started_at = ?4, completed_at = ?5
     WHERE id = ?1`,
  ).run(
    invocation.id,
    flight.id,
    flight.state,
    flight.startedAt ?? null,
    flight.completedAt ?? null,
  );
  return flight;
}

function seedConversation(
  db: ControlPlaneSqliteTransactionalDatabase,
  input: {
    id: string;
    kind?: ConversationDefinition["kind"];
    title?: string;
    participantIds: string[];
    metadata?: Record<string, unknown>;
    createdAt?: number;
  },
): ConversationDefinition {
  const conversation: ConversationDefinition = {
    id: input.id,
    kind: input.kind ?? "direct",
    title: input.title ?? input.id,
    visibility: "private",
    shareMode: "local",
    authorityNodeId: NODE_ID,
    participantIds: input.participantIds,
    metadata: input.metadata,
  };
  db.query(
    `INSERT INTO conversations (
       id, kind, title, visibility, share_mode, authority_node_id,
       metadata_json, created_at
     ) VALUES (?1, ?2, ?3, 'private', 'local', ?4, ?5, ?6)`,
  ).run(
    conversation.id,
    conversation.kind,
    conversation.title,
    conversation.authorityNodeId,
    JSON.stringify(input.metadata ?? {}),
    input.createdAt ?? BASE,
  );
  for (const participantId of input.participantIds) {
    db.query(
      "INSERT INTO conversation_members (conversation_id, actor_id) VALUES (?1, ?2)",
    ).run(conversation.id, participantId);
  }
  return conversation;
}

function seedMessage(
  db: ControlPlaneSqliteTransactionalDatabase,
  input: {
    id: string;
    conversationId: string;
    actorId: string;
    body?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
  },
): MessageRecord {
  const message: MessageRecord = {
    id: input.id,
    conversationId: input.conversationId,
    actorId: input.actorId,
    originNodeId: NODE_ID,
    class: input.actorId === OPERATOR_ID ? "operator" : "agent",
    body: input.body ?? input.id,
    visibility: "private",
    policy: "durable",
    createdAt: input.createdAt,
    metadata: input.metadata,
  };
  db.query(
    `INSERT INTO messages (
       id, conversation_id, actor_id, origin_node_id, class, body,
       visibility, policy, metadata_json, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'private', 'durable', ?7, ?8)`,
  ).run(
    message.id,
    message.conversationId,
    message.actorId,
    message.originNodeId,
    message.class,
    message.body,
    JSON.stringify(message.metadata ?? {}),
    message.createdAt,
  );
  return message;
}

function seedReadCursor(
  db: ControlPlaneSqliteTransactionalDatabase,
  input: {
    conversationId: string;
    actorId?: string;
    lastReadAt: number;
  },
): ConversationReadCursor {
  const cursor: ConversationReadCursor = {
    conversationId: input.conversationId,
    actorId: input.actorId ?? OPERATOR_ID,
    readerNodeId: NODE_ID,
    lastReadAt: input.lastReadAt,
    updatedAt: input.lastReadAt,
  };
  db.query(
    `INSERT INTO conversation_read_cursors (
       conversation_id, actor_id, reader_node_id, last_read_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(conversation_id, actor_id) DO UPDATE SET
       last_read_at = excluded.last_read_at,
       updated_at = excluded.updated_at`,
  ).run(cursor.conversationId, cursor.actorId, NODE_ID, cursor.lastReadAt);
  return cursor;
}

function entryForConversation(conversation: ConversationDefinition): BrokerJournalEntry {
  return { kind: "conversation.upsert", conversation };
}

function entryForMessage(message: MessageRecord): BrokerJournalEntry {
  return { kind: "message.record", message };
}

function observedUpdate(
  overrides: Partial<ObservedSessionProjectionUpdate> = {},
): ObservedSessionProjectionUpdate {
  return {
    feedId: "obs:codex:session-observed",
    entityKind: "observed_session",
    source: "codex",
    sourceSessionId: "session-observed",
    runtimeSessionId: "session-observed",
    title: "Observed work",
    project: "openscout",
    projectRoot: "/observed/openscout",
    cwd: "/observed/openscout",
    harness: "codex",
    activityState: "executing",
    preview: "Running focused tests",
    lastActivityAt: BASE + 900,
    sourceFreshAt: BASE + 900,
    lastEventId: "codex:session-observed:1",
    lastEventKind: "tool",
    ...overrides,
  };
}

describe("ConversationProjectionStore", () => {
  test("projects one stable item and one self-contained event for a changed broker batch", () => {
    const { db, projection } = setup();
    const agent = seedAgent(db, { id: "agent-alpha", displayName: "Alpha" });
    const endpoint = seedEndpoint(db, {
      id: "endpoint-alpha",
      agentId: agent.id,
      projectRoot: "/work/alpha-repo",
      sessionId: "session-alpha",
      metadata: {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        branch: "main",
        lastStartedAt: BASE + 500,
      },
      updatedAt: BASE + 600,
    });
    const conversation = seedConversation(db, {
      id: "chat_alpha",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-alpha",
      conversationId: conversation.id,
      actorId: agent.id,
      body: "The projection is ready.",
      createdAt: BASE + 700,
      metadata: { sessionId: "session-from-message" },
    });

    const event = projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
    ]);

    expect(event?.seq).toBe(1);
    expect(event?.delta.notVisible).toEqual([]);
    expect(event?.delta.upserted).toHaveLength(1);
    expect(event?.delta.upserted[0]).toMatchObject({
      feedId: "conv:chat_alpha",
      conversationId: "chat_alpha",
      entityKind: "scout_conversation",
      title: "Alpha Repo",
      runtimeSessionId: "session-from-message",
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      currentBranch: "main",
      activityState: "working",
      messageCount: 1,
      preview: "The projection is ready.",
      visibilityState: "visible",
      updatedSeq: 1,
    });

    const snapshot = projection.snapshot();
    expect(snapshot).toMatchObject({
      projectionId: "projection-test-1",
      projectionVersion: 1,
      sequence: 1,
      total: 1,
      hasMore: false,
      engagedFeedId: null,
    });
    expect(snapshot.items.map((item) => item.feedId)).toEqual(["conv:chat_alpha"]);

    const persistedEvent = db.query<{ seq: number; payload_json: string }>(
      "SELECT seq, payload_json FROM conversation_projection_events",
    ).get();
    expect(persistedEvent?.seq).toBe(1);
    expect(JSON.parse(persistedEvent!.payload_json)).toEqual(event?.delta);
    expect(db.query<{ head_seq: number }>(
      "SELECT head_seq FROM conversation_projection_meta WHERE singleton = 1",
    ).get()?.head_seq).toBe(1);

    expect(projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
    ])).toBeNull();
    expect(projection.snapshot().sequence).toBe(1);
    expect(db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM conversation_projection_events",
    ).get()?.count).toBe(1);
  });

  test("rolls back item and cursor state when the matching event cannot commit", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-atomic", displayName: "Atomic" });
    seedEndpoint(db, { id: "endpoint-atomic", agentId: agent.id, updatedAt: BASE + 100 });
    const conversation = seedConversation(db, {
      id: "chat_atomic",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const first = seedMessage(db, {
      id: "message-1",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 200,
    });
    projection.applyBrokerBatch([entryForConversation(conversation), entryForMessage(first)]);

    const second = seedMessage(db, {
      id: "message-2",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 300,
    });
    db.exec(
      `CREATE TRIGGER reject_conversation_projection_event
       BEFORE INSERT ON conversation_projection_events
       BEGIN
         SELECT RAISE(ABORT, 'test event failure');
       END;`,
    );
    setNow(BASE + 20_000);
    expect(() => projection.applyBrokerBatch([entryForMessage(second)])).toThrow("test event failure");
    expect(projection.snapshot()).toMatchObject({ sequence: 1, total: 1 });
    expect(projection.snapshot().items[0]?.messageCount).toBe(1);
    db.exec("DROP TRIGGER reject_conversation_projection_event;");

    const recovered = projection.applyBrokerBatch([entryForMessage(second)]);
    expect(recovered?.seq).toBe(2);
    expect(recovered?.delta.upserted[0]?.messageCount).toBe(2);
    expect(projection.snapshot()).toMatchObject({ sequence: 2, total: 1 });
  });

  test("preserves operator read-cursor unread semantics and engagement", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-unread", displayName: "Unread" });
    seedEndpoint(db, { id: "endpoint-unread", agentId: agent.id, updatedAt: BASE + 50 });
    const conversation = seedConversation(db, {
      id: "chat_unread",
      participantIds: [OPERATOR_ID, "Arach", agent.id],
    });
    const oldAgent = seedMessage(db, {
      id: "message-old-agent",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 1_000,
    });
    const unreadAgent = seedMessage(db, {
      id: "message-unread-agent",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 3_000,
    });
    const legacySecondAgent = seedMessage(db, {
      id: "message-unread-seconds",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: Math.floor((BASE + 6_000) / 1_000),
    });
    const operatorReply = seedMessage(db, {
      id: "message-operator",
      conversationId: conversation.id,
      actorId: OPERATOR_ID,
      createdAt: BASE + 4_000,
    });
    seedReadCursor(db, {
      conversationId: conversation.id,
      actorId: OPERATOR_ID,
      lastReadAt: BASE + 1_500,
    });
    const furthest = seedReadCursor(db, {
      conversationId: conversation.id,
      actorId: "Arach",
      lastReadAt: Math.floor((BASE + 2_000) / 1_000),
    });

    const first = projection.applyBrokerBatch([
      entryForConversation(conversation),
      entryForMessage(oldAgent),
      entryForMessage(unreadAgent),
      entryForMessage(legacySecondAgent),
      entryForMessage(operatorReply),
      { kind: "conversation.read_cursor.upsert", cursor: furthest },
    ]);
    expect(first?.delta.upserted[0]).toMatchObject({
      unreadCount: 2,
      lastEngagedAt: BASE + 2_000,
      lastMessageId: "message-unread-seconds",
      lastMessageAt: BASE + 6_000,
    });

    const caughtUp = seedReadCursor(db, {
      conversationId: conversation.id,
      lastReadAt: BASE + 7_000,
    });
    setNow(BASE + 30_000);
    const second = projection.applyBrokerBatch([
      { kind: "conversation.read_cursor.upsert", cursor: caughtUp },
    ]);
    expect(second?.seq).toBe(2);
    expect(second?.delta.upserted[0]).toMatchObject({
      unreadCount: 0,
      lastEngagedAt: BASE + 7_000,
    });
    expect(projection.snapshot().engagedFeedId).toBe("conv:chat_unread");
  });

  test("does not project endpoint heartbeat timestamps as conversation activity", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-heartbeat", displayName: "Heartbeat" });
    const endpoint = seedEndpoint(db, {
      id: "endpoint-heartbeat",
      agentId: agent.id,
      projectRoot: "/work/heartbeat",
      metadata: {
        model: "gpt-5.6-sol",
        lastStartedAt: BASE + 100,
        lastSeenAt: BASE + 200,
      },
      updatedAt: BASE + 200,
    });
    const conversation = seedConversation(db, {
      id: "chat_heartbeat",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-heartbeat",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 300,
    });
    projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
    ]);
    const before = projection.snapshot();

    const heartbeatAt = BASE + 100_000;
    db.query(
      "UPDATE agent_endpoints SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3",
    ).run(JSON.stringify({
      model: "gpt-5.6-sol",
      lastStartedAt: BASE + 100,
      lastSeenAt: heartbeatAt,
    }), heartbeatAt, endpoint.id);
    setNow(heartbeatAt);
    const heartbeatEndpoint: AgentEndpoint = {
      ...endpoint,
      metadata: {
        ...endpoint.metadata,
        lastSeenAt: heartbeatAt,
      },
    };
    expect(projection.applyBrokerBatch([
      { kind: "agent.endpoint.upsert", endpoint: heartbeatEndpoint },
    ])).toBeNull();
    expect(projection.snapshot().sequence).toBe(before.sequence);
    expect(projection.snapshot().items[0]?.lastActivityAt).toBe(
      before.items[0]?.lastActivityAt,
    );
  });

  test("projects queued, running, waiting, and completed flight state ahead of endpoint presence", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-flight", displayName: "Flight" });
    const endpoint = seedEndpoint(db, {
      id: "endpoint-flight",
      agentId: agent.id,
      state: "active",
      metadata: { lastStartedAt: BASE + 100 },
      updatedAt: BASE + 100,
    });
    const conversation = seedConversation(db, {
      id: "chat_flight-state",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-flight",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 200,
    });
    projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
    ]);

    const invocation = seedInvocation(db, {
      id: "inv-flight",
      targetAgentId: agent.id,
      conversationId: conversation.id,
      createdAt: BASE + 300,
    });
    let flight = seedFlight(db, invocation, {
      id: "flight-state",
      state: "queued",
    });
    setNow(BASE + 301);
    expect(projection.applyBrokerBatch([
      { kind: "invocation.record", invocation },
      { kind: "flight.record", flight },
    ])?.delta.upserted[0]?.activityState).toBe("queued");

    flight = seedFlight(db, invocation, {
      id: flight.id,
      state: "running",
      startedAt: BASE + 400,
    });
    setNow(BASE + 401);
    expect(projection.applyBrokerBatch([{ kind: "flight.record", flight }])
      ?.delta.upserted[0]?.activityState).toBe("working");

    flight = seedFlight(db, invocation, {
      id: flight.id,
      state: "waiting",
      startedAt: BASE + 400,
    });
    setNow(BASE + 402);
    expect(projection.applyBrokerBatch([{ kind: "flight.record", flight }])
      ?.delta.upserted[0]?.activityState).toBe("waiting_for_input");

    flight = seedFlight(db, invocation, {
      id: flight.id,
      state: "completed",
      startedAt: BASE + 400,
      completedAt: BASE + 500,
    });
    setNow(BASE + 501);
    expect(projection.applyBrokerBatch([{ kind: "flight.record", flight }])
      ?.delta.upserted[0]?.activityState).toBe("completed");

    const laterEndpoint: AgentEndpoint = {
      ...endpoint,
      metadata: { lastStartedAt: BASE + 600 },
    };
    db.query("UPDATE agent_endpoints SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3")
      .run(JSON.stringify(laterEndpoint.metadata), BASE + 600, endpoint.id);
    setNow(BASE + 601);
    expect(projection.applyBrokerBatch([
      { kind: "agent.endpoint.upsert", endpoint: laterEndpoint },
    ])?.delta.upserted[0]?.activityState).toBe("working");
  });

  test("coalesces named channels and redirects identity when the stable channel appears", () => {
    const { db, projection, setNow } = setup();
    const naturalKey = "channel:shared";
    const legacy = seedConversation(db, {
      id: "chat_legacy-shared",
      kind: "channel",
      title: "Shared legacy",
      participantIds: [OPERATOR_ID],
      metadata: { naturalKey, channel: "shared" },
    });
    seedMessage(db, {
      id: "message-shared-legacy",
      conversationId: legacy.id,
      actorId: OPERATOR_ID,
      body: "Legacy history",
      createdAt: BASE + 100,
    });
    const first = projection.reconcileAll();
    expect(first?.delta.upserted.map((item) => item.feedId)).toEqual([
      "conv:chat_legacy-shared",
    ]);

    const member = seedAgent(db, { id: "agent-shared", displayName: "Shared Agent" });
    const canonical = seedConversation(db, {
      id: stableChannelId(naturalKey),
      kind: "channel",
      title: "Shared",
      participantIds: [OPERATOR_ID, member.id],
      metadata: { naturalKey, channel: "shared" },
    });
    const latest = seedMessage(db, {
      id: "message-shared-stable",
      conversationId: canonical.id,
      actorId: member.id,
      body: "Canonical history",
      createdAt: BASE + 200,
    });
    setNow(BASE + 70_000);
    const second = projection.applyBrokerBatch([
      entryForConversation(canonical),
      entryForMessage(latest),
    ]);
    const canonicalFeedId = `conv:${canonical.id}`;
    expect(second?.seq).toBe(2);
    expect(second?.delta.notVisible).toEqual(["conv:chat_legacy-shared"]);
    expect(second?.delta.identityRedirects).toEqual([{
      fromFeedId: "conv:chat_legacy-shared",
      toFeedId: canonicalFeedId,
    }]);
    expect(second?.delta.upserted).toHaveLength(1);
    expect(second?.delta.upserted[0]).toMatchObject({
      feedId: canonicalFeedId,
      conversationId: canonical.id,
      messageCount: 2,
      participantCount: 2,
      preview: "Canonical history",
    });
    const snapshot = projection.snapshot();
    expect(snapshot.items.map((item) => item.feedId)).toEqual([canonicalFeedId]);
    expect(snapshot.identityRedirects).toEqual([{
      fromFeedId: "conv:chat_legacy-shared",
      toFeedId: canonicalFeedId,
    }]);
    expect(projection.applyBrokerBatch([
      entryForConversation(canonical),
      entryForMessage(latest),
    ])).toBeNull();
  });

  test("full reconciliation is idempotent and the launch snapshot defaults to 32 items", () => {
    const { db, projection, setNow } = setup();
    const messages: MessageRecord[] = [];
    for (let index = 0; index < 35; index += 1) {
      const conversation = seedConversation(db, {
        id: `chat_channel-${index.toString().padStart(2, "0")}`,
        kind: "channel",
        title: `Channel ${index}`,
        participantIds: [OPERATOR_ID],
        createdAt: BASE + index,
      });
      messages.push(seedMessage(db, {
        id: `message-channel-${index.toString().padStart(2, "0")}`,
        conversationId: conversation.id,
        actorId: OPERATOR_ID,
        createdAt: BASE + 1_000 + index,
      }));
    }

    const event = projection.reconcileAll();
    expect(event?.seq).toBe(1);
    expect(event?.delta.upserted).toHaveLength(35);
    const snapshot = projection.snapshot();
    expect(snapshot.items).toHaveLength(CONVERSATION_PROJECTION_LAUNCH_LIMIT);
    expect(snapshot.total).toBe(35);
    expect(snapshot.hasMore).toBe(true);
    expect(snapshot.items[0]?.conversationId).toBe("chat_channel-34");
    expect(snapshot.items.at(-1)?.conversationId).toBe("chat_channel-03");

    setNow(BASE + 40_000);
    expect(projection.reconcileAll()).toBeNull();
    expect(projection.snapshot().sequence).toBe(1);
  });

  test("updates a 10k-member channel with a long transcript from incremental aggregates", () => {
    const { db, projection } = setup();
    const conversation = seedConversation(db, {
      id: "chat_large-materialized",
      kind: "channel",
      title: "Large materialized channel",
      participantIds: [OPERATOR_ID],
    });
    const memberCount = 10_643;
    const historicalMessageCount = 20_000;
    db.transaction(() => {
      for (let index = 1; index < memberCount; index += 1) {
        const actorId = `large-member-${index}`;
        db.query(
          `INSERT INTO actors (id, kind, display_name, created_at)
           VALUES (?1, 'person', ?1, ?2)`,
        ).run(actorId, BASE);
        db.query(
          `INSERT INTO conversation_members (conversation_id, actor_id)
           VALUES (?1, ?2)`,
        ).run(conversation.id, actorId);
      }
      for (let index = 0; index < historicalMessageCount; index += 1) {
        db.query(
          `INSERT INTO messages (
             id, conversation_id, actor_id, origin_node_id, class, body,
             visibility, policy, created_at
           ) VALUES (?1, ?2, ?3, ?4, 'operator', ?1, 'private', 'durable', ?5)`,
        ).run(
          `large-message-${index.toString().padStart(5, "0")}`,
          conversation.id,
          OPERATOR_ID,
          NODE_ID,
          BASE + index,
        );
      }
    })();
    projection.reconcileAll();

    const appended = seedMessage(db, {
      id: "large-message-appended",
      conversationId: conversation.id,
      actorId: OPERATOR_ID,
      createdAt: BASE + historicalMessageCount + 1,
    });
    const startedAt = performance.now();
    const event = projection.applyBrokerBatch([entryForMessage(appended)]);
    const elapsedMs = performance.now() - startedAt;

    expect(event?.delta.upserted[0]).toMatchObject({
      messageCount: historicalMessageCount + 1,
      participantCount: memberCount,
      lastMessageId: appended.id,
    });
    // This is deliberately generous for shared CI. The old roster/history
    // materialization path scales with 30k rows and is far above this bound;
    // the aggregate path is normally single-digit milliseconds on the target.
    expect(elapsedMs).toBeLessThan(250);
  });

  test("reprojects both conversations when a retained message id moves", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-message-move", displayName: "Mover" });
    const source = seedConversation(db, {
      id: "chat_message-move-source",
      kind: "channel",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const destination = seedConversation(db, {
      id: "chat_message-move-destination",
      kind: "channel",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-moved",
      conversationId: source.id,
      actorId: agent.id,
      body: "Move me exactly once",
      createdAt: BASE + 300,
    });
    projection.reconcileAll();

    const moved: MessageRecord = { ...message, conversationId: destination.id };
    db.query(
      "UPDATE messages SET conversation_id = ?1 WHERE id = ?2",
    ).run(destination.id, message.id);
    setNow(BASE + 20_000);
    const event = projection.applyBrokerBatch([entryForMessage(moved)]);

    expect(event?.delta.upserted.map((item) => item.conversationId).sort()).toEqual([
      destination.id,
      source.id,
    ].sort());
    const byConversation = new Map(
      projection.snapshot().items.map((item) => [item.conversationId, item]),
    );
    expect(byConversation.get(source.id)).toMatchObject({
      messageCount: 0,
      lastMessageId: null,
      preview: null,
    });
    expect(byConversation.get(destination.id)).toMatchObject({
      messageCount: 1,
      lastMessageId: message.id,
      preview: message.body,
    });
  });

  test("recounts unread state when a repeated message id changes actor", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-message-actor", displayName: "Actor" });
    const conversation = seedConversation(db, {
      id: "chat_message-actor",
      kind: "channel",
      participantIds: [OPERATOR_ID, agent.id],
    });
    seedReadCursor(db, {
      conversationId: conversation.id,
      lastReadAt: BASE + 100,
    });
    const message = seedMessage(db, {
      id: "message-actor-correction",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 200,
    });
    projection.reconcileAll();
    expect(projection.snapshot().items[0]?.unreadCount).toBe(1);

    const corrected: MessageRecord = {
      ...message,
      actorId: OPERATOR_ID,
      class: "operator",
    };
    db.query(
      "UPDATE messages SET actor_id = ?1, class = 'operator' WHERE id = ?2",
    ).run(OPERATOR_ID, message.id);
    setNow(BASE + 20_000);
    const event = projection.applyBrokerBatch([entryForMessage(corrected)]);

    expect(event?.delta.upserted[0]).toMatchObject({
      conversationId: conversation.id,
      messageCount: 1,
      unreadCount: 0,
    });
  });

  test("emits notVisible when canonical agent state retires a projected direct chat", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-retired", displayName: "Retired" });
    seedEndpoint(db, { id: "endpoint-retired", agentId: agent.id, updatedAt: BASE + 100 });
    const conversation = seedConversation(db, {
      id: "chat_retired",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-retired",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 200,
    });
    projection.applyBrokerBatch([entryForConversation(conversation), entryForMessage(message)]);
    expect(projection.snapshot().total).toBe(1);

    db.query("UPDATE agents SET metadata_json = ?1 WHERE id = ?2")
      .run('{"retiredFromFleet":true}', agent.id);
    setNow(BASE + 50_000);
    const retiredAgent: AgentDefinition = {
      ...agent,
      metadata: { retiredFromFleet: true },
    };
    const event = projection.applyBrokerBatch([{ kind: "agent.upsert", agent: retiredAgent }]);
    expect(event?.seq).toBe(2);
    expect(event?.delta.upserted).toEqual([]);
    expect(event?.delta.notVisible).toEqual(["conv:chat_retired"]);
    expect(projection.snapshot()).toMatchObject({ sequence: 2, total: 0 });
  });

  test("pages whole projection events and expires cursors from another lineage", () => {
    const { db, projection, setNow } = setup();
    const agent = seedAgent(db, { id: "agent-events", displayName: "Events" });
    seedEndpoint(db, { id: "endpoint-events", agentId: agent.id, updatedAt: BASE + 100 });
    const conversation = seedConversation(db, {
      id: "chat_events",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const first = seedMessage(db, {
      id: "message-events-1",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 200,
    });
    projection.applyBrokerBatch([entryForConversation(conversation), entryForMessage(first)]);
    const second = seedMessage(db, {
      id: "message-events-2",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 300,
    });
    setNow(BASE + 60_000);
    projection.applyBrokerBatch([entryForMessage(second)]);

    const firstPage = projection.eventsSince({ projectionId: "projection-test-1", seq: 0 }, 1);
    expect(firstPage).toMatchObject({
      cursorExpired: false,
      headSeq: 2,
      hasMore: true,
    });
    expect(firstPage.events.map((event) => event.seq)).toEqual([1]);
    const secondPage = projection.eventsSince({ projectionId: "projection-test-1", seq: 1 }, 1);
    expect(secondPage.events.map((event) => event.seq)).toEqual([2]);
    expect(secondPage.hasMore).toBe(false);

    expect(projection.eventsSince({ projectionId: "old-projection", seq: 2 })).toMatchObject({
      cursorExpired: true,
      reason: "projection_reset",
      events: [],
      hasMore: false,
    });
  });

  test("prunes replay events by age and row budget while maintaining the cursor floor", () => {
    const { db, projection, setNow } = setup({
      eventRetentionMs: 1_000,
      eventMaxRows: 2,
      eventPruneInterval: 1,
    });
    const agent = seedAgent(db, { id: "agent-retention", displayName: "Retention" });
    seedEndpoint(db, { id: "endpoint-retention", agentId: agent.id });
    const conversation = seedConversation(db, {
      id: "chat_retention",
      participantIds: [OPERATOR_ID, agent.id],
    });

    for (let index = 1; index <= 3; index += 1) {
      const message = seedMessage(db, {
        id: `message-retention-${index}`,
        conversationId: conversation.id,
        actorId: agent.id,
        createdAt: BASE + index,
      });
      setNow(BASE + 10_000 + index);
      projection.applyBrokerBatch([
        ...(index === 1 ? [entryForConversation(conversation)] : []),
        entryForMessage(message),
      ]);
    }

    expect(projection.meta()).toMatchObject({ headSeq: 3, minReplayableSeq: 2 });
    expect(projection.eventsSince({ projectionId: "projection-test-1", seq: 0 })).toMatchObject({
      cursorExpired: true,
      reason: "cursor_too_old",
    });
    expect(projection.eventsSince({ projectionId: "projection-test-1", seq: 1 })).toMatchObject({
      cursorExpired: false,
      events: [expect.objectContaining({ seq: 2 }), expect.objectContaining({ seq: 3 })],
    });

    setNow(BASE + 20_000);
    const finalMessage = seedMessage(db, {
      id: "message-retention-4",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 4,
    });
    projection.applyBrokerBatch([entryForMessage(finalMessage)]);
    expect(projection.meta()).toMatchObject({ headSeq: 4, minReplayableSeq: 4 });
    expect(db.query<{ seq: number }>(
      "SELECT seq FROM conversation_projection_events ORDER BY seq",
    ).all()).toEqual([{ seq: 4 }]);
  });

  test("enforces the replay event byte budget using UTF-8 bytes", () => {
    const { db, projection, setNow } = setup({
      eventRetentionMs: 60_000,
      eventMaxRows: 100,
      eventMaxBytes: 2_000,
      eventPruneInterval: 1,
    });
    const agent = seedAgent(db, { id: "agent-unicode", displayName: "Unicode" });
    seedEndpoint(db, { id: "endpoint-unicode", agentId: agent.id });
    const conversation = seedConversation(db, {
      id: "chat_unicode-budget",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const largePreview = "🚀".repeat(160);

    for (let index = 1; index <= 3; index += 1) {
      const message = seedMessage(db, {
        id: `message-unicode-${index}`,
        conversationId: conversation.id,
        actorId: agent.id,
        body: `${largePreview}${index}`,
        createdAt: BASE + index,
      });
      setNow(BASE + 30_000 + index);
      projection.applyBrokerBatch([
        ...(index === 1 ? [entryForConversation(conversation)] : []),
        entryForMessage(message),
      ]);
    }

    const retained = db.query<{
      seq: number;
      text_length: number;
      byte_length: number;
    }>(
      `SELECT seq,
              length(payload_json) AS text_length,
              length(CAST(payload_json AS BLOB)) AS byte_length
       FROM conversation_projection_events
       ORDER BY seq`,
    ).all();
    expect(retained).toHaveLength(1);
    expect(retained[0]?.seq).toBe(3);
    expect(retained[0]!.byte_length).toBeGreaterThan(retained[0]!.text_length);
    expect(projection.meta().minReplayableSeq).toBe(3);
  });

  test("projects coalesced observed sessions without importing transcript messages", () => {
    const { db, projection } = setup();
    const update = observedUpdate();

    const event = projection.applyObservedSessionBatch([update]);

    expect(event?.seq).toBe(1);
    expect(event?.delta.upserted).toEqual([
      expect.objectContaining({
        feedId: update.feedId,
        entityKind: "observed_session",
        conversationId: null,
        runtimeSessionId: update.runtimeSessionId,
        harness: "codex",
        activityState: "executing",
        projectRoot: "/observed/openscout",
        preview: "Running focused tests",
        messageCount: 0,
        visibilityState: "visible",
      }),
    ]);
    expect(projection.snapshot()).toMatchObject({ sequence: 1, total: 1 });
    expect(db.query<{ count: number }>("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(0);
    expect(db.query<{ feed_id: string }>(
      `SELECT feed_id FROM conversation_projection_sources
       WHERE source = 'codex' AND source_session_id = 'session-observed'`,
    ).get()?.feed_id).toBe(update.feedId);

    expect(projection.applyObservedSessionBatch([update])).toBeNull();
    expect(projection.snapshot().sequence).toBe(1);
    expect(projection.applyObservedSessionBatch([
      observedUpdate({
        sourceFreshAt: BASE + 100,
        lastActivityAt: BASE + 100,
        preview: "stale",
      }),
    ])).toBeNull();
    expect(projection.snapshot().items[0]?.preview).toBe("Running focused tests");
  });

  test("returns bounded persisted active observed rows for restart lifecycle hydration", () => {
    const { db, projection } = setup();
    const active = observedUpdate();
    const terminal = observedUpdate({
      feedId: "obs:kimi:session-terminal",
      source: "kimi",
      sourceSessionId: "session-terminal",
      runtimeSessionId: "session-terminal",
      harness: "kimi",
      activityState: "completed",
      lastActivityAt: BASE + 1_000,
      sourceFreshAt: BASE + 1_000,
    });
    projection.applyObservedSessionBatch([active, terminal]);
    db.query(
      "UPDATE conversation_projection_items SET visibility_state = 'hidden' WHERE feed_id = ?1",
    ).run(active.feedId);

    expect(projection.persistedActiveObservedSessionUpdates()).toEqual([
      expect.objectContaining({
        feedId: active.feedId,
        source: "codex",
        sourceSessionId: "session-observed",
        activityState: "executing",
        projectRoot: "/observed/openscout",
        lastActivityAt: BASE + 900,
        sourceFreshAt: BASE + 900,
      }),
    ]);
  });

  test("does not merge equal runtime session ids across different harnesses", () => {
    const { db, projection } = setup();
    const update = observedUpdate({
      source: "codex",
      harness: "codex",
      sourceSessionId: "shared-native-id",
      runtimeSessionId: "shared-native-id",
      feedId: "obs:codex:shared-native-id",
    });
    projection.applyObservedSessionBatch([update]);

    const agent = seedAgent(db, { id: "agent-claude", displayName: "Claude" });
    const endpoint = seedEndpoint(db, {
      id: "endpoint-claude",
      agentId: agent.id,
      harness: "claude",
      sessionId: update.runtimeSessionId,
      projectRoot: "/work/claude",
    });
    const conversation = seedConversation(db, {
      id: "chat_claude-shared-id",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-claude-shared-id",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 1_000,
    });

    projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
    ]);

    expect(projection.snapshot().items.map((item) => item.feedId).sort()).toEqual([
      `conv:${conversation.id}`,
      update.feedId,
    ].sort());
    expect(db.query<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM conversation_projection_sources
       WHERE source = 'codex' AND source_session_id = 'shared-native-id'
         AND feed_id = ?1`,
    ).get(`conv:${conversation.id}`)?.count).toBe(0);
  });

  test("links an observed session to its Scout conversation without clobbering broker fields", () => {
    const { db, projection, setNow } = setup();
    const update = observedUpdate();
    projection.applyObservedSessionBatch([update]);

    const agent = seedAgent(db, { id: "agent-linked", displayName: "Linked" });
    const endpoint = seedEndpoint(db, {
      id: "endpoint-linked",
      agentId: agent.id,
      projectRoot: "/broker/linked-repo",
      sessionId: update.runtimeSessionId,
      metadata: {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        branch: "main",
        lastStartedAt: BASE + 500,
      },
      updatedAt: BASE + 600,
    });
    const conversation = seedConversation(db, {
      id: "chat_linked",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-linked",
      conversationId: conversation.id,
      actorId: agent.id,
      body: "Broker-authored preview",
      createdAt: BASE + 700,
      metadata: { sessionId: update.runtimeSessionId },
    });
    setNow(BASE + 20_000);

    const linked = projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
    ]);

    expect(linked?.seq).toBe(2);
    expect(linked?.delta.notVisible).toEqual([update.feedId]);
    expect(linked?.delta.identityRedirects).toEqual([{
      fromFeedId: update.feedId,
      toFeedId: "conv:chat_linked",
    }]);
    const snapshot = projection.snapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      feedId: "conv:chat_linked",
      entityKind: "scout_conversation",
      conversationId: "chat_linked",
      runtimeSessionId: update.runtimeSessionId,
      source: "codex",
      sourceSessionId: update.sourceSessionId,
      title: "Linked Repo",
      projectRoot: "/broker/linked-repo",
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      currentBranch: "main",
      preview: "Broker-authored preview",
      activityState: "executing",
      visibilityState: "visible",
    });
    expect(snapshot.identityRedirects).toEqual([{
      fromFeedId: update.feedId,
      toFeedId: "conv:chat_linked",
    }]);
    expect(db.query<{ feed_id: string }>(
      `SELECT feed_id FROM conversation_projection_sources
       WHERE source = 'codex' AND source_session_id = 'session-observed'`,
    ).get()?.feed_id).toBe("conv:chat_linked");

    expect(projection.applyObservedSessionBatch([update])).toBeNull();
    expect(projection.snapshot().sequence).toBe(2);
  });

  test("lets newer linked observed work supersede an older completed invocation", () => {
    const { db, projection } = setup();
    const agent = seedAgent(db, { id: "agent-linked-completed", displayName: "Linked" });
    const endpoint = seedEndpoint(db, {
      id: "endpoint-linked-completed",
      agentId: agent.id,
      sessionId: "session-observed",
      metadata: { lastStartedAt: BASE + 100 },
      updatedAt: BASE + 100,
    });
    const conversation = seedConversation(db, {
      id: "chat_linked-completed",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-linked-completed",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 200,
      metadata: { sessionId: "session-observed" },
    });
    const invocation = seedInvocation(db, {
      id: "inv-linked-completed",
      targetAgentId: agent.id,
      conversationId: conversation.id,
      createdAt: BASE + 300,
    });
    const flight = seedFlight(db, invocation, {
      id: "flight-linked-completed",
      state: "completed",
      startedAt: BASE + 350,
      completedAt: BASE + 400,
    });

    projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
      { kind: "invocation.record", invocation },
      { kind: "flight.record", flight },
    ]);
    expect(projection.snapshot().items[0]?.activityState).toBe("completed");

    projection.applyObservedSessionBatch([observedUpdate({
      activityState: "working",
      lastActivityAt: BASE + 401,
      sourceFreshAt: BASE + 401,
    })]);

    expect(projection.snapshot().items).toHaveLength(1);
    expect(projection.snapshot().items[0]).toMatchObject({
      feedId: "conv:chat_linked-completed",
      activityState: "working",
      lastActivityAt: BASE + 401,
    });
  });

  test("keeps broker attention authoritative over newer linked observed work", () => {
    const { db, projection } = setup();
    const agent = seedAgent(db, { id: "agent-linked-waiting", displayName: "Linked" });
    const endpoint = seedEndpoint(db, {
      id: "endpoint-linked-waiting",
      agentId: agent.id,
      sessionId: "session-observed",
      metadata: { lastStartedAt: BASE + 100 },
      updatedAt: BASE + 100,
    });
    const conversation = seedConversation(db, {
      id: "chat_linked-waiting",
      participantIds: [OPERATOR_ID, agent.id],
    });
    const message = seedMessage(db, {
      id: "message-linked-waiting",
      conversationId: conversation.id,
      actorId: agent.id,
      createdAt: BASE + 200,
      metadata: { sessionId: "session-observed" },
    });
    const invocation = seedInvocation(db, {
      id: "inv-linked-waiting",
      targetAgentId: agent.id,
      conversationId: conversation.id,
      createdAt: BASE + 300,
    });
    const flight = seedFlight(db, invocation, {
      id: "flight-linked-waiting",
      state: "waiting",
      startedAt: BASE + 400,
    });

    projection.applyBrokerBatch([
      entryForConversation(conversation),
      { kind: "agent.endpoint.upsert", endpoint },
      entryForMessage(message),
      { kind: "invocation.record", invocation },
      { kind: "flight.record", flight },
    ]);
    expect(projection.snapshot().items[0]?.activityState).toBe("waiting_for_input");

    projection.applyObservedSessionBatch([observedUpdate({
      activityState: "working",
      lastActivityAt: BASE + 401,
      sourceFreshAt: BASE + 401,
    })]);

    expect(projection.snapshot().items).toHaveLength(1);
    expect(projection.snapshot().items[0]).toMatchObject({
      feedId: "conv:chat_linked-waiting",
      activityState: "waiting_for_input",
      lastActivityAt: BASE + 401,
    });
  });
});
