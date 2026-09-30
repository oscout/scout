import type { Hono } from "hono";
import { worldBrokerMessages } from "../../shared/world-broker-messages.ts";
import { isOpaqueChannelId } from "@openscout/protocol";
import { coalesce } from "../server-core.ts";
import { queryFleet, queryRecentMessages } from "../db-queries.ts";
import { loadScoutBrokerContext, readScoutBrokerSnapshot } from "../core/broker/service.ts";
import { getScoutConversationMessages } from "../core/conversations/service.ts";
import {
  DEFAULT_MESSAGE_PAGE_LIMIT,
  MessageCursorError,
  clampMessagePageLimit,
  encodeMessageHistoryCursor,
  parseMessageHistoryCursor,
} from "../../shared/message-pagination.ts";
import { parseOptionalPositiveInt } from "../http-helpers.ts";
import type { WebServedMessage } from "../../shared/api/web.ts";

export function mountFleetRoutes(app: Hono) {
  // /api/fleet is polled from dozens of client sites at 10-15s intervals, and
  // every poll re-ran the same SQL assembly. A short coalesce window means one
  // assembly serves the burst. The result varies with the query params, so each
  // distinct param set gets its own window; the param space is a handful of
  // fixed client call sites, with a cap so hand-crafted queries cannot grow the
  // map without bound.
  const fleetResponseCache = new Map<string, () => Promise<ReturnType<typeof queryFleet>>>();
  const readFleetResponse = (opts: {
    limit?: number;
    activityLimit?: number;
    activityLookbackMs?: number;
  }) => {
    const key = `${opts.limit ?? ""}|${opts.activityLimit ?? ""}|${opts.activityLookbackMs ?? ""}`;
    let entry = fleetResponseCache.get(key);
    if (!entry) {
      if (fleetResponseCache.size >= 32) fleetResponseCache.clear();
      entry = coalesce(async () => queryFleet(opts), 1_500);
      fleetResponseCache.set(key, entry);
    }
    return entry();
  };
  app.get("/api/fleet", async (c) =>
    c.json(
      await readFleetResponse({
        limit: parseOptionalPositiveInt(c.req.query("limit")),
        activityLimit: parseOptionalPositiveInt(c.req.query("activityLimit")),
        activityLookbackMs: parseOptionalPositiveInt(c.req.query("activityLookbackMs")),
      }),
    ),
  );
  app.get("/api/world/messages", async (c) => {
    const broker = await loadScoutBrokerContext(undefined, { scope: "conversations", waitForInitial: false });
    return c.json(broker ? worldBrokerMessages(broker.snapshot, Date.now()) : []);
  });
  // Explicit agent-authored notifications are independent of flight completion.
  // Share concurrent polls of the same cursor and bound the read. A timeout is
  // not an empty page: the caller must retain its cursor and retry, not silently
  // skip operator notifications while the broker is under pressure.
  const operatorSignalReaders = new Map<string, () => Promise<Awaited<ReturnType<typeof readScoutBrokerSnapshot>>>>();
  app.get("/api/operator-signals", async (c) => {
    const since = Number(c.req.query("since") ?? "0");
    if (!Number.isFinite(since) || since < 0) return c.json({ error: "since must be epoch milliseconds" }, 400);
    const key = String(since);
    let read = operatorSignalReaders.get(key);
    if (!read) {
      if (operatorSignalReaders.size >= 32) operatorSignalReaders.delete(operatorSignalReaders.keys().next().value!);
      read = coalesce(() => readScoutBrokerSnapshot(undefined, {
        since, scope: "conversations", signal: AbortSignal.timeout(2_000),
      }), 0);
      operatorSignalReaders.set(key, read);
    }
    const snapshot = await read();
    if (!snapshot) {
      c.header("Retry-After", "2");
      return c.json({ error: "operator signals unavailable within the read deadline", partial: true, retryable: true }, 503);
    }
    const afterId = c.req.query("afterId") ?? "";
    const signals = Object.values(snapshot.messages ?? {}).flatMap(message => {
      const value = message.metadata?.operatorSignal;
      if (!value || typeof value !== "object" || Array.isArray(value) || message.actorId === "operator" || (message.createdAt < since || (message.createdAt === since && message.id <= afterId))) return [];
      const signal = value as Record<string, unknown>;
      if (!["need", "notify", "consult"].includes(String(signal.kind))) return [];
      return [{ id: message.id, conversationId: message.conversationId, actorId: message.actorId,
        kind: String(signal.kind), body: message.body, createdAt: message.createdAt }];
    }).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 100);
    return c.json({ signals });
  });

  app.get("/api/messages", async (c) => {
    const cId = c.req.query("chatId")
      || c.req.query("cId")
      || c.req.query("conversationId")
      || undefined;
    if (cId && !isOpaqueChannelId(cId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    // Clamp once, before choosing a source: the broker projection and the
    // SQLite fallback must never disagree about how big a page is.
    const limit = clampMessagePageLimit(
      parseOptionalPositiveInt(c.req.query("limit"), DEFAULT_MESSAGE_PAGE_LIMIT),
      DEFAULT_MESSAGE_PAGE_LIMIT,
    );
    const beforeMessageId = c.req.query("beforeMessageId")?.trim() || undefined;
    // `actor` bounds the page to one agent's neighbourhood — the conversations
    // it is a member of or has spoken in. Without it an agent-scoped view was
    // served the global tail, so an agent's own map showed whatever else the
    // fleet happened to be doing. It only narrows a conversation-less read;
    // an explicit chat id is already the tighter bound.
    const actorId = cId ? undefined : c.req.query("actor")?.trim() || undefined;
    let messages;
    try {
      // Cursor shape is the route's business — a malformed cursor is a 400
      // whichever source would have answered. Whether the cursor still resolves
      // is the source's business, and the source throws the same error type.
      parseMessageHistoryCursor(beforeMessageId);
      const brokerContext = cId
        ? await loadScoutBrokerContext(undefined, {
            scope: "conversations",
            waitForInitial: false,
            initialRefreshDelayMs: 750,
          }).catch(() => null)
        : null;
      const brokerMessages = cId
        ? await getScoutConversationMessages(cId, limit, beforeMessageId, brokerContext)
        : null;
      if (cId && brokerMessages && brokerMessages.length > 0 && brokerMessages.length < limit) {
        // The broker snapshot is a rolling window: a short page means the
        // window starts mid-transcript, not that the transcript starts there.
        // An aged conversation re-minted live by new traffic would otherwise
        // serve only the new tail while SQLite still holds the history, so
        // extend the page below the window from the durable projection.
        const oldest = brokerMessages[0];
        const seen = new Set(brokerMessages.map((message) => message.id));
        const older = queryRecentMessages(limit - brokerMessages.length, {
          conversationId: cId,
          beforeMessageId: encodeMessageHistoryCursor({
            createdAt: oldest.createdAt,
            id: oldest.id,
          }),
        }).filter((message) => !seen.has(message.id));
        // Projection pages are newest-first; flip them under the broker's
        // ascending page so the merge reads as one transcript.
        messages = [...older.reverse(), ...brokerMessages];
      } else {
        messages = brokerMessages ?? queryRecentMessages(
          limit,
          { conversationId: cId, actorId, beforeMessageId },
        );
      }
    } catch (cause) {
      // An unreadable cursor is a client error, not the end of the transcript.
      // Answering [] here is what strands history behind a deleted anchor.
      if (cause instanceof MessageCursorError) {
        return c.json({ error: cause.message, reason: cause.reason }, 400);
      }
      throw cause;
    }
    // The client reads this as `WebServedMessage`; both sources must fit it.
    const served: WebServedMessage[] = messages;
    return c.json(served.map((message) => ({
      ...message,
      chatId: message.conversationId,
      cId: message.conversationId,
    })));
  });
}
