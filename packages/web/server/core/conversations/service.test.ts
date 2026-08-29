import { afterAll, describe, expect, mock, test } from "bun:test";
import { namedChannelNaturalKey, stableChannelId } from "@openscout/protocol";

let brokerContextResult: unknown = null;

mock.module("../broker/service.ts", () => ({
  loadScoutBrokerContext: async () => brokerContextResult,
}));

const { getScoutConversationMessages, getScoutConversations } = await import("./service.ts");

const {
  MAX_MESSAGE_PAGE_LIMIT,
  MessageCursorError,
  compareMessagesAsc,
  encodeMessageHistoryCursor,
} = await import("../../../shared/message-pagination.ts");

mock.restore();

afterAll(() => {
  mock.restore();
});

function baseSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    nodes: {
      "node-1": { id: "node-1", name: "node-1" },
    },
    actors: {
      operator: {
        id: "operator",
        displayName: "Operator",
      },
      "hudson.main.mini": {
        id: "hudson.main.mini",
        displayName: "Hudson",
        handle: "hudson",
      },
    },
    agents: {
      "hudson.main.mini": {
        id: "hudson.main.mini",
        kind: "agent",
        definitionId: "hudson",
        displayName: "Hudson",
        handle: "hudson",
        agentClass: "general",
        capabilities: ["chat", "invoke", "deliver"],
        wakePolicy: "on_demand",
        homeNodeId: "node-1",
        authorityNodeId: "node-1",
        advertiseScope: "local",
        metadata: {
          staleLocalRegistration: true,
          branch: "main",
        },
      },
    },
    endpoints: {
      "ep-hudson-main": {
        id: "ep-hudson-main",
        agentId: "hudson.main.mini",
        nodeId: "node-1",
        harness: "claude",
        transport: "claude_stream_json",
        state: "offline",
        projectRoot: "/Users/arach/dev/hudson",
        metadata: {
          staleLocalRegistration: true,
          branch: "main",
        },
      },
    },
    conversations: {
      "chat_hudson-main": {
        id: "chat_hudson-main",
        kind: "direct",
        title: "Hudson",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: ["operator", "hudson.main.mini"],
      },
    },
    messages: {
      "msg-1": {
        id: "msg-1",
        conversationId: "chat_hudson-main",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: "hello",
        visibility: "private",
        policy: "durable",
        createdAt: 1_779_461_700_000,
      },
    },
    flights: {},
    ...overrides,
  };
}

function brokerContext(snapshot: ReturnType<typeof baseSnapshot>) {
  return { baseUrl: "http://broker.test", node: { id: "node-1" }, snapshot };
}

function seedBrokerMessages(
  snapshot: ReturnType<typeof baseSnapshot>,
  indexes: number[],
): void {
  for (const index of indexes) {
    snapshot.messages[`msg-${index}`] = {
      id: `msg-${index}`,
      conversationId: "chat_hudson-main",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: `message ${index}`,
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_700_000 + index,
    };
  }
}

