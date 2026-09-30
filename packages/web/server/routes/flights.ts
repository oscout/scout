import type { Hono } from "hono";
import { isOpaqueChannelId } from "@openscout/protocol";
import { queryFollowTarget, queryRuns } from "../db-queries.ts";
import { loadScoutBrokerContext } from "../core/broker/service.ts";
import { queryBrokerFlightsForWeb } from "../web-flights.ts";
import { parseOptionalPositiveInt } from "../http-helpers.ts";

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  return undefined;
}

export function mountFlightRoutes(app: Hono) {
  app.get("/api/runs", (c) => {
    const agentId = c.req.query("agentId");
    const conversationId = c.req.query("conversationId");
    const collaborationRecordId = c.req.query("collaborationRecordId");
    const workId = c.req.query("workId");
    const state = c.req.query("state");
    const source = c.req.query("source");
    const active = parseOptionalBoolean(c.req.query("active"));
    const limit = parseOptionalPositiveInt(c.req.query("limit"));
    return c.json(
      queryRuns({
        agentId: agentId || undefined,
        conversationId: conversationId || undefined,
        collaborationRecordId: collaborationRecordId || undefined,
        workId: workId || undefined,
        state: state || undefined,
        source: source || undefined,
        active,
        limit,
      }),
    );
  });
  app.get("/api/flights", async (c) => {
    const flightId = c.req.query("flightId");
    const agentId = c.req.query("agentId");
    const conversationId = c.req.query("conversationId");
    const collaborationRecordId = c.req.query("collaborationRecordId");
    const activeOnly = c.req.query("active") !== "false";
    if (conversationId && !isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const query = {
      flightId: flightId || undefined,
      agentId: agentId || undefined,
      conversationId: conversationId || undefined,
      collaborationRecordId: collaborationRecordId || undefined,
      activeOnly,
    };
    const broker = await loadScoutBrokerContext(undefined, {
      scope: "conversations",
      waitForInitial: false,
      initialRefreshDelayMs: 750,
    }).catch(() => null);
    return c.json(queryBrokerFlightsForWeb(broker, query));
  });
  app.get("/api/follow", (c) => {
    const conversationId = c.req.query("conversationId") || undefined;
    if (conversationId && !isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    return c.json(
      queryFollowTarget({
        flightId: c.req.query("flightId") || undefined,
        invocationId: c.req.query("invocationId") || undefined,
        conversationId,
        workId: c.req.query("workId") || undefined,
        sessionId: c.req.query("sessionId") || undefined,
        targetAgentId: c.req.query("targetAgentId") || undefined,
      }),
    );
  });
}
