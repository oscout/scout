/**
 * Scout Chat — the client's whole view of the server.
 *
 * Every request the standalone chat surface makes goes through here, so the
 * HTTP contract in `docs/eng/chat-channel-invites-api.md` has exactly one
 * implementation to check. Nothing in this module invents data: an endpoint
 * that is not reachable produces a `ChatApiError` the surface renders as an
 * error state, never as an empty-but-fine screen.
 */

import { refreshSessionAuth } from "../../lib/api.ts";

import type {
  ChannelInvitePublicView,
  ChannelInviteReachability,
  ChannelReception,
  ConversationDefinition,
  MessageRecord,
} from "@openscout/protocol";

export interface ChatViewer {
  actorId: string;
  displayName: string;
  isOperator: boolean;
}

/** One space as the sidebar switcher renders it. Never inferred client-side. */
export interface ChatSpaceView {
  slug: string;
  title: string;
  conversationId: string | null;
  isDefault: boolean;
  channelCount: number;
}

export interface ChatBootstrap {
  viewer: ChatViewer;
  channels: ConversationDefinition[];
  /**
   * The space the server actually answered for. It is not always the one that
   * was asked for -- an absent selector resolves to the caller's own space --
   * so the surface adopts this rather than assuming its request stood.
   */
  space?: string;
  spaces?: ChatSpaceView[];
}

/**
 * One addressed ask and where its flight got to.
 *
 * `state` is rendered verbatim from the broker's flight lifecycle — the client
 * never re-labels a state it does not recognize, it shows it.
 */
export interface TrackedRequest {
  messageId: string;
  flightId: string;
  state: string;
  targetActorId: string;
}

export interface ChannelFeed {
  messages: MessageRecord[];
  requests: TrackedRequest[];
}

/** The activity plane, when the server knows of any. Never inferred here. */
export interface ChannelMemberActivity {
  status: string;
  updatedAt?: number;
}

/**
 * Reception as the roster serves it: the protocol reading plus the two facts
 * that come from the redemption rather than the endpoint. Session attachment
 * lives here, not at the top level — an agent merely running somewhere else is
 * not attached to this channel.
 */
export interface ChannelMemberReception extends ChannelReception {
  actorId?: string;
  attachedSessionId: string | null;
  redeemedAt: number | null;
}

export interface ChannelMemberView {
  actorId: string;
  kind: string;
  displayName: string;
  /**
   * Declared by the roster, never inferred here. `"api"` is a lightweight
   * member that joined over plain HTTP: it reads by polling and posts, and it
   * can never be invoked — `/asks` refuses it by name. `"session"` is every
   * other membership. Absent from servers that predate the field.
   */
  participation?: "api" | "session";
  owner?: { actorId: string; displayName: string };
  harness?: string;
  model?: string;
  projectRoot?: string;
  nodeId?: string;
  activity?: ChannelMemberActivity;
  reception: ChannelMemberReception;
}

export interface ChannelMembers {
  channelId: string;
  members: ChannelMemberView[];
}

export interface ChannelInviteList {
  invites: ChannelInvitePublicView[];
}

/**
 * The server's own reachability reading for one invitation route. Rendered
 * verbatim: `label` next to the link, `detail` as the honest sentence under it.
 */
export interface InviteReachabilityNote {
  reachability: ChannelInviteReachability;
  label: string;
  detail: string;
  /** True only when a teammate away from this network can use the link. */
  remoteUsable: boolean;
}

export interface CreatedChannelInvite {
  invite: ChannelInvitePublicView;
  /** The raw token. Returned exactly once, to the issuer. */
  token: string;
  inviteUrl: string;
  agentInstructionsUrl: string;
  reachability?: InviteReachabilityNote;
  serviceHost?: string;
}

export interface InvitePreview {
  channel: { id: string; title: string; topic?: string; memberCount: number };
  invite: ChannelInvitePublicView;
  reachability?: InviteReachabilityNote;
  /** Present when the server can name the inviter; the landing page omits the line otherwise. */
  inviter?: { actorId: string; displayName: string };
}

export interface InviteJoinResult {
  ok: true;
  actorId: string;
  displayName: string;
  conversationId: string;
  channelTitle: string;
  alreadyMember: boolean;
}

