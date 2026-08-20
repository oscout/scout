import {
  SCOUT_SURFACE_PROTOCOL_VERSION,
  type FleetAgentSnapshot,
  type CodexDeckThreadSnapshot,
  type FleetDispatchSnapshot,
  type FleetObserveSnapshot,
  type FleetTailSnapshot,
  type NativeVoiceSnapshot,
  type ScoutSurfaceErrorReply,
  type ScoutSurfacePush,
  type ScoutSurfaceRequest,
  type ScoutSurfaceSuccessReply,
  type SurfaceBootstrap,
  type SurfacePreferences,
  type SurfaceSubscriptionReceipt,
} from "./scout-surface-contract.ts";

const cursor = {
  epoch: "epoch-studio-7",
  sequence: 42,
  connectionRevision: 7,
} as const;

const hosts = [
  { id: "host_7d3a91", name: "Studio", state: "connected" },
  { id: "host_c049e2", name: "Build Mac", state: "disconnected" },
] as const;

const bootstrap = {
  surface: "lanes",
  assetRevision: "web-surfaces-2026-07-21.1",
  protocolVersion: SCOUT_SURFACE_PROTOCOL_VERSION,
  minimumSurfaceProtocolVersion: SCOUT_SURFACE_PROTOCOL_VERSION,
  minimumNativeProtocolVersion: SCOUT_SURFACE_PROTOCOL_VERSION,
  capabilities: [
    "bootstrap",
    "native.getPreferences",
    "native.setPreferences",
    "agents.list",
    "agents.observe",
    "tail.recent",
    "tail.subscribe",
    "native.setLaneSelection",
  ],
  device: { platform: "ios", formFactor: "ipad" },
  hosts,
  selectedHostIds: ["host_7d3a91"],
  connectionRevision: 7,
  activity: "visible",
} as const satisfies SurfaceBootstrap;

const preferences = {
  entries: [
    { key: "lanes.layout", value: "grid" },
    { key: "lanes.horizon", value: "30m" },
    { key: "lanes.gridColumns", value: "4" },
    { key: "lanes.collapseTechnicalEvents", value: true },
  ],
} as const satisfies SurfacePreferences;

const agentSnapshot = {
  hosts: [{
    hostId: "host_7d3a91",
    ready: true,
    value: {
      cursor,
      agents: [{
        id: "agent-codex",
        name: "Codex",
        handle: "codex",
        harness: "codex",
        transport: "codex_app_server",
        model: "gpt-5",
        state: "working",
        projectRoot: "/project",
        conversationId: "conversation-1",
        sessionId: "session-1",
        updatedAt: 1_784_665_200_000,
      }],
    },
  }, {
    hostId: "host_c049e2",
    ready: false,
    error: { code: "not_connected", message: "Build Mac is disconnected.", retryable: true },
  }],
} as const satisfies FleetAgentSnapshot;

const observeSnapshot = {
  hosts: [{
    hostId: "host_7d3a91",
    ready: true,
    value: {
      cursor,
      agents: [{
        agentId: "agent-codex",
        source: "live",
        fidelity: "timestamped",
        sessionId: "session-1",
        updatedAt: 1_784_665_200_000,
        events: [{
          id: "observe-1",
          at: 1_784_665_199_000,
          kind: "tool",
          text: "Read the surface proposal",
          tool: "read",
        }],
      }],
    },
  }],
} as const satisfies FleetObserveSnapshot;

const tailSnapshot = {
  hosts: [{
    hostId: "host_7d3a91",
    ready: true,
    value: {
      cursor,
      nextCursor: "tail:43",
      events: [{
        id: "tail-1",
        at: 1_784_665_199_500,
        agentId: "agent-codex",
        sessionId: "session-1",
        kind: "assistant",
        text: "Implementing the shared contract.",
      }],
    },
  }],
} as const satisfies FleetTailSnapshot;

