import type { Hono } from "hono";
import { decideScoutWebPairingApproval } from "../pairing.ts";
import { queryFlightRecordById } from "../db-queries.ts";
import { loadScoutBrokerContext, upsertScoutConversation, upsertScoutFlight } from "../core/broker/service.ts";
import type { OpenScoutWebShellState } from "../runtime-summary.ts";
import { defaultCaptureTmuxPane } from "../tmux-pane-capture.ts";
import { dismissCollaborationAttention, buildOperatorAttentionState } from "../core/attention/operator-attention-state.ts";
import type { CreateOpenScoutWebServerOptions } from "../web-server-options.ts";
import type { CachedSnapshot } from "../server-core.ts";
import { approvalDecisionBody } from "../../shared/api/attention.ts";
import { readJsonBody } from "../request-body.ts";

async function dismissFlightAttention(input: {
  flightId: string;
  itemUpdatedAt: number;
}): Promise<void> {
  let flight = null;
  try {
    flight = queryFlightRecordById(input.flightId);
  } catch {
    // The live broker can be ahead of the read-only SQLite projection. Fall
    // through to the canonical broker snapshot instead of making a freshly
    // failed flight impossible to acknowledge.
  }
  if (!flight) {
    const broker = await loadScoutBrokerContext().catch(() => null);
    flight = broker?.snapshot.flights?.[input.flightId] ?? null;
  }
  if (!flight) {
    throw new Error("flight not found");
  }
  await upsertScoutFlight({
    ...flight,
    metadata: {
      ...(flight.metadata ?? {}),
      operatorAttentionDismissedAt: Date.now(),
      operatorAttentionItemUpdatedAt: input.itemUpdatedAt,
      operatorAttentionDismissedBy: "operator",
    },
  });
}

async function dismissConversationFailureAttention(input: {
  conversationId: string;
  messageId: string;
  itemUpdatedAt: number;
}): Promise<void> {
  const broker = await loadScoutBrokerContext().catch(() => null);
  const conversation = broker?.snapshot.conversations?.[input.conversationId];
  if (!conversation) {
    throw new Error("conversation not found");
  }
  await upsertScoutConversation({
    ...conversation,
    metadata: {
      ...(conversation.metadata ?? {}),
      operatorAttentionDismissedMessageId: input.messageId,
      operatorAttentionDismissedAt: Date.now(),
      operatorAttentionItemUpdatedAt: input.itemUpdatedAt,
      operatorAttentionDismissedBy: "operator",
    },
  });
}

export type AttentionRouteDeps = {
  options: Pick<CreateOpenScoutWebServerOptions, "captureTmuxPane">;
  currentDirectory: string;
  shellStateCache: CachedSnapshot<OpenScoutWebShellState>;
};

export function mountAttentionRoutes(app: Hono, deps: AttentionRouteDeps) {
  const { currentDirectory, options, shellStateCache } = deps;

  app.get("/api/operator-attention", async (c) =>
    c.json(await buildOperatorAttentionState(
      currentDirectory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    )),
  );
  app.post("/api/operator-attention/approvals/decide", async (c) => {
    const parsed = await readJsonBody(c, approvalDecisionBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!body.sessionId || !body.turnId || !body.blockId || typeof body.version !== "number") {
      return c.json({ error: "sessionId, turnId, blockId, and version are required" }, 400);
    }
    const decision = body.decision === "approve" || body.decision === "deny" ? body.decision : null;
    if (!decision) {
      return c.json({ error: "decision must be approve or deny" }, 400);
    }
    await decideScoutWebPairingApproval(
      {
        sessionId: body.sessionId,
        turnId: body.turnId,
        blockId: body.blockId,
        version: body.version,
        decision,
        reason: body.reason ?? null,
      },
      currentDirectory,
    );
    shellStateCache.invalidate();
    return c.json(await buildOperatorAttentionState(
      currentDirectory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    ));
  });
  app.post("/api/operator-attention/dismiss", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      recordKind?: unknown;
      recordId?: unknown;
      flightId?: unknown;
      conversationId?: unknown;
      messageId?: unknown;
      itemUpdatedAt?: unknown;
    };
    const recordKind = body.recordKind === "work_item" || body.recordKind === "question"
      ? body.recordKind
      : null;
    const recordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    const flightId = typeof body.flightId === "string" ? body.flightId.trim() : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
    const itemUpdatedAt = typeof body.itemUpdatedAt === "number" && Number.isFinite(body.itemUpdatedAt)
      ? body.itemUpdatedAt
      : 0;
    if (
      itemUpdatedAt <= 0
      || (!flightId && (!recordKind || !recordId) && (!conversationId || !messageId))
    ) {
      return c.json({
        error: "recordKind and recordId, flightId, or conversationId and messageId, plus itemUpdatedAt are required",
      }, 400);
    }
    if (flightId) {
      await dismissFlightAttention({ flightId, itemUpdatedAt });
    }
    if (conversationId && messageId) {
      await dismissConversationFailureAttention({ conversationId, messageId, itemUpdatedAt });
    } else if (!flightId && recordKind && recordId) {
      await dismissCollaborationAttention({ recordKind, recordId, itemUpdatedAt });
    }
    return c.json(await buildOperatorAttentionState(
      currentDirectory,
      options.captureTmuxPane ?? defaultCaptureTmuxPane,
    ));
  });
}
