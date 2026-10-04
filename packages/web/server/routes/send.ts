import type { Hono } from "hono";
import {
  channelNaturalKeyFromMetadata,
  extractAgentSelectors,
  isOpaqueChannelId,
  resolveAgentIdentity,
} from "@openscout/protocol";
import {
  queryAgentById,
  queryAgents,
  queryConversationDefinitionById,
  querySessionById,
  queryRuns,
} from "../db-queries.ts";
import { configuredOperatorActorIds } from "../db/internal/conversation-ids.ts";
import {
  askScoutQuestion,
  loadScoutBrokerContext,
  type OutgoingAttachmentInput,
  sendScoutConversationMessage,
  sendScoutConversationSteer,
  sendScoutDirectMessage,
  sendScoutMessage,
  upsertScoutConversation,
} from "../core/broker/service.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import { recordInput } from "../web-flights.ts";
import { metadataStringValue } from "../metadata-values.ts";
import { optionalString, coerceAgentHarness } from "../request-values.ts";
import type { ScoutbotWebServices } from "./scoutbot.ts";
import { askBody, chatMessageSendBody, sendBody, sessionReplyBody } from "../../shared/api/send.ts";
import { askMobileHarnessSession } from "../core/mobile/ask-session.ts";
import { readJsonBody } from "../request-body.ts";

function inferDirectTargetAgentId(
  conversationId: string | undefined,
  session: {
    kind: string;
    agentId?: string | null;
    participantIds: string[];
  } | null,
  senderId: string,
): string | null {
  if (session?.kind === "direct") {
    const operatorCandidates = new Set([
      senderId.trim(),
      "operator",
      process.env.OPENSCOUT_OPERATOR_NAME?.trim(),
      ...configuredOperatorActorIds(),
    ].filter((candidate): candidate is string => Boolean(candidate)));
    if (session.agentId) {
      const participants = session.participantIds.filter(
        (participantId) => participantId.trim().length > 0,
      );
      if (
        participants.length === 0 ||
        participants.some((participantId) => operatorCandidates.has(participantId))
      ) {
        return session.agentId;
      }
      return null;
    }

    const participants = session.participantIds.filter(
      (participantId) => participantId.trim().length > 0,
    );
    if (participants.length === 2) {
      if (!participants.some((participantId) => operatorCandidates.has(participantId))) {
        return null;
      }
      const nonOperatorParticipants = participants.filter(
        (participantId) => !operatorCandidates.has(participantId),
      );
      if (nonOperatorParticipants.length === 1) {
        return nonOperatorParticipants[0] ?? null;
      }

      const localSessionParticipant =
        nonOperatorParticipants.find((participantId) =>
          participantId.startsWith("local-session-agent-"),
        ) ??
        participants.find((participantId) =>
          participantId.startsWith("local-session-agent-"),
        );
      if (localSessionParticipant) {
        return localSessionParticipant;
      }

      return participants[0] ?? null;
    }
  }

  return null;
}

function inferDirectSenderId(
  _session: { kind: string; participantIds: string[] } | null,
  _fallbackSenderId: string,
  _directTargetAgentId: string | null,
): string {
  // Web-originated sends must use the canonical operator actor id so direct
  // chat membership stays stable while the chat id itself remains opaque.
  return "operator";
}

function sessionIncludesOperatorParticipant(session: { participantIds: string[] } | null): boolean {
  if (!session) return false;
  const operatorIds = new Set([
    "operator",
    process.env.OPENSCOUT_OPERATOR_NAME?.trim(),
    ...configuredOperatorActorIds(),
  ].filter((value): value is string => Boolean(value)));
  return session.participantIds.some((participantId) => operatorIds.has(participantId));
}

function defaultSendModeForConversationSession(input: {
  session: { kind: string; participantIds: string[] } | null;
  hasExplicitTarget: boolean;
  hasActiveRun: boolean;
}): "invoke" | "steer" | "message" {
  const isOperatorDirect =
    input.session?.kind === "direct" && sessionIncludesOperatorParticipant(input.session);
  if (!isOperatorDirect && !input.hasExplicitTarget) {
    return "message";
  }
  return input.hasActiveRun ? "steer" : "invoke";
}