const dispatchSnapshot = {
  hosts: [{
    hostId: "host_7d3a91",
    ready: true,
    value: {
      cursor,
      nextCursor: "dispatch:43",
      records: [{
        id: "dispatch-1",
        state: "in_flight",
        actorId: "operator",
        targetId: "agent-codex",
        summary: "Review the iOS surface contract",
        createdAt: 1_784_665_100_000,
        updatedAt: 1_784_665_200_000,
        messageId: "message-1",
        conversationId: "conversation-1",
        flightId: "flight-1",
        workId: "work-1",
        ref: "ref:t-flight-1",
      }],
    },
  }],
} as const satisfies FleetDispatchSnapshot;

const subscription = {
  subscriptionId: "subscription-1",
  hosts: [{ hostId: "host_7d3a91", ready: true, value: { cursor } }],
} as const satisfies SurfaceSubscriptionReceipt;

const routedReceipt = {
  hostId: "host_7d3a91",
  messageId: "message-1",
  conversationId: "conversation-1",
  flightId: "flight-1",
  workId: "work-1",
  ref: "ref:t-flight-1",
} as const;

const codexThread = {
  adapter: "codex_app_server",
  agentId: "agent-codex",
  threadId: "thread-codex",
  turnId: null,
  state: "idle",
  capabilities: {
    connect: true,
    start: true,
    steer: true,
    interrupt: true,
    queue: false,
    approvals: false,
  },
  capabilityNotes: {
    queue: "Codex app-server exposes one active turn per thread; the Deck does not invent a client-side queue.",
    approvals: "This managed Codex adapter currently runs with host-side approvalPolicy=never.",
  },
  snapshot: {
    session: {
      id: "thread-codex",
      name: "Codex",
      adapterType: "codex",
      status: "idle",
      cwd: "/project",
      model: "gpt-5",
      providerMeta: { threadId: "thread-codex" },
    },
    turns: [],
    currentTurnId: null,
  },
} as const satisfies CodexDeckThreadSnapshot;

const codexRoute = { hostId: "host_7d3a91", agentId: "agent-codex" } as const;

const codexSessionReceipt = {
  accepted: true,
  hostId: "host_7d3a91",
  sourceAgentId: "agent-claude",
  agentId: "agent-codex",
  conversationId: "conversation-1",
  sessionId: "session-1",
} as const;

const nativeVoice = {
  input: {
    state: "idle",
    partialText: "",
    finalText: "Inspect the bridge and run the focused tests.",
    finalCount: 3,
    engine: "parakeet",
    modelReady: true,
    unavailableReason: null,
  },
  output: { speaking: false },
} as const satisfies NativeVoiceSnapshot;

