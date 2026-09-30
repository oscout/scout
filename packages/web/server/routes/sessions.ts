import type { Hono } from "hono";
import { isOpaqueChannelId } from "@openscout/protocol";
import { querySessions, querySessionById } from "../db-queries.ts";
import { loadScoutBrokerContext } from "../core/broker/service.ts";
import { getScoutConversationById, getScoutConversations } from "../core/conversations/service.ts";
import { loadSessionRefObservePayload } from "../core/observe/service.ts";
import { sessionTouchedResponse } from "../observe-payload.ts";
import { SCOUTBOT_DEFAULT_THREAD_ID } from "../scoutbot/role.ts";
import { parseSessionRouteRef, sessionHarnessMatches } from "../../shared/session-route-ref.ts";
import type { ScoutbotWebServices } from "./scoutbot.ts";

const LEGACY_SCOUTBOT_CONVERSATION_IDS = new Set([
  "dm.operator.scoutbot",
  "dm.operator.scoutbot.default",
]);

function isLegacyScoutbotConversationId(value: string): boolean {
  return LEGACY_SCOUTBOT_CONVERSATION_IDS.has(value.trim());
}

export type SessionRouteDeps = {
  scoutbot: ScoutbotWebServices;
};

export function mountSessionRoutes(app: Hono, deps: SessionRouteDeps) {
  const { scoutbot } = deps;

  const resolveSessionRequestConversationId = async (conversationId: string): Promise<string | null> => {
    if (isOpaqueChannelId(conversationId)) return conversationId;
    const scoutbotRunner = scoutbot.runner ?? await scoutbot.waitForRunner();
    if (!isLegacyScoutbotConversationId(conversationId) || !scoutbotRunner) return null;
    try {
      const threadList = await scoutbotRunner.getThreads();
      const thread = threadList.threads.find((candidate) => candidate.threadId === threadList.defaultThreadId)
        ?? threadList.threads.find((candidate) => candidate.threadId === SCOUTBOT_DEFAULT_THREAD_ID)
        ?? threadList.threads[0];
      const canonicalConversationId = thread?.conversationId?.trim();
      return isOpaqueChannelId(canonicalConversationId) ? canonicalConversationId : null;
    } catch {
      return null;
    }
  };

  app.get("/api/sessions", (c) => c.json(querySessions()));
  app.get("/api/session-ref/:id", async (c) => {
    const refId = c.req.param("id");
    const conversation = isOpaqueChannelId(refId) ? querySessionById(refId) : null;
    if (conversation) {
      return c.json({
        kind: "conversation",
        refId,
        conversationId: conversation.id,
        session: conversation,
      });
    }

    const payload = await loadSessionRefObservePayload(refId);
    if (payload) {
      // A raw observed transcript has no writable Scout owner. Avoid building
      // the full session list for this common read-only path; on large pilot
      // databases that projection can dominate the time to open a tiny file.
      const parsedRef = payload.agentId ? parseSessionRouteRef(refId) : null;
      const harnessSession = parsedRef
        ? querySessions(200).find((session) =>
            sessionHarnessMatches(parsedRef.harness, session.harness)
            && parseSessionRouteRef(session.harnessSessionId)?.refId === parsedRef.refId
          )
        : null;
      return c.json({
        kind: "observe",
        refId,
        // A provider id can collide with an explicit broker actor/handle ref.
        // Only expose a writable Scout conversation when both projections
        // resolve to the same owner; observe-only remains safe otherwise.
        session: harnessSession?.agentId === payload.agentId ? harnessSession : null,
        observe: payload,
      });
    }
    return c.json({ error: "not found" }, 404);
  });
  app.get("/api/session-ref/:id/touched", async (c) => {
    const refId = c.req.param("id");
    const payload = await loadSessionRefObservePayload(refId);
    if (!payload) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(sessionTouchedResponse(payload, refId));
  });
  app.get("/api/session/:id", async (c) => {
    const chatId = c.req.param("id");
    const resolvedChatId = await resolveSessionRequestConversationId(chatId);
    if (!resolvedChatId) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const session = querySessionById(resolvedChatId);
    const broker = session
      ? await loadScoutBrokerContext(undefined, {
          scope: "conversations",
          waitForInitial: false,
          initialRefreshDelayMs: 750,
        }).catch(() => null)
      : undefined;
    const conversation = broker === null
      ? null
      : broker
        ? (await getScoutConversations(
            { conversationId: resolvedChatId, limit: 1 },
            broker,
          ))[0] ?? null
        : await getScoutConversationById(resolvedChatId);
    if (session && conversation) {
      // SQLite contributes harness-local fields, but the broker owns Chat
      // identity, transcript recency, equivalent ids, and turn lifecycle.
      return c.json({ ...session, ...conversation });
    }
    if (session) {
      return c.json(session);
    }
    return conversation ? c.json(conversation) : c.json({ error: "not found" }, 404);
  });
}