type ChatMessagePlacement =
  | { kind: "root" }
  | { kind: "inline_reply"; replyToMessageId: string }
  | {
      kind: "thread_reply";
      parentConversationId: string;
      anchorMessageId: string;
      replyToMessageId?: string;
    };

function resolveChatMessagePlacement(
  chatId: string,
  replyToMessageId?: string,
): ChatMessagePlacement {
  const conversation = queryConversationDefinitionById(chatId);
  if (conversation?.parentConversationId && conversation.messageId) {
    return {
      kind: "thread_reply",
      parentConversationId: conversation.parentConversationId,
      anchorMessageId: conversation.messageId,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };
  }
  return replyToMessageId
    ? { kind: "inline_reply", replyToMessageId }
    : { kind: "root" };
}

function semanticSessionForChat(
  chatId: string,
  session: { kind: string; participantIds: string[] },
): { kind: string; participantIds: string[] } {
  // A direct Chat may be visually anchored beneath another message while
  // retaining its own direct-work semantics. Only a generic thread Chat needs
  // to inherit the parent Chat's delivery mode.
  if (session.kind !== "thread") return session;
  const definition = queryConversationDefinitionById(chatId);
  if (!definition?.parentConversationId) return session;
  return querySessionById(definition.parentConversationId) ?? session;
}