export interface ChannelMemberIdentity {
  actorId: string;
  displayName: string;
  channelIds: string[];
}

export interface InviteCreateInput {
  /**
   * `agent` invitations are single-use and bound to the issuing member. `api`
   * invitations are single-use too, but carry no invitee: the server mints the
   * participant's identity when it joins over `/participate`, and a retried
   * join with the same `participantKey` resumes the same participant instead of
   * consuming another use.
   */
  kind: "teammate" | "agent" | "api";
  createdByActorId: string;
  inviteeDisplayName?: string;
  inviteeActorId?: string;
  expiresInMs?: number | null;
}

export type { ChannelInviteReachability };

export class ChatApiError extends Error {
  readonly status: number;
  readonly reason: string | null;

  constructor(message: string, status: number, reason: string | null = null) {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
    this.reason = reason;
  }

  /** 401/403 mean "you are not a member of this", not "this is broken". */
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** A transport failure — the surface says "disconnected", not "empty". */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { body?: string },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      // Same-origin with credentials: the member cookie is the whole identity.
      credentials: "include",
      cache: "no-store",
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new ChatApiError(
      error instanceof Error ? error.message : "Network request failed",
      0,
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: unknown; reason?: unknown };
    const message = typeof record.error === "string" && record.error.trim()
      ? record.error
      : `${init?.method ?? "GET"} ${path} failed (${response.status})`;
    const reason = typeof record.reason === "string" ? record.reason : null;
    throw new ChatApiError(message, response.status, reason);
  }

  return (payload ?? {}) as T;
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

/**
 * The default space, whose URLs are bare.
 *
 * Writing it as an omitted parameter rather than as `?space=home` is what keeps
 * every request this client has ever made byte-identical for the channels that
 * predate spaces -- including the ones a member's credential was minted
 * against.
 */
export const DEFAULT_CHAT_SPACE = "home";

/**
 * Append the space selector to a path.
 *
 * A selector, not a credential: it says which room the request means. The
 * server refuses a channel that is not in the named space rather than filtering
 * it, so sending the wrong one fails loudly instead of quietly serving
 * something else.
 */
