import type { Hono } from "hono";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import {
  isOpaqueChannelId,
  machineLabel,
  type ConversationDefinition,
  type ConversationKind,
} from "@openscout/protocol";
import {
  queryAgentById,
  queryConversationDefinitionById,
  querySessions,
  querySessionById,
} from "../db-queries.ts";
import {
  loadScoutBrokerContext,
  loadScoutReadCursors,
  markScoutConversationRead,
  renameScoutConversation,
  openScoutDirectSession,
  readScoutBrokerHealth,
  readScoutConversationProjection,
  resolveScoutBrokerUrl,
  upsertScoutConversation,
} from "../core/broker/service.ts";
import { getScoutConversations, provisionalScoutConversations } from "../core/conversations/service.ts";
import { loadMachines } from "../core/machines/service.ts";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import { resolveExplorablePath } from "../local-paths.ts";
import { optionalString } from "../request-values.ts";
import { conversationDefinitionFromDb, requireAnchorMessageInConversation } from "../conversation-records.ts";
import { conversationMemberBody, conversationReadCursorBody } from "../../shared/api/conversations.ts";
import { readJsonBody } from "../request-body.ts";

function parseConversationKinds(value: string | undefined): ConversationKind[] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind): kind is ConversationKind => (
      kind === "direct"
      || kind === "channel"
      || kind === "group_direct"
      || kind === "thread"
      || kind === "system"
    ));
}

function anchoredThreadNaturalKey(parentConversationId: string, anchorMessageId: string): string {
  return `thread:${encodeURIComponent(parentConversationId)}:${encodeURIComponent(anchorMessageId)}`;
}

function deterministicThreadConversationId(parentConversationId: string, anchorMessageId: string): string {
  const digest = createHash("sha256")
    .update(`${parentConversationId}\u0000${anchorMessageId}`)
    .digest("hex")
    .slice(0, 32);
  return `chn-${digest}`;
}

function findAnchoredChildConversation(
  conversations: Record<string, ConversationDefinition>,
  parentConversationId: string,
  anchorMessageId: string,
): ConversationDefinition | null {
  return Object.values(conversations).find((conversation) =>
    conversation.parentConversationId === parentConversationId
    && conversation.messageId === anchorMessageId
  ) ?? null;
}

async function createAnchoredThreadConversation(input: {
  parentConversationId: string;
  anchorMessageId: string;
  title?: string | null;
}): Promise<{ conversation: ConversationDefinition; existed: boolean }> {
  const broker = await loadScoutBrokerContext();
  if (!broker) {
    throw new Error("broker unreachable");
  }

  const parentRow = queryConversationDefinitionById(input.parentConversationId);
  const parent = parentRow
    ? conversationDefinitionFromDb(parentRow)
    : broker.snapshot.conversations[input.parentConversationId] ?? null;
  if (!parent) {
    throw new Error(`Conversation ${input.parentConversationId} is not available.`);
  }
  if (parent.parentConversationId) {
    throw new Error("Nested threads are not supported.");
  }
  requireAnchorMessageInConversation(broker, input.parentConversationId, input.anchorMessageId);

  const existing = findAnchoredChildConversation(
    broker.snapshot.conversations,
    input.parentConversationId,
    input.anchorMessageId,
  );
  if (existing) {
    return { conversation: existing, existed: true };
  }

  const naturalKey = anchoredThreadNaturalKey(input.parentConversationId, input.anchorMessageId);
  const deterministicId = deterministicThreadConversationId(input.parentConversationId, input.anchorMessageId);
  const deterministicExisting = broker.snapshot.conversations[deterministicId];
  if (deterministicExisting) {
    return { conversation: deterministicExisting, existed: true };
  }

  const title = input.title?.trim()
    || `Thread · ${parent.title}`;
  const conversation: ConversationDefinition = {
    id: deterministicId,
    kind: "thread",
    title,
    visibility: parent.visibility,
    shareMode: parent.shareMode,
    authorityNodeId: parent.authorityNodeId,
    participantIds: [...parent.participantIds],
    parentConversationId: input.parentConversationId,
    messageId: input.anchorMessageId,
    metadata: {
      naturalKey,
      source: "scout-web",
      parentConversationId: input.parentConversationId,
      anchorMessageId: input.anchorMessageId,
    },
  };
  await upsertScoutConversation(conversation);
  return { conversation, existed: false };
}

