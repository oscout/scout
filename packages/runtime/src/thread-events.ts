import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

import type {
  ConversationDefinition,
  ThreadEventEnvelope,
  ThreadSnapshot,
  ThreadWatchCloseRequest,
  ThreadWatchError,
  ThreadWatchOpenRequest,
  ThreadWatchOpenResponse,
  ThreadWatchRenewRequest,
  ThreadWatchRenewResponse,
} from "@openscout/protocol";

import type { RecoverableSQLiteProjection } from "./sqlite-projection.js";

type ConversationLookup = {
  conversation(conversationId: string): ConversationDefinition | undefined;
};

type LiveWatch = {
  watchId: string;
  conversationId: string;
  watcherNodeId: string;
  watcherId: string;
  acceptedAfterSeq: number;
  leaseExpiresAt: number;
  mode: "summary" | "shared";
  clients: Set<RuntimeHttpResponseLike>;
};

export class ThreadWatchProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly body: ThreadWatchError,
  ) {
    super(body.message);
  }
}

function watchKey(conversationId: string, watcherNodeId: string, watcherId: string): string {
  return `${conversationId}:${watcherNodeId}:${watcherId}`;
}

function writeSse(response: RuntimeHttpResponseLike, eventName: string, payload: unknown): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export class ThreadEventPlane {
  private readonly watches = new Map<string, LiveWatch>();
  private readonly watchIdsByKey = new Map<string, string>();
  private readonly watchIdsByConversation = new Map<string, Set<string>>();

  constructor(
    private readonly options: {
      nodeId: string;
      runtime: ConversationLookup;
      projection: RecoverableSQLiteProjection;
      defaultLeaseMs?: number;
      maxLeaseMs?: number;
      maxReplayLimit?: number;
    },
  ) {}

  async openWatch(request: ThreadWatchOpenRequest): Promise<ThreadWatchOpenResponse> {
    const conversation = this.requireConversationAuthority(request.conversationId);
    this.requireRemoteWatchAllowed(conversation);

    const afterSeq = Math.max(0, request.afterSeq ?? 0);
    const oldestSeq = await this.options.projection.oldestThreadSeq(conversation.id);
    const latestSeq = await this.options.projection.latestThreadSeq(conversation.id);

    if (latestSeq > 0 && oldestSeq > 0 && afterSeq < oldestSeq - 1) {
      throw new ThreadWatchProtocolError(409, {
        code: "cursor_out_of_range",
        message: `thread cursor ${afterSeq} is older than retained seq ${oldestSeq}`,
      });
    }

    const key = watchKey(conversation.id, request.watcherNodeId, request.watcherId);
    const existingWatchId = this.watchIdsByKey.get(key);
    if (existingWatchId) {
      this.closeWatchInternal(existingWatchId);
    }

    const watchId = `thread-watch:${conversation.id}:${request.watcherNodeId}:${request.watcherId}`;
    const leaseExpiresAt = Date.now() + this.normalizeLeaseMs(request.leaseMs);
    const watch: LiveWatch = {
      watchId,
      conversationId: conversation.id,
      watcherNodeId: request.watcherNodeId,
      watcherId: request.watcherId,
      acceptedAfterSeq: afterSeq,
      leaseExpiresAt,
      mode: conversation.shareMode === "summary" ? "summary" : "shared",
      clients: new Set(),
    };
    this.watches.set(watchId, watch);
    this.watchIdsByKey.set(key, watchId);
    this.indexWatch(watch);

    return {
      watchId,
      conversationId: conversation.id,
      authorityNodeId: conversation.authorityNodeId,
      acceptedAfterSeq: afterSeq,
      latestSeq,
      leaseExpiresAt,
      mode: watch.mode,
    };
  }

  async renewWatch(request: ThreadWatchRenewRequest): Promise<ThreadWatchRenewResponse> {
    const watch = this.requireLiveWatch(request.watchId);
    watch.leaseExpiresAt = Date.now() + this.normalizeLeaseMs(request.leaseMs);
    return {
      watchId: watch.watchId,
      leaseExpiresAt: watch.leaseExpiresAt,
    };
  }

  async closeWatch(request: ThreadWatchCloseRequest): Promise<void> {
    this.closeWatchInternal(request.watchId);
  }

  async replay(options: {
    conversationId: string;
    afterSeq: number;
    limit?: number;
  }): Promise<ThreadEventEnvelope[]> {
    const conversation = this.requireConversationAuthority(options.conversationId);
    this.requireRemoteWatchAllowed(conversation);

    const oldestSeq = await this.options.projection.oldestThreadSeq(conversation.id);
    const latestSeq = await this.options.projection.latestThreadSeq(conversation.id);
    if (latestSeq > 0 && oldestSeq > 0 && options.afterSeq < oldestSeq - 1) {
      throw new ThreadWatchProtocolError(409, {
        code: "cursor_out_of_range",
        message: `thread cursor ${options.afterSeq} is older than retained seq ${oldestSeq}`,
      });
    }

    return this.options.projection.listThreadEvents({
      conversationId: conversation.id,
      afterSeq: options.afterSeq,
      limit: Math.min(options.limit ?? 500, this.options.maxReplayLimit ?? 2_000),
    });
  }

  async snapshot(conversationId: string): Promise<ThreadSnapshot> {
    const conversation = this.requireConversationAuthority(conversationId);
    this.requireRemoteWatchAllowed(conversation);

    const snapshot = await this.options.projection.getThreadSnapshot(conversation.id);
    if (!snapshot) {
      throw new ThreadWatchProtocolError(404, {
        code: "unknown_conversation",
        message: `unknown conversation ${conversation.id}`,
      });
    }
    return snapshot;
  }

  async streamWatch(
    watchId: string,
    request: RuntimeHttpRequestLike,
    response: RuntimeHttpResponseLike,
  ): Promise<void> {
    const watch = this.requireLiveWatch(watchId);
    const backlog = await this.options.projection.listThreadEvents({
      conversationId: watch.conversationId,
      afterSeq: watch.acceptedAfterSeq,
      limit: this.options.maxReplayLimit ?? 2_000,
    });

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    writeSse(response, "hello", {
      watchId: watch.watchId,
      conversationId: watch.conversationId,
      leaseExpiresAt: watch.leaseExpiresAt,
    });
    for (const event of backlog) {
      writeSse(response, "thread.event", event);
    }

    watch.clients.add(response);
    request.on("close", () => {
      watch.clients.delete(response);
      response.end();
    });
  }

  publish(events: ThreadEventEnvelope[]): void {
    for (const event of events) {
      const watchIds = this.watchIdsByConversation.get(event.conversationId);
      if (!watchIds || watchIds.size === 0) {
        continue;
      }

      for (const watchId of [...watchIds]) {
        const watch = this.watches.get(watchId);
        if (!watch) {
          watchIds.delete(watchId);
          continue;
        }
        if (watch.leaseExpiresAt <= Date.now()) {
          this.closeWatchInternal(watchId);
          continue;
        }
        for (const client of watch.clients) {
          writeSse(client, "thread.event", event);
        }
      }
    }
  }

  private normalizeLeaseMs(requestedLeaseMs?: number): number {
    const defaultLeaseMs = this.options.defaultLeaseMs ?? 30_000;
    const maxLeaseMs = this.options.maxLeaseMs ?? 300_000;
    if (!requestedLeaseMs || !Number.isFinite(requestedLeaseMs) || requestedLeaseMs <= 0) {
      return defaultLeaseMs;
    }
    return Math.min(Math.max(requestedLeaseMs, 5_000), maxLeaseMs);
  }

  private requireConversationAuthority(conversationId: string): ConversationDefinition {
    const conversation = this.options.runtime.conversation(conversationId);
    if (!conversation) {
      throw new ThreadWatchProtocolError(404, {
        code: "unknown_conversation",
        message: `unknown conversation ${conversationId}`,
      });
    }
    if (conversation.authorityNodeId !== this.options.nodeId) {
      throw new ThreadWatchProtocolError(409, {
        code: "no_responder",
        message: `conversation ${conversationId} is owned by ${conversation.authorityNodeId}`,
      });
    }
    return conversation;
  }

  private requireRemoteWatchAllowed(conversation: ConversationDefinition): void {
    if (conversation.shareMode === "local") {
      throw new ThreadWatchProtocolError(403, {
        code: "forbidden",
        message: `conversation ${conversation.id} does not allow remote watches`,
      });
    }
  }

  private requireLiveWatch(watchId: string): LiveWatch {
    const watch = this.watches.get(watchId);
    if (!watch) {
      throw new ThreadWatchProtocolError(404, {
        code: "invalid_request",
        message: `unknown watch ${watchId}`,
      });
    }
    if (watch.leaseExpiresAt <= Date.now()) {
      this.closeWatchInternal(watchId);
      throw new ThreadWatchProtocolError(410, {
        code: "lease_expired",
        message: `watch ${watchId} lease expired`,
      });
    }
    return watch;
  }

  private indexWatch(watch: LiveWatch): void {
    const ids = this.watchIdsByConversation.get(watch.conversationId) ?? new Set<string>();
    ids.add(watch.watchId);
    this.watchIdsByConversation.set(watch.conversationId, ids);
  }

  private closeWatchInternal(watchId: string): void {
    const watch = this.watches.get(watchId);
    if (!watch) {
      return;
    }

    this.watches.delete(watchId);
    this.watchIdsByKey.delete(watchKey(watch.conversationId, watch.watcherNodeId, watch.watcherId));

    const ids = this.watchIdsByConversation.get(watch.conversationId);
    if (ids) {
      ids.delete(watchId);
      if (ids.size === 0) {
        this.watchIdsByConversation.delete(watch.conversationId);
      }
    }

    for (const client of watch.clients) {
      client.end();
    }
    watch.clients.clear();
  }
}