function steerContextByTargetAgentId(
  runs: ReturnType<typeof queryRuns>,
): Record<string, { runId: string; flightId?: string }> | undefined {
  const entries = new Map<string, { runId: string; flightId?: string }>();
  for (const run of runs) {
    if (entries.has(run.agentId)) continue;
    const flightId = run.flightIds?.[0];
    entries.set(run.agentId, {
      runId: run.id,
      ...(flightId ? { flightId } : {}),
    });
  }
  return entries.size > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveSendSelectorTargetAgentIds(
  selectors: ReturnType<typeof extractAgentSelectors>,
  participantIds: string[],
): string[] {
  if (selectors.length === 0) return [];
  const participantIdSet = new Set(participantIds);
  const candidates = queryAgents()
    .filter((agent) => participantIdSet.has(agent.id))
    .map((agent) => ({
      agentId: agent.id,
      definitionId: agent.definitionId,
      nodeQualifier: agent.nodeQualifier ?? undefined,
      workspaceQualifier: agent.workspaceQualifier ?? undefined,
      harness: agent.harness ?? undefined,
      model: agent.model ?? undefined,
      aliases: [agent.selector, agent.defaultSelector, agent.handle, agent.name]
        .filter((alias): alias is string => Boolean(alias?.trim())),
    }));
  return [...new Set(
    selectors
      .map((selector) => resolveAgentIdentity(selector, candidates)?.agentId)
      .filter((agentId): agentId is string => Boolean(agentId)),
  )];
}

function inferChannelName(
  _conversationId: string | undefined,
  _session: { kind: string } | null,
): string | null {
  return null;
}

function resolveConversationRouting(
  conversationId: string | undefined,
  sessionOverride?: {
    kind: string;
    agentId?: string | null;
    participantIds: string[];
  } | null,
): {
  directAgentId: string | null;
  channel: string | null;
  conversationId: string | null;
  senderId: string;
} {
  const fallbackSenderId = "operator";
  const session = sessionOverride
    ?? (conversationId ? querySessionById(conversationId) : null);
  const senderId = inferDirectSenderId(
    session,
    fallbackSenderId,
    null,
  );
  if (session && conversationId) {
    const channel = inferChannelName(conversationId, session);
    if (channel) {
      return {
        directAgentId: null,
        channel,
        conversationId: null,
        senderId,
      };
    }
    return {
      directAgentId: null,
      channel: null,
      conversationId,
      senderId,
    };
  }
  const directAgentId = inferDirectTargetAgentId(
    conversationId,
    session,
    fallbackSenderId,
  );
  const channel = directAgentId
    ? null
    : inferChannelName(conversationId, session);
  return { directAgentId, channel, conversationId: null, senderId };
}

function resolveConversationAskRouting(conversationId: string | undefined): {
  directAgentId: string | null;
  senderId: string;
} {
  const fallbackSenderId = "operator";
  const session = conversationId ? querySessionById(conversationId) : null;
  const directAgentId = inferDirectTargetAgentId(
    conversationId,
    session,
    fallbackSenderId,
  );
  const senderId = inferDirectSenderId(
    session,
    fallbackSenderId,
    directAgentId,
  );
  return { directAgentId, senderId };
}

export type SendRouteDeps = {
  currentDirectory: string;
  scoutbot: ScoutbotWebServices;
};

export function mountSendRoutes(app: Hono, deps: SendRouteDeps) {
  const { currentDirectory, scoutbot } = deps;

  type ChatMessageDispatchInput = {
    chatId: string;
    body: string;
    clientMessageId?: string;
    attachments?: OutgoingAttachmentInput[];
    replyToMessageId?: string;
    /** Compatibility-only overrides accepted by the transitional /api/send route. */
    requestedSendMode?: string;
    targetParticipantIds?: string[];
    execution?: {
      harness?: unknown;
      model?: unknown;
    };
  };
  type ChatMessageDispatchOutcome =
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; status: 404 | 502; error: string };

  const dispatchOperatorChatMessage = async (
    input: ChatMessageDispatchInput,
  ): Promise<ChatMessageDispatchOutcome> => {
    // Conversation reads already fall back to the live broker snapshot while
    // the SQLite projection catches up. Sends must resolve through the same
    // source or a newly-created broker Chat can render but reject its composer.
    const projectedSession = querySessionById(input.chatId);
    const broker = await loadScoutBrokerContext();
    const liveConversation = broker?.snapshot.conversations[input.chatId] ?? null;
    let routeSession = liveConversation ?? projectedSession ?? null;
    if (broker && liveConversation?.kind === "channel") {
      const naturalKey = channelNaturalKeyFromMetadata(liveConversation.metadata);
      const siblingConversations = naturalKey
        ? Object.values(broker.snapshot.conversations).filter((conversation) =>
            conversation.kind === liveConversation.kind
            && channelNaturalKeyFromMetadata(conversation.metadata) === naturalKey
          )
        : [liveConversation];
      const participantIds = [...new Set(
        siblingConversations.flatMap((conversation) => conversation.participantIds),
      )].sort();
      if (participantIds.join("\u0000") !== [...liveConversation.participantIds].sort().join("\u0000")) {
        const reconciledConversation = { ...liveConversation, participantIds };
        await upsertScoutConversation(reconciledConversation, broker.baseUrl);
        broker.snapshot.conversations[input.chatId] = reconciledConversation;
        routeSession = reconciledConversation;
      }
    }
    if (!routeSession) {
      return { ok: false, status: 404, error: "chat not found" };
    }

    const semanticSession = semanticSessionForChat(input.chatId, routeSession);
    const { conversationId: routedConversationId, senderId } =
      resolveConversationRouting(input.chatId, routeSession);
    if (!routedConversationId) {
      return { ok: false, status: 404, error: "chat not found" };
    }

    const isOperatorDirectConversation =
      semanticSession.kind === "direct" && sessionIncludesOperatorParticipant(semanticSession);
    const isSharedChat =
      routeSession.kind === "channel"
      || routeSession.kind === "group_direct"
      || (routeSession.kind === "thread" && !isOperatorDirectConversation);
    const scopedTargetParticipantIds = Array.isArray(input.targetParticipantIds)
      ? [...new Set(
          input.targetParticipantIds
            .filter((targetId): targetId is string => typeof targetId === "string")
            .map((targetId) => targetId.trim())
            .filter(Boolean),
        )]
      : undefined;
    const requestedSendMode = input.requestedSendMode?.trim();
    const selectors = extractAgentSelectors(input.body);
    const selectorTargetAgentIds = resolveSendSelectorTargetAgentIds(
      selectors,
      routeSession.participantIds,
    );
    const hasExplicitTarget =
      Boolean(scopedTargetParticipantIds?.length)
      || selectors.length > 0;
    const shouldInspectActiveRuns =
      requestedSendMode?.toLowerCase() === "steer"
      || (!requestedSendMode && (isOperatorDirectConversation || hasExplicitTarget));
    const activeRuns = shouldInspectActiveRuns
      ? queryRuns({
          conversationId: routedConversationId,
          active: true,
          limit: 100,
        })
      : [];
    const resolvedTargetIds = new Set([
      ...(scopedTargetParticipantIds ?? []),
      ...selectorTargetAgentIds,
    ]);
    const matchedActiveRuns = hasExplicitTarget
      ? activeRuns.filter((run) => resolvedTargetIds.has(run.agentId))
      : activeRuns;
    const hasActiveRun = matchedActiveRuns.length > 0;
    const steerContext = steerContextByTargetAgentId(matchedActiveRuns);
    const sendMode = (requestedSendMode
      || defaultSendModeForConversationSession({
        session: semanticSession,
        hasExplicitTarget,
        hasActiveRun,
      })).toLowerCase();
    const shouldCommentOnly =
      sendMode === "comment"
      || sendMode === "message"
      || (sendMode === "tell" && !isOperatorDirectConversation);
    const executionHarness = coerceAgentHarness(input.execution?.harness);
    const executionModel = optionalString(input.execution?.model)?.trim();
    const requestedExecution = executionHarness || executionModel
      ? {
          ...(executionHarness ? { harness: executionHarness } : {}),
          ...(executionModel ? { model: executionModel } : {}),
        }
      : undefined;
    const result = shouldCommentOnly
      ? await sendScoutConversationMessage({
          conversationId: routedConversationId,
          senderId,
          body: input.body,
          attachments: input.attachments,
          replyToMessageId: input.replyToMessageId,
          clientMessageId: input.clientMessageId,
          // Shared Chat membership is broker-owned. A passive post creates
          // durable visibility deliveries without creating requested work.
          notifyParticipantAgents: isSharedChat,
          currentDirectory,
          source: "scout-web",
        })
      // A send into an existing Chat never leaves that Chat. The former
      // invoke shortcut through sendScoutDirectMessage let the broker derive
      // a (requester ↔ target) conversation and forced execution.session
      // "new", so an in-place reply could mint a sibling Chat and a fresh
      // harness session. The steer path posts into this conversation and its
      // invocations continue the participant's live session; pair-derived
      // delivery remains only for sends that arrive with no Chat at all.
      : await sendScoutConversationSteer({
          conversationId: routedConversationId,
          senderId,
          body: input.body,
          attachments: input.attachments,
          replyToMessageId: input.replyToMessageId,
          clientMessageId: input.clientMessageId,
          ...(scopedTargetParticipantIds?.length
            ? { targetParticipantIds: scopedTargetParticipantIds }
            : {}),
          intent: sendMode === "tell"
            ? "tell"
            : sendMode === "invoke"
              ? "invoke"
              : "steer",
          ...(sendMode === "steer" && steerContext
            ? { steerContextByTargetAgentId: steerContext }
            : {}),
          ...(requestedExecution ? { execution: requestedExecution } : {}),
          currentDirectory,
          source: "scout-web",
        });
    if (!result.usedBroker) {
      return { ok: false, status: 502, error: "broker unreachable" };
    }
    const flights = result.flights?.length
      ? result.flights
      : result.flight
        ? [result.flight]
        : [];
    return {
      ok: true,
      result: {
        ...result,
        conversationId: routedConversationId,
        chatId: routedConversationId,
        runIds: flights.map((flight) => `run:flight:${flight.id}`),
      },
    };
  };

  // The web composer speaks in Chat terms only.  Delivery policy, requested
  // work, and thread placement are server-owned consequences of that Chat and
  // an optional reply anchor; callers do not send routing modes or recipient
  // lists.  `/api/send` remains below as the compatibility surface for older
  // clients and automation.
  app.post("/api/chats/:chatId/messages", async (c) => {
    const chatId = c.req.param("chatId");
    if (!isOpaqueChannelId(chatId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }

    const parsed = await readJsonBody(c, chatMessageSendBody);
    if (!parsed.ok) return parsed.response;
    const requestBody = parsed.body;
    const body = optionalString(requestBody.body) ?? "";
    const attachments = requestBody.attachments;
    if (!body.trim() && !attachments?.length) {
      return c.json({ error: "body or attachments are required" }, 400);
    }
    const hasReplyAnchor = requestBody.replyToMessageId !== undefined
      && requestBody.replyToMessageId !== null;
    const replyToMessageId = hasReplyAnchor
      ? optionalString(requestBody.replyToMessageId)?.trim()
      : undefined;
    if (hasReplyAnchor && !replyToMessageId) {
      return c.json({ error: "replyToMessageId must be a non-empty string" }, 400);
    }
    const hasClientMessageId = requestBody.clientMessageId !== undefined
      && requestBody.clientMessageId !== null;
    const clientMessageId = hasClientMessageId
      ? optionalString(requestBody.clientMessageId)?.trim()
      : undefined;
    if (hasClientMessageId && !clientMessageId) {
      return c.json({ error: "clientMessageId must be a non-empty string" }, 400);
    }

    const outcome = await dispatchOperatorChatMessage({
      chatId,
      body: body.trim(),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    if (!outcome.ok) {
      return c.json({ error: outcome.error }, outcome.status);
    }

    return c.json({
      ...outcome.result,
      placement: resolveChatMessagePlacement(chatId, replyToMessageId),
    });
  });

  app.post("/api/send", async (c) => {
    const parsed = await readJsonBody(c, sendBody);
    if (!parsed.ok) return parsed.response;
    const { body, chatId, cId, conversationId, threadId, attachments, intent, mode, targetParticipantIds, replyToMessageId, execution } = parsed.body;
    const messageBody = body?.trim() ?? "";
    if (!messageBody && !attachments?.length) {
      return c.json({ error: "body or attachments are required" }, 400);
    }
    const hasReplyToMessageId = replyToMessageId !== undefined && replyToMessageId !== null;
    const routedReplyToMessageId = hasReplyToMessageId ? optionalString(replyToMessageId)?.trim() : undefined;
    if (hasReplyToMessageId && !routedReplyToMessageId) {
      return c.json({ error: "replyToMessageId must be a non-empty string" }, 400);
    }

    const routeCId = optionalString(chatId) ?? optionalString(cId) ?? optionalString(conversationId);
    if (routeCId && !isOpaqueChannelId(routeCId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    if (routeCId) {
      const outcome = await dispatchOperatorChatMessage({
        chatId: routeCId,
        body: messageBody,
        attachments,
        replyToMessageId: routedReplyToMessageId,
        requestedSendMode: optionalString(intent)?.trim() || optionalString(mode)?.trim(),
        targetParticipantIds,
        execution,
      });
      if (!outcome.ok) {
        return c.json({ error: outcome.error }, outcome.status);
      }
      return c.json(outcome.result);
    }

    const scoutbotRunner = scoutbot.runner;
    if (scoutbotRunner) {
      try {
        const result = await scoutbotRunner.postOperatorMessage({
          body: messageBody,
          threadId,
          attachments,
          replyToMessageId: routedReplyToMessageId,
        });
        if (!result.usedBroker) {
          return c.json({ error: "broker unreachable" }, 502);
        }
        return c.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, /unknown scoutbot thread/i.test(message) ? 404 : 500);
      }
    }

    const { directAgentId, channel, senderId } = resolveConversationRouting(undefined);

    if (directAgentId) {
      const result = await sendScoutDirectMessage({
        agentId: directAgentId,
        body: messageBody,
        attachments,
        replyToMessageId: routedReplyToMessageId,
        currentDirectory,
        source: "scout-web",
      });
      return c.json({
        ...result,
        chatId: result.conversationId,
        runIds: result.flight ? [`run:flight:${result.flight.id}`] : [],
      });
    }

    const result = await sendScoutMessage({
      senderId,
      body: messageBody,
      ...(channel ? { channel } : {}),
      attachments,
      currentDirectory,
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }

    return c.json({
      ...result,
      ...(result.conversationId ? { chatId: result.conversationId } : {}),
      runIds: result.flight ? [`run:flight:${result.flight.id}`] : [],
    });
  });

  // Reply to a harness session by id (the TUI's composer). Lands in the live
  // place or resumes; expected refusals come back as { ok: false, message }.
  app.post("/api/sessions/reply", async (c) => {
    const parsed = await readJsonBody(c, sessionReplyBody);
    if (!parsed.ok) return parsed.response;
    const { source, ...input } = parsed.body;
    const result = await askMobileHarnessSession(input, {
      ask: askScoutQuestion,
      senderId: resolveOperatorName().trim() || "operator",
      fallbackCurrentDirectory: currentDirectory,
      source: source?.trim() || "scout-web",
    });
    return c.json(result);
  });

  app.post("/api/ask", async (c) => {
    const parsed = await readJsonBody(c, askBody);
    if (!parsed.ok) return parsed.response;
    const requestBody = parsed.body;
    const message = optionalString(requestBody.body)?.trim();
    if (!message) {
      return c.json({ error: "body is required" }, 400);
    }

    const explicitTargetAgentId = optionalString(requestBody.targetAgentId)?.trim();
    const explicitTargetLabel = optionalString(requestBody.targetLabel)?.trim();
    const routeConversationId =
      optionalString(requestBody.chatId)
      ?? optionalString(requestBody.cId)
      ?? optionalString(requestBody.conversationId);
    if (routeConversationId && !isOpaqueChannelId(routeConversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    if (routeConversationId && !explicitTargetAgentId && !querySessionById(routeConversationId)) {
      return c.json({ error: "chat not found" }, 404);
    }

    const routed = explicitTargetAgentId
      ? {
          directAgentId: explicitTargetAgentId,
          senderId: resolveOperatorName().trim() || "operator",
        }
      : resolveConversationAskRouting(
          routeConversationId,
        );
    const agent = routed.directAgentId ? queryAgentById(routed.directAgentId) : null;
    if (!routed.directAgentId) {
      return c.json(
        {
          error:
            "ask is only available in a direct conversation with one agent",
        },
        400,
      );
    }
    const executionHarness =
      coerceAgentHarness(requestBody.execution?.harness) ??
      coerceAgentHarness(agent?.harness);
    const executionModel =
      optionalString(requestBody.execution?.model)?.trim() ||
      agent?.model?.trim() ||
      undefined;
    const executionReasoningEffort = optionalString(requestBody.execution?.reasoningEffort)?.trim();
    const attachments = requestBody.attachments;
    const requestMetadata = recordInput(requestBody.metadata);
    const source = metadataStringValue(requestMetadata, "source") ?? "scout-web";

    const result = await askScoutQuestion({
      senderId: routed.senderId,
      targetLabel: explicitTargetLabel || routed.directAgentId,
      targetAgentId: routed.directAgentId,
      body: message,
      ...(executionHarness ? { executionHarness } : {}),
      ...(executionModel ? { executionModel } : {}),
      ...(executionReasoningEffort ? { executionReasoningEffort } : {}),
      ...(attachments?.length ? { attachments } : {}),
      source,
      ...(requestMetadata ? {
        messageMetadata: requestMetadata,
        invocationMetadata: requestMetadata,
      } : {}),
      currentDirectory,
    });

    if (!result.usedBroker) {
      return c.json({ error: "broker unreachable" }, 502);
    }
    if (result.unresolvedTarget) {
      return c.json(
        {
          error: `could not route ask to ${result.unresolvedTarget}`,
          targetDiagnostic: result.targetDiagnostic ?? null,
        },
        409,
      );
    }

    return c.json(result);
  });
}