export const SCOUT_SURFACE_V1_GOLDEN_FIXTURES = {
  bootstrap,
  preferences,
  requests: [
    { v: 1, id: "request-bootstrap", surface: "lanes", method: "bootstrap", params: {} },
    {
      v: 1,
      id: "request-open-url",
      surface: "lanes",
      method: "native.openExternalURL",
      params: { url: "https://openscout.app/docs" },
    },
    {
      v: 1,
      id: "request-get-preferences",
      surface: "lanes",
      method: "native.getPreferences",
      params: { keys: ["lanes.layout", "lanes.horizon"] },
    },
    {
      v: 1,
      id: "request-set-preferences",
      surface: "lanes",
      method: "native.setPreferences",
      params: preferences,
    },
    {
      v: 1,
      id: "request-cancel",
      surface: "lanes",
      method: "native.cancel",
      params: { requestId: "request-observe" },
    },
    { v: 1, id: "request-voice-snapshot", surface: "deck", method: "native.voice.snapshot", params: {} },
    { v: 1, id: "request-voice-toggle", surface: "deck", method: "native.voice.toggleInput", params: {} },
    { v: 1, id: "request-voice-speak", surface: "deck", method: "native.voice.speak", params: { text: "The controller is ready." } },
    { v: 1, id: "request-voice-stop", surface: "deck", method: "native.voice.stopOutput", params: {} },
    {
      v: 1,
      id: "request-agents",
      surface: "lanes",
      method: "agents.list",
      hostIds: ["host_7d3a91", "host_c049e2"],
      params: {},
      deadlineMs: 10_000,
    },
    {
      v: 1,
      id: "request-observe",
      surface: "lanes",
      method: "agents.observe",
      hostIds: ["host_7d3a91"],
      params: { agentIds: ["agent-codex"] },
    },
    {
      v: 1,
      id: "request-tail-recent",
      surface: "lanes",
      method: "tail.recent",
      hostIds: ["host_7d3a91"],
      params: { cursor: "tail:40", limit: 200 },
    },
    {
      v: 1,
      id: "request-tail-subscribe",
      surface: "lanes",
      method: "tail.subscribe",
      hostIds: ["host_7d3a91"],
      params: { cursor: "tail:43" },
    },
    {
      v: 1,
      id: "request-lane-selection",
      surface: "lanes",
      method: "native.setLaneSelection",
      params: {
        selection: {
          hostId: "host_7d3a91",
          agentId: "agent-codex",
          conversationId: "conversation-1",
          sessionId: "session-1",
        },
      },
    },
    { v: 1, id: "request-codex-session-start", surface: "deck", method: "codex.session.start", params: { route: { hostId: "host_7d3a91", agentId: "agent-claude" } } },
    { v: 1, id: "request-codex-snapshot", surface: "deck", method: "codex.thread.snapshot", params: { route: codexRoute } },
    { v: 1, id: "request-codex-connect", surface: "deck", method: "codex.thread.connect", params: { route: codexRoute } },
    { v: 1, id: "request-codex-start", surface: "deck", method: "codex.turn.start", params: { route: codexRoute, text: "Inspect the failing test." } },
    { v: 1, id: "request-codex-steer", surface: "deck", method: "codex.turn.steer", params: { route: codexRoute, text: "Focus on the bridge contract." } },
    { v: 1, id: "request-codex-interrupt", surface: "deck", method: "codex.turn.interrupt", params: { route: codexRoute } },
    {
      v: 1,
      id: "request-dispatch-diagnostics",
      surface: "dispatch",
      method: "dispatch.diagnostics",
      hostIds: ["host_7d3a91"],
      params: { limit: 100 },
    },
    {
      v: 1,
      id: "request-dispatch-subscribe",
      surface: "dispatch",
      method: "dispatch.subscribe",
      hostIds: ["host_7d3a91"],
      params: { cursor: "dispatch:43" },
    },
    {
      v: 1,
      id: "request-dispatch-ask",
      surface: "dispatch",
      method: "dispatch.ask",
      params: {
        route: { kind: "agent", hostId: "host_7d3a91", agentId: "agent-codex" },
        body: "Please review the local iOS surface contract.",
        replyMode: "notify",
      },
    },
    {
      v: 1,
      id: "request-dispatch-review",
      surface: "dispatch",
      method: "dispatch.review",
      params: { hostId: "host_7d3a91", dispatchId: "dispatch-1", note: "Focus on routing." },
    },
  ] satisfies readonly ScoutSurfaceRequest[],
  successReplies: [
    { v: 1, id: "request-bootstrap", method: "bootstrap", metadata: { appliedDeadlineMs: 5_000 }, result: bootstrap },
    { v: 1, id: "request-open-url", method: "native.openExternalURL", metadata: { appliedDeadlineMs: 5_000 }, result: { accepted: true } },
    { v: 1, id: "request-get-preferences", method: "native.getPreferences", metadata: { appliedDeadlineMs: 2_000 }, result: preferences },
    { v: 1, id: "request-set-preferences", method: "native.setPreferences", metadata: { appliedDeadlineMs: 2_000 }, result: { accepted: true } },
    { v: 1, id: "request-cancel", method: "native.cancel", metadata: { appliedDeadlineMs: 1_000 }, result: { accepted: true } },
    { v: 1, id: "request-voice-snapshot", method: "native.voice.snapshot", metadata: { appliedDeadlineMs: 1_000 }, result: nativeVoice },
    { v: 1, id: "request-voice-toggle", method: "native.voice.toggleInput", metadata: { appliedDeadlineMs: 2_000 }, result: nativeVoice },
    { v: 1, id: "request-voice-speak", method: "native.voice.speak", metadata: { appliedDeadlineMs: 2_000 }, result: nativeVoice },
    { v: 1, id: "request-voice-stop", method: "native.voice.stopOutput", metadata: { appliedDeadlineMs: 1_000 }, result: nativeVoice },
    { v: 1, id: "request-agents", method: "agents.list", metadata: { appliedDeadlineMs: 10_000 }, result: agentSnapshot },
    { v: 1, id: "request-observe", method: "agents.observe", metadata: { appliedDeadlineMs: 15_000 }, result: observeSnapshot },
    { v: 1, id: "request-tail-recent", method: "tail.recent", metadata: { appliedDeadlineMs: 15_000 }, result: tailSnapshot },
    { v: 1, id: "request-tail-subscribe", method: "tail.subscribe", metadata: { appliedDeadlineMs: 5_000 }, result: subscription },
    { v: 1, id: "request-lane-selection", method: "native.setLaneSelection", metadata: { appliedDeadlineMs: 2_000 }, result: { accepted: true } },
    { v: 1, id: "request-codex-session-start", method: "codex.session.start", metadata: { appliedDeadlineMs: 30_000 }, result: codexSessionReceipt },
    { v: 1, id: "request-codex-snapshot", method: "codex.thread.snapshot", metadata: { appliedDeadlineMs: 15_000 }, result: codexThread },
    { v: 1, id: "request-codex-connect", method: "codex.thread.connect", metadata: { appliedDeadlineMs: 15_000 }, result: codexThread },
    { v: 1, id: "request-codex-start", method: "codex.turn.start", metadata: { appliedDeadlineMs: 5_000 }, result: { accepted: true, agentId: "agent-codex", threadId: "thread-codex", mode: "start" } },
    { v: 1, id: "request-codex-steer", method: "codex.turn.steer", metadata: { appliedDeadlineMs: 5_000 }, result: { accepted: true, agentId: "agent-codex", threadId: "thread-codex", mode: "steer" } },
    { v: 1, id: "request-codex-interrupt", method: "codex.turn.interrupt", metadata: { appliedDeadlineMs: 5_000 }, result: { accepted: true, agentId: "agent-codex", threadId: "thread-codex", mode: "interrupt" } },
    { v: 1, id: "request-dispatch-diagnostics", method: "dispatch.diagnostics", metadata: { appliedDeadlineMs: 15_000 }, result: dispatchSnapshot },
    { v: 1, id: "request-dispatch-subscribe", method: "dispatch.subscribe", metadata: { appliedDeadlineMs: 5_000 }, result: subscription },
    { v: 1, id: "request-dispatch-ask", method: "dispatch.ask", metadata: { appliedDeadlineMs: 30_000 }, result: routedReceipt },
    { v: 1, id: "request-dispatch-review", method: "dispatch.review", metadata: { appliedDeadlineMs: 30_000 }, result: routedReceipt },
  ] satisfies readonly ScoutSurfaceSuccessReply[],
  errorReplies: [{
    v: 1,
    id: "request-observe",
    method: "agents.observe",
    metadata: { appliedDeadlineMs: 15_000 },
    error: { code: "invalid_route", message: "The selected agent is no longer on this host.", retryable: false },
  }] satisfies readonly ScoutSurfaceErrorReply[],
  pushes: [
    {
      v: 1,
      stream: "session.update",
      hosts,
      selectedHostIds: ["host_7d3a91"],
      connectionRevision: 8,
      activity: "visible",
    },
    {
      v: 1,
      stream: "tail.delta",
      hostId: "host_7d3a91",
      epoch: "epoch-studio-7",
      sequence: 43,
      connectionRevision: 7,
      payload: { events: tailSnapshot.hosts[0].ready ? tailSnapshot.hosts[0].value.events : [] },
    },
    {
      v: 1,
      stream: "dispatch.delta",
      hostId: "host_7d3a91",
      epoch: "epoch-studio-7",
      sequence: 44,
      connectionRevision: 7,
      payload: { records: dispatchSnapshot.hosts[0].ready ? dispatchSnapshot.hosts[0].value.records : [] },
    },
    {
      v: 1,
      stream: "stream.reset",
      hostId: "host_7d3a91",
      epoch: "epoch-studio-8",
      sequence: 0,
      connectionRevision: 8,
      payload: { target: "tail", reason: "reconnect" },
    },
  ] satisfies readonly ScoutSurfacePush[],
} as const;

export type ScoutSurfaceV1GoldenFixtures = typeof SCOUT_SURFACE_V1_GOLDEN_FIXTURES;