describe("getScoutConversations", () => {
  test("applies machine scope before the recent conversation limit", async () => {
    const snapshot = baseSnapshot();
    snapshot.nodes["node-2"] = { id: "node-2", name: "node-2" };
    snapshot.actors["agent-2"] = {
      id: "agent-2",
      kind: "agent",
      displayName: "Remote Agent",
    };
    snapshot.agents["agent-2"] = {
      id: "agent-2",
      kind: "agent",
      definitionId: "remote-agent",
      displayName: "Remote Agent",
      agentClass: "general",
      capabilities: ["chat"],
      wakePolicy: "on_demand",
      homeNodeId: "node-2",
      authorityNodeId: "node-2",
      advertiseScope: "local",
    };
    snapshot.conversations["chat_remote-agent"] = {
      id: "chat_remote-agent",
      kind: "direct",
      title: "Remote Agent",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-2",
      participantIds: ["operator", "agent-2"],
    };
    snapshot.messages["msg-remote"] = {
      id: "msg-remote",
      conversationId: "chat_remote-agent",
      actorId: "agent-2",
      originNodeId: "node-2",
      class: "agent",
      body: "newer remote message",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_900_000,
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations({
      machineId: "node-1",
      limit: 1,
    });

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      "chat_hudson-main",
    ]);
  });

  test("coalesces duplicate named channels and preserves their combined history", async () => {
    const snapshot = baseSnapshot();
    const naturalKey = namedChannelNaturalKey("engineering-ci");
    const canonicalId = stableChannelId(naturalKey);
    snapshot.actors["session-gauss"] = {
      id: "session-gauss",
      kind: "session",
      displayName: "openscout-gauss-4",
    };
    snapshot.conversations["channel.engineering-ci"] = {
      id: "channel.engineering-ci",
      kind: "channel",
      title: "engineering-ci",
      visibility: "workspace",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", "hudson.main.mini"],
      metadata: { channel: "engineering-ci" },
    };
    snapshot.conversations[canonicalId] = {
      id: canonicalId,
      kind: "channel",
      title: "engineering-ci",
      visibility: "workspace",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", "session-gauss"],
      metadata: { naturalKey, channel: "engineering-ci" },
    };
    snapshot.messages["msg-engineering-a"] = {
      id: "msg-engineering-a",
      conversationId: "channel.engineering-ci",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "Hudson report",
      visibility: "workspace",
      policy: "durable",
      createdAt: 1_779_461_800_000,
    };
    snapshot.messages["msg-engineering-b"] = {
      id: "msg-engineering-b",
      conversationId: canonicalId,
      actorId: "session-gauss",
      originNodeId: "node-1",
      class: "agent",
      body: "OpenScout report",
      visibility: "workspace",
      policy: "durable",
      createdAt: 1_779_461_900_000,
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();
    const engineering = conversations.filter((entry) => entry.naturalKey === "channel:engineering-ci");
    expect(engineering).toHaveLength(1);
    expect(engineering[0]).toMatchObject({
      id: canonicalId,
      equivalentConversationIds: [canonicalId, "channel.engineering-ci"].sort(),
      messageCount: 2,
      preview: "OpenScout report",
      participantIds: ["hudson.main.mini", "operator", "session-gauss"],
    });

    const messages = await getScoutConversationMessages(canonicalId, 80);
    expect(messages?.map((message) => ({ id: message.id, conversationId: message.conversationId }))).toEqual([
      { id: "msg-engineering-a", conversationId: canonicalId },
      { id: "msg-engineering-b", conversationId: canonicalId },
    ]);
  });

  test("keeps cardless channel sessions legible by harness after endpoint rotation", async () => {
    const snapshot = baseSnapshot();
    const channelId = stableChannelId(namedChannelNaturalKey("mcp-feedback"));
    const sessions = [
      {
        id: "session-grok-channel",
        displayName: "openscout-machiavelli-5",
        handle: "project-machiavelli-5",
        harness: "grok-acp",
        transport: "grok_acp",
      },
      {
        id: "session-kimi-channel",
        displayName: "openscout-fourier-2",
        handle: "project-fourier-2",
        harness: "kimi",
        transport: "kimi_acp",
      },
    ] as const;

    for (const session of sessions) {
      snapshot.actors[session.id] = {
        id: session.id,
        kind: "session",
        displayName: session.displayName,
        handle: session.handle,
        labels: ["cardless-session", "session"],
        metadata: {
          source: "scout-cardless-session",
          sessionBacked: true,
          cardless: true,
          handle: session.handle,
          harness: session.harness,
          transport: session.transport,
          sessionId: session.id,
          projectRoot: "/Users/arach/dev/openscout",
        },
      };
    }

    snapshot.conversations[channelId] = {
      id: channelId,
      kind: "channel",
      title: "mcp-feedback",
      visibility: "workspace",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", ...sessions.map((session) => session.id)],
      metadata: {
        naturalKey: namedChannelNaturalKey("mcp-feedback"),
        channel: "mcp-feedback",
      },
    };
    snapshot.messages["msg-mcp-feedback-grok"] = {
      id: "msg-mcp-feedback-grok",
      conversationId: channelId,
      actorId: "session-grok-channel",
      originNodeId: "node-1",
      class: "agent",
      body: "Grok feedback",
      visibility: "workspace",
      policy: "durable",
      createdAt: 1_779_461_900_000,
    };
    snapshot.messages["msg-mcp-feedback-kimi"] = {
      id: "msg-mcp-feedback-kimi",
      conversationId: channelId,
      actorId: "session-kimi-channel",
      originNodeId: "node-1",
      class: "agent",
      body: "Kimi feedback",
      visibility: "workspace",
      policy: "durable",
      createdAt: 1_779_461_900_001,
    };
    brokerContextResult = brokerContext(snapshot);

    const channel = (await getScoutConversations({ conversationId: channelId }))[0];
    expect(channel?.participants).toHaveLength(3);
    for (const session of sessions) {
      const participant = channel?.participants.find((candidate) => candidate.actorId === session.id);
      expect(participant).toMatchObject({
        kind: "session",
        sessionId: session.id,
        harness: session.harness,
        transport: session.transport,
        workspaceRoot: "/Users/arach/dev/openscout",
      });
      expect(participant?.label).toContain(participant?.scopedAlias ?? "");
    }
  });

  test("caps huge channel rosters, keeps the operator, and truncates previews", async () => {
    const snapshot = baseSnapshot();
    const channelId = stableChannelId(namedChannelNaturalKey("shared"));
    // First 10 members have live endpoints; the rest are historic roster
    // entries — the only kind the rich-participant cap may drop.
    const memberIds = Array.from({ length: 60 }, (_, index) => {
      const id = `session-member-${String(index).padStart(3, "0")}`;
      snapshot.actors[id] = {
        id,
        kind: "session",
        displayName: `member-${index}`,
        metadata: { sessionId: id },
      };
      if (index < 10) {
        snapshot.endpoints[`ep-${id}`] = {
          id: `ep-${id}`,
          agentId: id,
          nodeId: "node-1",
          harness: "claude",
          transport: "claude_stream_json",
          state: "active",
          sessionId: id,
        };
      }
      return id;
    });
    snapshot.conversations[channelId] = {
      id: channelId,
      kind: "channel",
      title: "shared",
      visibility: "workspace",
      shareMode: "local",
      authorityNodeId: "node-1",
      // Sorted roster puts "operator" past the cap boundary on its own.
      participantIds: [...memberIds, "operator"],
      metadata: {
        naturalKey: namedChannelNaturalKey("shared"),
        channel: "shared",
      },
    };
    snapshot.messages["msg-shared-long"] = {
      id: "msg-shared-long",
      conversationId: channelId,
      actorId: memberIds[0]!,
      originNodeId: "node-1",
      class: "agent",
      body: "x".repeat(1_000),
      visibility: "workspace",
      policy: "durable",
      createdAt: 1_779_461_900_000,
    };
    brokerContextResult = brokerContext(snapshot);

    const conversations = await getScoutConversations();
    const channel = conversations.find((entry) => entry.id === channelId);
    expect(channel?.participantCount).toBe(61);
    // Bare ids always ship complete — membership checks (machine scoping,
    // deep links) must see every member, dormant or not.
    expect(channel?.participantIds).toHaveLength(61);
    expect(channel?.participantIds).toContain("operator");
    expect(channel?.participantIds).toContain("session-member-059");
    // Only the rich array is capped, and it never drops the operator or a
    // member with a live endpoint.
    expect(channel?.participants).toHaveLength(32);
    expect(channel?.participants.some((participant) => participant.actorId === "operator")).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      const liveId = `session-member-${String(index).padStart(3, "0")}`;
      expect(channel?.participants.some((participant) => participant.actorId === liveId)).toBe(true);
    }
    // Kept ids lead the id list so participants[i] pairs with
    // participantIds[i] for consumers that zip the two arrays by index.
    expect(
      channel?.participants.map((participant) => participant.actorId),
    ).toEqual(channel?.participantIds.slice(0, channel.participants.length));
    expect(channel?.preview).toBe("x".repeat(240));

    const direct = conversations.find((entry) => entry.id === "chat_hudson-main");
    expect(direct?.participantCount).toBe(2);
    expect(direct?.participantIds).toEqual(["hudson.main.mini", "operator"]);
  });

  test("omits legacy structural conversation ids from the live list", async () => {
    const snapshot = baseSnapshot();
    snapshot.conversations["dm.operator.hudson.main.mini"] = {
      id: "dm.operator.hudson.main.mini",
      kind: "direct",
      title: "Hudson Legacy",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", "hudson.main.mini"],
    };
    snapshot.messages["legacy-msg"] = {
      id: "legacy-msg",
      conversationId: "dm.operator.hudson.main.mini",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "legacy",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_800_000,
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations.map((entry) => entry.id)).toEqual(["chat_hudson-main"]);
  });

  test("keeps stale on-demand direct chats in the conversation list", async () => {
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: baseSnapshot(),
    };

    const conversations = await getScoutConversations();

    expect(conversations).toContainEqual(
      expect.objectContaining({
        id: "chat_hudson-main",
        chatId: "chat_hudson-main",
        agentId: "hudson.main.mini",
        agentName: "Hudson",
        currentBranch: "main",
        messageCount: 1,
      }),
    );
  });

  test("reads conversation messages from the broker snapshot used by the list", async () => {
    const snapshot = baseSnapshot();
    snapshot.messages["msg-2"] = {
      id: "msg-2",
      conversationId: "chat_hudson-main",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "hello from the broker",
      replyToMessageId: "msg-1",
      attachments: [{
        id: "att-1",
        mediaType: "image/png",
        url: "http://127.0.0.1:43120/api/image-blobs/att-1",
      }],
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_800_000,
      metadata: { flightId: "flt-1" },
    };
    snapshot.conversations["c.thread-1"] = {
      id: "c.thread-1",
      kind: "thread",
      title: "Thread",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", "hudson.main.mini"],
      parentConversationId: "chat_hudson-main",
      messageId: "msg-2",
    };
    snapshot.messages["msg-thread-1"] = {
      id: "msg-thread-1",
      conversationId: "c.thread-1",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "thread reply",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_900_000,
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const messages = await getScoutConversationMessages("chat_hudson-main", 260);

    expect(messages).toEqual([
      expect.objectContaining({
        id: "msg-1",
        conversationId: "chat_hudson-main",
        actorId: "operator",
        actorName: "Operator",
        body: "hello",
      }),
      expect.objectContaining({
        id: "msg-2",
        conversationId: "chat_hudson-main",
        actorId: "hudson.main.mini",
        actorName: "Hudson",
        body: "hello from the broker",
        replyToMessageId: "msg-1",
        metadata: { flightId: "flt-1" },
        attachments: [expect.objectContaining({ id: "att-1", mediaType: "image/png" })],
        threadSummary: {
          count: 1,
          participants: ["Operator", "Hudson"],
          lastActiveAt: 1_779_461_900_000,
        },
      }),
    ]);
  });

  test("pages to messages before a stable message id", async () => {
    const snapshot = baseSnapshot();
    for (const index of [2, 3, 4]) {
      snapshot.messages[`msg-${index}`] = {
        id: `msg-${index}`,
        conversationId: "chat_hudson-main",
        actorId: "hudson.main.mini",
        originNodeId: "node-1",
        class: "agent",
        body: `message ${index}`,
        visibility: "private",
        policy: "durable",
        createdAt: 1_779_461_700_000 + index,
      };
    }
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const messages = await getScoutConversationMessages(
      "chat_hudson-main",
      2,
      "msg-4",
    );

    expect(messages?.map((message) => message.id)).toEqual(["msg-2", "msg-3"]);
  });

  test("keeps paging when the cursor message is gone from the snapshot", async () => {
    const snapshot = baseSnapshot();
    seedBrokerMessages(snapshot, [2, 3, 4, 5]);
    brokerContextResult = brokerContext(snapshot);

    const cursor = encodeMessageHistoryCursor({
      createdAt: 1_779_461_700_000 + 4,
      id: "msg-4",
    });
    delete snapshot.messages["msg-4"];

    // Position, not identity: the deleted anchor used to make this read as
    // end-of-history and strand msg-1..msg-3 behind it.
    const messages = await getScoutConversationMessages("chat_hudson-main", 3, cursor);

    expect(messages?.map((message) => message.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  test("reports an unresolvable legacy cursor instead of an empty page", async () => {
    const snapshot = baseSnapshot();
    seedBrokerMessages(snapshot, [2, 3]);
    brokerContextResult = brokerContext(snapshot);

    await expect(
      getScoutConversationMessages("chat_hudson-main", 3, "msg-deleted"),
    ).rejects.toBeInstanceOf(MessageCursorError);
    await expect(
      getScoutConversationMessages("chat_hudson-main", 3, "not-a-cursor|"),
    ).rejects.toBeInstanceOf(MessageCursorError);
  });

  test("breaks tied timestamps by binary id so a broker page never repeats itself", async () => {
    const snapshot = baseSnapshot({ messages: {} });
    for (const suffix of ["!000", "0000", "_000"]) {
      snapshot.messages[`msg-${suffix}`] = {
        id: `msg-${suffix}`,
        conversationId: "chat_hudson-main",
        actorId: "operator",
        originNodeId: "node-1",
        class: "operator",
        body: suffix,
        visibility: "private",
        policy: "durable",
        createdAt: 1_779_461_700_000,
      };
    }
    brokerContextResult = brokerContext(snapshot);

    const firstPage = await getScoutConversationMessages("chat_hudson-main", 2);
    expect(firstPage?.map((message) => message.id)).toEqual(["msg-0000", "msg-_000"]);

    // Locale order nominates "msg-_000" as the oldest row on screen; read in the
    // shared order that cursor answers with "msg-0000", already on screen.
    const localeOldest = [...firstPage!].sort((left, right) =>
      left.id.localeCompare(right.id)
    )[0]!;
    const duplicatePage = await getScoutConversationMessages(
      "chat_hudson-main",
      1,
      encodeMessageHistoryCursor(localeOldest),
    );
    expect(duplicatePage?.map((message) => message.id)).toEqual(["msg-0000"]);

    const sharedOldest = [...firstPage!].sort(compareMessagesAsc)[0]!;
    expect(sharedOldest.id).toBe("msg-0000");
    const earlier = await getScoutConversationMessages(
      "chat_hudson-main",
      1,
      encodeMessageHistoryCursor(sharedOldest),
    );
    expect(earlier?.map((message) => message.id)).toEqual(["msg-!000"]);
  });

  test("defers to the durable projection when the snapshot window holds nothing", async () => {
    // The snapshot only carries a trailing window, so a conversation older than
    // it reads as an empty page here. Answering `[]` published that silence as
    // a verdict and opened every such conversation blank; `null` sends the read
    // to SQLite, which still has the transcript.
    brokerContextResult = brokerContext(baseSnapshot({ messages: {} }));

    await expect(getScoutConversationMessages("chat_hudson-main", 80)).resolves.toBeNull();
  });

  test("defers to the durable projection for a page below the snapshot window", async () => {
    const snapshot = baseSnapshot({ messages: {} });
    seedBrokerMessages(snapshot, [2, 3]);
    brokerContextResult = brokerContext(snapshot);

    const oldest = (await getScoutConversationMessages("chat_hudson-main", 80))![0]!;
    const beyond = await getScoutConversationMessages(
      "chat_hudson-main",
      80,
      encodeMessageHistoryCursor(oldest),
    );

    // Start of the window is not start of history: scrollback continues in the
    // durable projection instead of stopping at the window's edge.
    expect(beyond).toBeNull();
  });

  test("clamps an oversized broker page to the shared maximum", async () => {
    const snapshot = baseSnapshot({ messages: {} });
    seedBrokerMessages(
      snapshot,
      Array.from({ length: MAX_MESSAGE_PAGE_LIMIT + 100 }, (_, index) => index + 1),
    );
    brokerContextResult = brokerContext(snapshot);

    const messages = await getScoutConversationMessages("chat_hudson-main", 1_000);

    expect(messages).toHaveLength(MAX_MESSAGE_PAGE_LIMIT);
  });

  test("adds scoped labels for same-project agent-agent participants", async () => {
    const snapshot = baseSnapshot();
    snapshot.actors["openscout-a.main.mini"] = {
      id: "openscout-a.main.mini",
      displayName: "OpenScout",
      handle: "openscout-a",
    };
    snapshot.actors["openscout-b.main.mini"] = {
      id: "openscout-b.main.mini",
      displayName: "OpenScout",
      handle: "openscout-b",
    };
    snapshot.agents["openscout-a.main.mini"] = {
      id: "openscout-a.main.mini",
      kind: "agent",
      definitionId: "openscout",
      displayName: "OpenScout",
      handle: "openscout-a",
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {},
    };
    snapshot.agents["openscout-b.main.mini"] = {
      id: "openscout-b.main.mini",
      kind: "agent",
      definitionId: "openscout",
      displayName: "OpenScout",
      handle: "openscout-b",
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {},
    };
    snapshot.endpoints["ep-openscout-a"] = {
      id: "ep-openscout-a",
      agentId: "openscout-a.main.mini",
      nodeId: "node-1",
      harness: "claude",
      transport: "tmux",
      state: "idle",
      projectRoot: "/Users/arach/dev/openscout",
      sessionId: "relay-openscout-a",
    };
    snapshot.endpoints["ep-openscout-b"] = {
      id: "ep-openscout-b",
      agentId: "openscout-b.main.mini",
      nodeId: "node-1",
      harness: "claude",
      transport: "claude_stream_json",
      state: "idle",
      projectRoot: "/Users/arach/dev/openscout",
      sessionId: "relay-openscout-b",
    };
    snapshot.conversations["chat_openscout_pair"] = {
      id: "chat_openscout_pair",
      kind: "direct",
      title: "OpenScout <> OpenScout",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["openscout-a.main.mini", "openscout-b.main.mini"],
    };
    snapshot.messages["msg-openscout-pair"] = {
      id: "msg-openscout-pair",
      conversationId: "chat_openscout_pair",
      actorId: "openscout-a.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "handoff",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_900_000,
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();
    const pair = conversations.find((entry) => entry.id === "chat_openscout_pair");

    expect(pair?.participants).toHaveLength(2);
    expect(pair?.participants.map((participant) => participant.displayName)).toEqual([
      "Openscout",
      "Openscout",
    ]);
    expect(pair?.participants.every((participant) => participant.label.startsWith("Openscout · "))).toBe(true);
    expect(new Set(pair?.participants.map((participant) => participant.scopedAlias)).size).toBe(2);
    expect(pair?.participants.map((participant) => participant.sessionId)).toEqual([
      "relay-openscout-a",
      "relay-openscout-b",
    ]);
  });

  test("normalizes legacy second timestamps before returning summaries", async () => {
    const snapshot = baseSnapshot();
    snapshot.messages["msg-1"]!.createdAt = 1_779_461_700;
    snapshot.messages["msg-2"] = {
      id: "msg-2",
      conversationId: "chat_hudson-main",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "done",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_710,
    };
    snapshot.readCursors = {
      "read-1": {
        conversationId: "chat_hudson-main",
        actorId: "operator",
        lastReadAt: 1_779_461_705,
      },
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations.find((entry) => entry.id === "chat_hudson-main")).toEqual(
      expect.objectContaining({
        lastMessageAt: 1_779_461_710_000,
        unreadCount: 1,
      }),
    );
  });

  test("uses the most recent endpoint when a direct agent has multiple stale endpoints", async () => {
    const snapshot = baseSnapshot();
    snapshot.endpoints["ep-hudson-main-old"] = {
      id: "ep-hudson-main-old",
      agentId: "hudson.main.mini",
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "offline",
      projectRoot: "/Users/arach/dev/hudson",
      metadata: {
        startedAt: "1778552408",
        lastFailedAt: "1779461710087",
        staleAt: "1779461710087",
        branch: "main",
      },
    };
    snapshot.endpoints["ep-hudson-main"]!.metadata = {
      startedAt: "1779336966",
      lastFailedAt: "1779461710087",
      staleAt: "1779461710087",
      branch: "main",
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations.find((entry) => entry.id === "chat_hudson-main")).toEqual(
      expect.objectContaining({
        harness: "claude",
      }),
    );
  });

  test("surfaces the per-conversation session id from message routing metadata", async () => {
    const snapshot = baseSnapshot();
    snapshot.endpoints["ep-hudson-main"]!.sessionId = "endpoint-active-session";
    snapshot.messages["msg-2"] = {
      id: "msg-2",
      conversationId: "chat_hudson-main",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "done",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_800_000,
      metadata: {
        returnAddress: {
          sessionId: "relay-hudson-claude",
        },
      },
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations.find((entry) => entry.id === "chat_hudson-main")).toEqual(
      expect.objectContaining({
        sessionId: "relay-hudson-claude",
      }),
    );
  });

  test("does not invent a conversation session id from the active endpoint alone", async () => {
    const snapshot = baseSnapshot();
    snapshot.endpoints["ep-hudson-main"]!.sessionId = "endpoint-active-session";
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations.find((entry) => entry.id === "chat_hudson-main")?.sessionId).toBeNull();
  });

  test("keeps direct chats with message history when the endpoint is absent", async () => {
    const snapshot = baseSnapshot({
      endpoints: {},
    });
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations).toContainEqual(
      expect.objectContaining({
        id: "chat_hudson-main",
        agentId: "hudson.main.mini",
        harness: null,
        workspaceRoot: null,
      }),
    );
  });

  test("keeps completed session-backed direct chats without an agent record", async () => {
    const snapshot = baseSnapshot();
    const sessionActorId = "session-mr8idz7a-gn5ntd";
    const chatId = "chn-96b2fea9b3904b3ca6f88490f6d2c5f9";
    snapshot.actors[sessionActorId] = {
      id: sessionActorId,
      kind: "session",
      displayName: "openscout-haydn",
      handle: "project-haydn",
      labels: ["cardless-session", "session"],
      metadata: {
        source: "scout-cardless-session",
        sessionBacked: true,
        cardless: true,
        projectRoot: "/Users/arach/dev/openscout",
      },
    };
    snapshot.endpoints["endpoint-session"] = {
      id: "endpoint-session",
      agentId: sessionActorId,
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "idle",
      cwd: "/Users/arach/dev/openscout",
      projectRoot: "/Users/arach/dev/openscout",
      sessionId: sessionActorId,
      metadata: {
        source: "scout-cardless-session",
        sessionBacked: true,
        cardless: true,
        pendingExternalSession: false,
        externalSessionId: "019f34ec-a5d0-7dd2-9398-aae6c0c0336b",
      },
    };
    snapshot.conversations[chatId] = {
      id: chatId,
      kind: "direct",
      title: "Operator <> openscout-haydn",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", sessionActorId],
    };
    snapshot.messages["msg-session-seed"] = {
      id: "msg-session-seed",
      conversationId: chatId,
      actorId: "operator",
      originNodeId: "node-1",
      class: "operator",
      body: "Reply with exactly: ok",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_800_000,
    };
    snapshot.messages["msg-session-reply"] = {
      id: "msg-session-reply",
      conversationId: chatId,
      actorId: sessionActorId,
      originNodeId: "node-1",
      class: "agent",
      body: "ok",
      replyToMessageId: "msg-session-seed",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_900_000,
      metadata: {
        flightId: "flt-session",
        responderSessionId: sessionActorId,
      },
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations).toContainEqual(
      expect.objectContaining({
        id: chatId,
        chatId,
        agentId: sessionActorId,
        agentName: "Openscout",
        harness: "codex",
        sessionId: sessionActorId,
        workspaceRoot: "/Users/arach/dev/openscout",
        preview: "ok",
        messageCount: 2,
      }),
    );
  });

  test("omits failed cardless launch stubs without an external session", async () => {
    const snapshot = baseSnapshot();
    const sessionActorId = "session-mqmzik4c-zb8ocf";
    const chatId = "chat_ff3a45d076de4614995c530d455ffc48";
    snapshot.actors[sessionActorId] = {
      id: sessionActorId,
      displayName: "Openscout",
      metadata: {
        cardless: true,
      },
    };
    snapshot.agents[sessionActorId] = {
      id: sessionActorId,
      kind: "agent",
      definitionId: "openscout",
      displayName: "Openscout",
      handle: "openscout",
      agentClass: "general",
      capabilities: ["chat", "invoke", "deliver"],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
      metadata: {
        cardless: true,
      },
    };
    snapshot.endpoints["endpoint-failed-cardless"] = {
      id: "endpoint-failed-cardless",
      agentId: sessionActorId,
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "offline",
      projectRoot: "/Users/arach/dev/openscout",
      metadata: {
        cardless: true,
        pendingExternalSession: true,
        lastError: "Codex app-server cwd does not exist: /Users/arach/dev/openscout/packages/runtime/~/dev/openscout",
        lastFailedAt: "1779461800000",
      },
    };
    snapshot.conversations[chatId] = {
      id: chatId,
      kind: "direct",
      title: "Openscout",
      visibility: "private",
      shareMode: "local",
      authorityNodeId: "node-1",
      participantIds: ["operator", sessionActorId],
    };
    snapshot.messages["failed-cardless-msg"] = {
      id: "failed-cardless-msg",
      conversationId: chatId,
      actorId: sessionActorId,
      originNodeId: "node-1",
      class: "agent",
      body: "failed to respond",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_850_000,
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations.find((entry) => entry.id === chatId)).toBeUndefined();
    expect(conversations.find((entry) => entry.id === "chat_hudson-main")).toBeDefined();
  });

  test("omits explicitly retired direct chats", async () => {
    const snapshot = baseSnapshot();
    snapshot.agents["hudson.main.mini"]!.metadata = {
      retiredFromFleet: true,
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();

    expect(conversations.find((entry) => entry.id === "chat_hudson-main")).toBeUndefined();
  });

  test("reports unreadCount: 0 when the operator has no read cursor", async () => {
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot: baseSnapshot(),
    };

    const conversations = await getScoutConversations();
    const dm = conversations.find((entry) => entry.id === "chat_hudson-main");

    expect(dm?.unreadCount).toBe(0);
    expect(dm?.ask).toBeUndefined();
  });

  test("derives the latest reply-required operator turn from canonical records", async () => {
    const snapshot = baseSnapshot();
    snapshot.invocations = {
      "inv-1": {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "hudson.main.mini",
        action: "consult",
        task: "hello",
        conversationId: "chat_hudson-main",
        messageId: "msg-1",
        ensureAwake: true,
        stream: false,
        createdAt: 1_779_461_700_100,
      },
    };
    snapshot.flights = {
      "flt-1": {
        id: "flt-1",
        invocationId: "inv-1",
        requesterId: "operator",
        targetAgentId: "hudson.main.mini",
        state: "running",
        startedAt: 1_779_461_700_200,
      },
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    let dm = (await getScoutConversations()).find((entry) => entry.id === "chat_hudson-main");
    expect(dm?.turn).toEqual(expect.objectContaining({
      messageId: "msg-1",
      invocationId: "inv-1",
      flightId: "flt-1",
      state: "working",
      nextMoveOwner: "agent",
    }));

    snapshot.messages["msg-reply"] = {
      id: "msg-reply",
      conversationId: "chat_hudson-main",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "Hi back",
      replyToMessageId: "msg-1",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_700_300,
    };
    snapshot.flights["flt-1"].state = "completed";
    snapshot.flights["flt-1"].completedAt = 1_779_461_700_300;

    dm = (await getScoutConversations()).find((entry) => entry.id === "chat_hudson-main");
    expect(dm?.turn).toEqual(expect.objectContaining({
      state: "replied",
      nextMoveOwner: "none",
      updatedAt: 1_779_461_700_300,
    }));
  });

  test("projects an origin-correlated delivery issue as a failed turn", async () => {
    const snapshot = baseSnapshot();
    snapshot.messages["msg-1"].metadata = {
      replyExpectation: "required",
      routingState: "failed",
    };
    snapshot.messages["msg-failed"] = {
      id: "msg-failed",
      conversationId: "chat_hudson-main",
      actorId: "scout.system",
      originNodeId: "node-1",
      class: "status",
      body: "No operator session accepted it.",
      replyToMessageId: "msg-1",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_700_100,
      metadata: {
        source: "broker",
        routingState: "failed",
        deliveryIssueKind: "unassigned_scout",
      },
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const dm = (await getScoutConversations()).find((entry) => entry.id === "chat_hudson-main");
    expect(dm?.turn).toEqual(expect.objectContaining({
      messageId: "msg-1",
      invocationId: null,
      flightId: null,
      state: "failed",
      nextMoveOwner: "none",
    }));
  });

  test("clears a failed turn after the operator dismisses its attention", async () => {
    const snapshot = baseSnapshot();
    snapshot.messages["msg-1"].metadata = { replyExpectation: "required" };
    snapshot.messages["msg-failed"] = {
      id: "msg-failed",
      conversationId: "chat_hudson-main",
      actorId: "system",
      originNodeId: "node-1",
      class: "status",
      body: "Hudson failed to respond.",
      replyToMessageId: "msg-1",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_700_300,
      metadata: { source: "broker", routingState: "failed" },
    };
    snapshot.invocations = {
      "inv-failed": {
        id: "inv-failed",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "hudson.main.mini",
        action: "consult",
        task: "hello",
        conversationId: "chat_hudson-main",
        messageId: "msg-1",
        ensureAwake: true,
        stream: false,
        createdAt: 1_779_461_700_100,
      },
    };
    snapshot.flights = {
      "flt-failed": {
        id: "flt-failed",
        invocationId: "inv-failed",
        requesterId: "operator",
        targetAgentId: "hudson.main.mini",
        state: "failed",
        startedAt: 1_779_461_700_200,
        completedAt: 1_779_461_700_300,
        metadata: { operatorAttentionDismissedAt: 1_779_461_700_400 },
      },
    };
    brokerContextResult = brokerContext(snapshot);

    const dm = (await getScoutConversations()).find((entry) => entry.id === "chat_hudson-main");
    expect(dm?.turn).toBeUndefined();
  });

  test("clears a failed turn acknowledged on a broker conversation without a projected flight", async () => {
    const snapshot = baseSnapshot();
    snapshot.conversations["chat_hudson-main"].metadata = {
      operatorAttentionDismissedMessageId: "msg-1",
      operatorAttentionDismissedAt: 1_779_461_700_400,
    };
    snapshot.messages["msg-1"].metadata = {
      replyExpectation: "required",
      routingState: "failed",
    };
    brokerContextResult = brokerContext(snapshot);

    const dm = (await getScoutConversations()).find((entry) => entry.id === "chat_hudson-main");
    expect(dm?.turn).toBeUndefined();
  });

  test("counts agent messages after the operator read cursor as unread", async () => {
    const snapshot = baseSnapshot();
    // One operator message already at createdAt 1_779_461_700_000; add two later
    // agent messages and an operator read cursor between them.
    snapshot.messages["msg-2"] = {
      id: "msg-2",
      conversationId: "chat_hudson-main",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "still working",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_800_000,
    };
    snapshot.messages["msg-3"] = {
      id: "msg-3",
      conversationId: "chat_hudson-main",
      actorId: "hudson.main.mini",
      originNodeId: "node-1",
      class: "agent",
      body: "done",
      visibility: "private",
      policy: "durable",
      createdAt: 1_779_461_900_000,
    };
    snapshot.readCursors = {
      "cursor-op": {
        conversationId: "chat_hudson-main",
        actorId: "operator",
        lastReadMessageId: "msg-1",
        lastReadAt: 1_779_461_750_000,
        updatedAt: 1_779_461_750_000,
      },
    };
    brokerContextResult = {
      baseUrl: "http://broker.test",
      node: { id: "node-1" },
      snapshot,
    };

    const conversations = await getScoutConversations();
    const dm = conversations.find((entry) => entry.id === "chat_hudson-main");

    // msg-2 and msg-3 are after the cursor and authored by the agent → 2 unread.
    expect(dm?.unreadCount).toBe(2);
  });

});
