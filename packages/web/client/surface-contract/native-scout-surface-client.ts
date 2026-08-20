import {
  SCOUT_SURFACE_PROTOCOL_VERSION,
  type CodexDeckRoute,
  type FleetDispatchDelta,
  type FleetTailDelta,
  type HostScope,
  type LaneSelection,
  type RequestId,
  type RoutedAskRequest,
  type RoutedAskReceipt,
  type RoutedReviewRequest,
  type RoutedReviewReceipt,
  type ScoutSurfaceClient,
  type ScoutSurfaceMethod,
  type ScoutSurfaceMethodContract,
  type ScoutSurfacePush,
  type ScoutSurfaceReply,
  type ScoutSurfaceRequest,
  type ScoutSurfaceId,
  type SurfacePreferenceKey,
  type SurfacePreferences,
} from "./scout-surface-contract.ts";

type NativeMessageHandler = {
  postMessage(message: ScoutSurfaceRequest): Promise<ScoutSurfaceReply>;
};

declare global {
  interface Window {
    webkit?: { messageHandlers?: { scoutSurface?: NativeMessageHandler } };
    __scoutSurface?: { onPush(payload: ScoutSurfacePush): void };
  }
}

const PUSH_EVENT = "scout:surface-push";

export class NativeScoutSurfaceClient implements ScoutSurfaceClient {
  constructor(
    private readonly surface: ScoutSurfaceId,
    private readonly currentScope: () => HostScope,
    private readonly handler: NativeMessageHandler = requireNativeHandler(),
  ) {}

  bootstrap() {
    return this.request("bootstrap", {});
  }

  agents = {
    list: (scope: HostScope) => this.request("agents.list", {}, scope),
    observe: (scope: HostScope, agentIds: readonly string[]) =>
      this.request("agents.observe", { agentIds }, scope),
  };

  tail = {
    recent: (scope: HostScope, cursor?: string) =>
      this.request("tail.recent", { ...(cursor ? { cursor } : {}) }, scope),
    subscribe: (scope: HostScope, listener: (delta: FleetTailDelta) => void) => {
      const stop = subscribeToPush("tail.delta", listener);
      void this.request("tail.subscribe", {}, scope).catch(() => stop());
      return stop;
    },
  };

  codex = {
    startSession: (route: CodexDeckRoute) => this.request("codex.session.start", { route }),
    snapshot: (route: CodexDeckRoute) => this.request("codex.thread.snapshot", { route }),
    connect: (route: CodexDeckRoute) => this.request("codex.thread.connect", { route }),
    start: (route: CodexDeckRoute, text: string) => this.request("codex.turn.start", { route, text }),
    steer: (route: CodexDeckRoute, text: string) => this.request("codex.turn.steer", { route, text }),
    interrupt: (route: CodexDeckRoute) => this.request("codex.turn.interrupt", { route }),
  };

  dispatch = {
    diagnostics: (scope: HostScope, cursor?: string) =>
      this.request("dispatch.diagnostics", { ...(cursor ? { cursor } : {}) }, scope),
    ask: (request: RoutedAskRequest): Promise<RoutedAskReceipt> =>
      this.request("dispatch.ask", request),
    review: (request: RoutedReviewRequest): Promise<RoutedReviewReceipt> =>
      this.request("dispatch.review", request),
    subscribe: (scope: HostScope, listener: (delta: FleetDispatchDelta) => void) => {
      const stop = subscribeToPush("dispatch.delta", listener);
      void this.request("dispatch.subscribe", {}, scope).catch(() => stop());
      return stop;
    },
  };

  native = {
    setLaneSelection: async (selection: LaneSelection | null) => {
      await this.request("native.setLaneSelection", { selection });
    },
    openExternalURL: async (url: string) => {
      await this.request("native.openExternalURL", { url });
    },
    getPreferences: (keys: readonly SurfacePreferenceKey[]): Promise<SurfacePreferences> =>
      this.request("native.getPreferences", { keys }),
    setPreferences: async (values: SurfacePreferences) => {
      await this.request("native.setPreferences", values);
    },
    cancel: async (requestId: RequestId) => {
      await this.request("native.cancel", { requestId });
    },
    voice: {
      snapshot: () => this.request("native.voice.snapshot", {}),
      toggleInput: () => this.request("native.voice.toggleInput", {}),
      speak: (text: string) => this.request("native.voice.speak", { text }),
      stopOutput: () => this.request("native.voice.stopOutput", {}),
    },
  };

  selectedScope(): HostScope {
    return this.currentScope();
  }

  private async request<M extends ScoutSurfaceMethod>(
    method: M,
    params: ScoutSurfaceMethodContract[M]["params"],
    scope?: HostScope,
  ): Promise<ScoutSurfaceMethodContract[M]["result"]> {
    const id = requestId();
    const message = {
      v: SCOUT_SURFACE_PROTOCOL_VERSION,
      id,
      surface: this.surface,
      method,
      params,
      ...(scope ? { hostIds: scope.hostIds } : {}),
    } as ScoutSurfaceRequest;
    const reply = await this.handler.postMessage(message);
    if (reply.v !== SCOUT_SURFACE_PROTOCOL_VERSION || reply.id !== id || reply.method !== method) {
      throw new Error("Scout native surface returned a mismatched reply");
    }
    if ("error" in reply) {
      throw new Error(`${reply.error.code}: ${reply.error.message}`);
    }
    return reply.result as ScoutSurfaceMethodContract[M]["result"];
  }
}

function requireNativeHandler(): NativeMessageHandler {
  const handler = window.webkit?.messageHandlers?.scoutSurface;
  if (!handler) throw new Error("Scout native surface bridge is unavailable");
  return handler;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `surface-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function subscribeToPush<S extends ScoutSurfacePush["stream"]>(
  stream: S,
  listener: (payload: S extends "tail.delta" ? FleetTailDelta : FleetDispatchDelta) => void,
): () => void {
  const handle = (event: Event) => {
    const payload = (event as CustomEvent<ScoutSurfacePush>).detail;
    if (payload?.stream !== stream || !("payload" in payload)) return;
    listener({
      hostId: payload.hostId,
      cursor: {
        epoch: payload.epoch,
        sequence: payload.sequence,
        connectionRevision: payload.connectionRevision,
      },
      ...(stream === "tail.delta"
        ? { events: (payload as Extract<ScoutSurfacePush, { stream: "tail.delta" }>).payload.events }
        : { records: (payload as Extract<ScoutSurfacePush, { stream: "dispatch.delta" }>).payload.records }),
    } as S extends "tail.delta" ? FleetTailDelta : FleetDispatchDelta);
  };
  window.addEventListener(PUSH_EVENT, handle);
  return () => window.removeEventListener(PUSH_EVENT, handle);
}

export function installScoutSurfacePushReceiver(): void {
  window.__scoutSurface = {
    onPush(payload) {
      window.dispatchEvent(new CustomEvent(PUSH_EVENT, { detail: payload }));
    },
  };
}