function conversationKindAfterMemberMutation(
  kind: ConversationDefinition["kind"],
  participantIds: string[],
): ConversationDefinition["kind"] {
  if (kind === "direct" && participantIds.length > 2) {
    return "group_direct";
  }
  if (kind === "group_direct" && participantIds.length <= 2) {
    return "direct";
  }
  return kind;
}

export type ConversationRouteDeps = {
  currentDirectory: string;
};

export function mountConversationRoutes(app: Hono, deps: ConversationRouteDeps) {
  const { currentDirectory } = deps;

  // ── Host labels on conversation rows (design/studio Scout Chat · Hosts) ──
  // A conversation already carries `authorityNodeId`; the *machine* label for
  // that node lives in the broker's machine inventory. Native Chat groups its
  // sidebar by host, so the row needs the operator-facing name, not the node
  // name. The inventory is a broker round trip, so it is cached and refreshed
  // out of band: a list read never waits on it, and a cold first read simply
  // ships rows without `hostLabel` (both the web and native decoders treat it
  // as optional) until the next poll.
  const MACHINE_LABEL_TTL_MS = 60_000;
  let machineLabelsByNode = new Map<string, string>();
  let machineLabelsReadAt = 0;
  let machineLabelRefresh: Promise<void> | null = null;
  const refreshMachineLabels = () => {
    if (machineLabelRefresh) return machineLabelRefresh;
    machineLabelRefresh = (async () => {
      try {
        const { machines } = await loadMachines();
        const next = new Map<string, string>();
        for (const machine of machines) {
          if (machine.scoutNodeId) next.set(machine.scoutNodeId, machineLabel(machine));
        }
        machineLabelsByNode = next;
        machineLabelsReadAt = Date.now();
      } catch {
        // No inventory is a normal state (broker restarting, mesh off). Keep
        // the last map and retry on the next read rather than clearing labels.
        machineLabelsReadAt = Date.now();
      } finally {
        machineLabelRefresh = null;
      }
    })();
    return machineLabelRefresh;
  };
  const withHostLabels = <T>(items: T[]): T[] => {
    if (Date.now() - machineLabelsReadAt > MACHINE_LABEL_TTL_MS) void refreshMachineLabels();
    if (machineLabelsByNode.size === 0) return items;
    return items.map((item) => {
      // Rows reach this list from two projections; only one of them carries an
      // authority node, and a row without one keeps exactly the shape it had.
      const nodeId = (item as { authorityNodeId?: string | null }).authorityNodeId;
      const label = nodeId ? machineLabelsByNode.get(nodeId) : undefined;
      return label ? ({ ...item, hostLabel: label } as T) : item;
    });
  };

  const readCommsList = async (
    c: Context,
    options: { preferMaterialized?: boolean } = {},
  ) => {
    const rawLimit = Number(c.req.query("limit"));
    const rawKinds = c.req.query("kinds")?.trim();
    const filters = {
      query: c.req.query("query") || undefined,
      limit: Number.isFinite(rawLimit) ? Math.min(250, Math.max(1, Math.floor(rawLimit))) : undefined,
      kinds: parseConversationKinds(rawKinds),
      machineId: c.req.query("machineId") || undefined,
    };
    // `/api/comms` is a bounded list/enrichment read. Keep it on the durable,
    // indexed projection even after rich broker state has warmed; selected
    // conversations load their complete detail through `/api/session/:id`.
    const preferredProjection = options.preferMaterialized && !filters.machineId
      ? await readScoutConversationProjection(160)
      : undefined;
    if (preferredProjection?.items.some((item) => item.entityKind === "scout_conversation")) {
      return {
        items: provisionalScoutConversations(preferredProjection, filters),
        listReady: true,
      };
    }

    const broker = await loadScoutBrokerContext(
      undefined,
      filters.machineId
        ? {}
        : {
            scope: "conversations",
            waitForInitial: false,
            initialRefreshDelayMs: 750,
          },
    ).catch(() => null);
    if (broker) {
      // A concrete broker snapshot makes an empty result authoritative for this
      // request. Search/machine/kind filters, hidden system records, and bounded
      // history can all legitimately produce zero visible rows even when the
      // canonical store itself is nonempty.
      const items = await getScoutConversations(filters, broker);
      return { items, listReady: true };
    }

    if (!filters.machineId) {
      // The broker owns the records, while its SQLite projection gives the web
      // process a durable, already-indexed cold-start view. A non-empty
      // projection is safe to paint immediately.
      const launchProjection = preferredProjection === undefined
        ? await readScoutConversationProjection(Math.min(160, filters.limit ?? 160))
        : preferredProjection;
      // The shared projection also contains observed harness sessions. Those
      // rows are intentionally not web chats, so an observed-only top page is
      // not evidence that this endpoint has a usable Scout list (a busy fleet
      // can push older Scout rows below the shared 160-row launch window).
      if (launchProjection?.items.some((item) => item.entityKind === "scout_conversation")) {
        return {
          items: provisionalScoutConversations(launchProjection, filters),
          listReady: true,
        };
      }

      // Compatibility fallback for a broker that has not produced the shared
      // SCO-102 projection yet. This path is intentionally secondary: it has
      // less complete semantics and is retired once the shared view is proven.
      const projected = querySessions(250);
      if (projected.length > 0) {
        const query = filters.query?.trim().toLocaleLowerCase() ?? "";
        const kinds = filters.kinds ? new Set<string>(filters.kinds) : null;
        const items = projected
          .filter((item) => !kinds || kinds.has(item.kind))
          .filter((item) => !query || [
            item.title,
            item.alias,
            item.agentName,
            item.preview,
          ].some((value) => value?.toLocaleLowerCase().includes(query)))
          .slice(0, filters.limit ?? projected.length);
        return { items, listReady: true };
      }
    }

    // With no readable broker context, an empty array is not a valid recovery
    // fallback. Only expose a genuinely empty store after broker startup and
    // canonical counts independently agree. SQLite is not a prerequisite: the
    // conversation source is the broker registry, and its projection may be
    // intentionally disabled.
    const health = await readScoutBrokerHealth(resolveScoutBrokerUrl(), {
      signal: AbortSignal.timeout(2_000),
    });
    const listReady = health.reachable
      && health.ok
      && health.startup?.state === "ready"
      && health.startup.mutationsAdmitted === true
      && health.counts?.conversations === 0
      && health.counts.messages === 0;
    return { items: [], listReady };
  };

  const unavailableConversationList = (c: Context) => c.json({
    error: "conversation_list_restoring",
    detail: "Scout has not confirmed an empty conversation store. Existing conversations are still restoring.",
    retryable: true,
  }, 503);

  app.get("/api/comms", async (c) => {
    const { items, listReady } = await readCommsList(c, { preferMaterialized: true });
    if (!listReady) {
      return unavailableConversationList(c);
    }
    return c.json(withHostLabels<(typeof items)[number]>(items).map((item) => ({
      ...item,
      chatId: item.id,
      cId: item.id,
    })));
  });

  app.get("/api/conversations", async (c) => {
    const { items, listReady } = await readCommsList(c);
    return listReady
      ? c.json(withHostLabels<(typeof items)[number]>(items))
      : unavailableConversationList(c);
  });

  app.post("/api/conversations/direct", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      agentId?: unknown;
      targetAgentId?: unknown;
      targetLabel?: unknown;
      projectPath?: unknown;
      cwd?: unknown;
    };
    const agentId =
      optionalString(body.agentId)?.trim()
      ?? optionalString(body.targetAgentId)?.trim();
    if (!agentId) {
      return c.json({ error: "agentId is required" }, 400);
    }

    try {
      const agent = queryAgentById(agentId);
      const rawProjectPath =
        optionalString(body.projectPath)?.trim()
        ?? optionalString(body.cwd)?.trim()
        ?? agent?.projectRoot?.trim()
        ?? agent?.cwd?.trim();
      const agentDirectory = rawProjectPath
        ? resolveExplorablePath(rawProjectPath, null, currentDirectory)
        : currentDirectory;
      const result = await openScoutDirectSession({
        agentId,
        currentDirectory: agentDirectory,
        operatorName: resolveOperatorName().trim() || undefined,
        targetName: optionalString(body.targetLabel)?.trim(),
      });
      const conversationId = result.conversation.id;
      return c.json({
        ok: true,
        id: conversationId,
        chatId: conversationId,
        cId: conversationId,
        conversationId,
        agentId: result.agent?.id ?? agentId,
        existed: result.existed,
        session: querySessionById(conversationId),
        conversation: result.conversation,
      });
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        502,
      );
    }
  });

  app.post("/api/conversations/:id/threads", async (c) => {
    const parentConversationId = c.req.param("id");
    if (!isOpaqueChannelId(parentConversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      messageId?: unknown;
      anchorMessageId?: unknown;
      title?: unknown;
    };
    const anchorMessageId =
      optionalString(body.messageId)?.trim()
      ?? optionalString(body.anchorMessageId)?.trim();
    if (!anchorMessageId) {
      return c.json({ error: "messageId is required" }, 400);
    }

    try {
      const result = await createAnchoredThreadConversation({
        parentConversationId,
        anchorMessageId,
        title: optionalString(body.title),
      });
      const conversationId = result.conversation.id;
      return c.json({
        ok: true,
        id: conversationId,
        chatId: conversationId,
        cId: conversationId,
        conversationId,
        parentConversationId,
        anchorMessageId,
        existed: result.existed,
        conversation: result.conversation,
        session: querySessionById(conversationId),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = /not supported|not in conversation|not available|required/i.test(message) ? 400 : 502;
      return c.json({ error: message }, status as 400 | 502);
    }
  });

  app.get("/api/conversations/:id/read-cursors", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    try {
      return c.json(await loadScoutReadCursors({
        conversationId,
      }));
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        502,
      );
    }
  });

  app.post("/api/conversations/:id/read-cursor", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const parsed = await readJsonBody(c, conversationReadCursorBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    try {
      return c.json(await markScoutConversationRead({
        conversationId,
        actorId: body.actorId?.trim() || "operator",
        lastReadMessageId: body.lastReadMessageId,
        lastReadSeq: body.lastReadSeq,
        lastReadAt: body.lastReadAt,
        metadata: {
          source: "scout-web",
          ...(body.metadata ?? {}),
        },
      }));
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        502,
      );
    }
  });

  app.post("/api/conversations/:id/title", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    try {
      return c.json(await renameScoutConversation({
        conversationId,
        title: typeof body.title === "string" ? body.title : "",
      }));
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        502,
      );
    }
  });

  const writeConversationMembers = async (
    conversationId: string,
    mutate: (current: string[]) => string[],
  ) => {
    const currentSession = querySessionById(conversationId);
    const canonicalConversationId = currentSession?.id ?? conversationId;
    const existing = queryConversationDefinitionById(canonicalConversationId);
    if (!existing) return null;
    const nextParticipants = mutate(existing.participantIds);
    const nextKind = conversationKindAfterMemberMutation(
      existing.kind as ConversationDefinition["kind"],
      nextParticipants,
    );
    await upsertScoutConversation({
      id: existing.id,
      kind: nextKind,
      title: existing.title,
      visibility: existing.visibility as ConversationDefinition["visibility"],
      shareMode: existing.shareMode as ConversationDefinition["shareMode"],
      authorityNodeId: existing.authorityNodeId,
      participantIds: nextParticipants,
      ...(existing.topic ? { topic: existing.topic } : {}),
      ...(existing.parentConversationId
        ? { parentConversationId: existing.parentConversationId }
        : {}),
      ...(existing.messageId ? { messageId: existing.messageId } : {}),
      ...(existing.metadata ? { metadata: existing.metadata } : {}),
    });
    return {
      kind: nextKind,
      participantIds: nextParticipants,
      session: querySessionById(existing.id),
    };
  };

  app.post("/api/conversations/:id/members", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const parsed = await readJsonBody(c, conversationMemberBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const actorId = body.actorId?.trim();
    if (!actorId) return c.json({ error: "actorId is required" }, 400);
    const next = await writeConversationMembers(conversationId, (current) =>
      Array.from(new Set([...current, actorId])).sort(),
    );
    if (!next) return c.json({ error: "conversation not found" }, 404);
    return c.json({ ok: true, ...next });
  });

  app.delete("/api/conversations/:id/members/:actorId", async (c) => {
    const conversationId = c.req.param("id");
    if (!isOpaqueChannelId(conversationId)) {
      return c.json({ error: "chatId must be an opaque chat id" }, 400);
    }
    const actorId = c.req.param("actorId");
    const next = await writeConversationMembers(conversationId, (current) =>
      current.filter((id) => id !== actorId),
    );
    if (!next) return c.json({ error: "conversation not found" }, 404);
    return c.json({ ok: true, ...next });
  });
}