function withSpace(path: string, space: string | null | undefined): string {
  if (!space || space === DEFAULT_CHAT_SPACE) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}space=${encodeURIComponent(space)}`;
}

export const chatApi = {
  /** Recover the existing trusted local session before showing a sign-in gate. */
  async bootstrap(
    options: { recoverSession?: boolean; space?: string | null } = {},
  ): Promise<ChatBootstrap> {
    const path = withSpace("/api/chat/bootstrap", options.space);
    try {
      return await request<ChatBootstrap>(path);
    } catch (error) {
      // Only the identity read is retried. Invitations, permission denials,
      // and writes never trigger operator sign-in or an automatic replay.
      if (error instanceof ChatApiError && error.status === 401 && options.recoverSession !== false && await refreshSessionAuth()) {
        return request<ChatBootstrap>(path);
      }
      throw error;
    }
  },

  spaces(): Promise<{ spaces: ChatSpaceView[] }> {
    return request<{ spaces: ChatSpaceView[] }>("/api/chat/spaces");
  },

  /**
   * Create a space and its first channel in one call.
   *
   * One request, because a space with no room in it is a dead end the operator
   * has to notice and fix. The server names the channel `general` when none is
   * given.
   */
  createSpace(input: { title: string; channel?: string }): Promise<{
    space: ChatSpaceView;
    existed: boolean;
    channel: ConversationDefinition;
    channelExisted: boolean;
  }> {
    return request("/api/chat/spaces", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        ...(input.channel?.trim() ? { channel: input.channel.trim() } : {}),
      }),
    });
  },

  /**
   * Drop the browser session. The caller must suppress automatic recovery
   * until the viewer explicitly chooses to sign in again.
   */
  signOut(): Promise<{ ok?: boolean }> {
    return request<{ ok?: boolean }>("/api/logout", { method: "POST" });
  },

  createChannel(
    input: { title: string; topic?: string; space?: string | null },
  ): Promise<{ conversation: ConversationDefinition }> {
    return request<{ conversation: ConversationDefinition }>("/api/chat/channels", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        ...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
        // In the body rather than the URL: creating a channel names the space
        // it goes into, and that is an argument to the write, not a filter on
        // a read.
        ...(input.space ? { space: input.space } : {}),
      }),
    });
  },

  feed(channelId: string, space?: string | null): Promise<ChannelFeed> {
    return request<ChannelFeed>(withSpace(`/api/channels/${encodeId(channelId)}/feed`, space));
  },

  members(channelId: string, space?: string | null): Promise<ChannelMembers> {
    return request<ChannelMembers>(withSpace(`/api/channels/${encodeId(channelId)}/members`, space));
  },

  /**
   * A plain post. It invokes nobody — being in the room is not being asked.
   *
   * `requestId` is generated once per logical send and reused on retry, so an
   * uncertain failure cannot double-post.
   */
  postMessage(
    channelId: string,
    input: { requestId: string; body: string; replyToMessageId?: string; space?: string | null },
  ): Promise<{ message: MessageRecord }> {
    return request<{ message: MessageRecord }>(withSpace(`/api/channels/${encodeId(channelId)}/messages`, input.space), {
      method: "POST",
      body: JSON.stringify({
        requestId: input.requestId,
        body: input.body,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      }),
    });
  },

  /**
   * An addressed ask. `targetActorId` is an explicitly selected channel agent —
   * never a display name parsed out of the body.
   */
  postAsk(
    channelId: string,
    input: {
      requestId: string;
      body: string;
      targetActorId: string;
      replyToMessageId?: string;
      space?: string | null;
    },
  ): Promise<{ message: MessageRecord; request: TrackedRequest }> {
    return request<{ message: MessageRecord; request: TrackedRequest }>(
      withSpace(`/api/channels/${encodeId(channelId)}/asks`, input.space),
      {
        method: "POST",
        body: JSON.stringify({
          requestId: input.requestId,
          body: input.body,
          targetActorId: input.targetActorId,
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        }),
      },
    );
  },

  invites(channelId: string, space?: string | null): Promise<ChannelInviteList> {
    return request<ChannelInviteList>(withSpace(`/api/channels/${encodeId(channelId)}/invites`, space));
  },

  createInvite(
    channelId: string,
    input: InviteCreateInput & { space?: string | null },
  ): Promise<CreatedChannelInvite> {
    return request<CreatedChannelInvite>(withSpace(`/api/channels/${encodeId(channelId)}/invites`, input.space), {
      method: "POST",
      body: JSON.stringify({
        createdByActorId: input.createdByActorId,
        // An agent invitation is single-redemption and carries its issuer as
        // the invitee: that binding is what makes the agent "Maya's Codex"
        // rather than a free-floating participant. A no-install invitation is
        // single-redemption without the binding — the server owns the identity.
        maxRedemptions: input.kind === "teammate" ? null : 1,
        ...(input.inviteeDisplayName
          ? {
              invitee: {
                displayName: input.inviteeDisplayName,
                ...(input.inviteeActorId ? { actorId: input.inviteeActorId } : {}),
              },
            }
          : {}),
        ...(input.expiresInMs === undefined ? {} : { expiresInMs: input.expiresInMs }),
      }),
    });
  },

  revokeInvite(
    channelId: string,
    inviteId: string,
    revokedByActorId: string,
    space?: string | null,
  ): Promise<{ ok: true; invite: ChannelInvitePublicView }> {
    return request<{ ok: true; invite: ChannelInvitePublicView }>(
      withSpace(
        `/api/channels/${encodeId(channelId)}/invites/${encodeId(inviteId)}/revoke`,
        space,
      ),
      { method: "POST", body: JSON.stringify({ revokedByActorId }) },
    );
  },

  /** A pure read: opening an invitation link must never join a channel. */
  invitePreview(token: string): Promise<InvitePreview> {
    return request<InvitePreview>(`/api/invites/${encodeId(token)}`);
  },

  joinInvite(token: string, displayName: string): Promise<InviteJoinResult> {
    return request<InviteJoinResult>(`/api/invites/${encodeId(token)}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName }),
    });
  },

  me(): Promise<{ member: ChannelMemberIdentity | null }> {
    return request<{ member: ChannelMemberIdentity | null }>("/api/member/me");
  },
};

export type ChatApi = typeof chatApi;
