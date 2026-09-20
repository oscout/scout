/**
 * Hosted Scout Chat — the Cloudflare Worker, seen through the shared contract.
 *
 * This file is the *entire* difference between hosted Chat and local Chat. The
 * components, the model, the interactions and the stylesheet in
 * `screens/chat-space/` are the same code in both; what changes is which HTTP
 * calls stand behind `ChatApi`, and which of them exist at all.
 *
 * Three things the hosted Worker does differently, and how each is absorbed:
 *
 *  - **Owner sessions are GitHub OAuth with CSRF.** Identity comes from
 *    `GET /api/auth/session`, which also hands out the CSRF token every mutation
 *    must echo. A 403 `csrf_denied` means the session rotated: the token is
 *    re-read once and the write replayed, and a second refusal is surfaced.
 *  - **Spaces are addressed by id, shared by slug.** The directory knows both;
 *    the shared surface only ever speaks slugs, so this adapter keeps the map
 *    and translates on every call.
 *  - **It answers less.** No `/asks`, no invitation listing, no invitation
 *    preview, no member detail. Those are declared `false` in
 *    `HOSTED_CHAT_CAPABILITIES` so the surface never draws the control, and the
 *    methods behind them throw a named error rather than returning a
 *    plausible-looking empty result.
 */

import {
  ChatApiError,
  type ChannelFeed,
  type ChannelInviteList,
  type ChannelMemberIdentity,
  type ChannelMembers,
  type ChannelMemberView,
  type ChatApi,
  type ChatBootstrap,
  type ChatCapabilities,
  type ChatMessage,
  type ChatSpaceView,
  type CreatedChannelInvite,
  type InviteCreateInput,
  type InviteJoinResult,
  type InvitePreview,
  type TrackedRequest,
} from "../screens/chat-space/chat-api.ts";

import type {
  ChannelInvitePublicView,
  ConversationDefinition,
} from "@openscout/protocol";

/** What the hosted Worker can actually do, as of `apps/hosted-chat/src`. */
export const HOSTED_CHAT_CAPABILITIES: ChatCapabilities = {
  // No `/asks` endpoint and no flight lifecycle: `feed` returns `requests: []`
  // by construction. An ask picker here would address nothing.
  asks: false,
  // The Worker mints invitations and redeems them; it never enumerates them.
  inviteList: false,
  // Revocation takes the raw token, which is shown exactly once at creation, so
  // there is no invitation on screen to revoke from.
  inviteRevoke: false,
  // The only redemption path is `POST /api/invites/:token/participate`, which
  // mints an API participant. A teammate or session-agent invitation would have
  // nothing to redeem it.
  inviteKinds: ["api"],
  // The Worker serves no `/api/channels/:id/events`; the surface polls and
  // does not dial a stream that is not there.
  liveStream: false,
  signOut: true,
  spaceCreate: true,
  channelCreate: true,
  // `POST /api/chat/spaces/:id/delete`, which the directory retries through a
  // durable alarm until the space's storage is actually gone.
  spaceDelete: true,
  // `POST /api/chat/spaces` always creates a channel named "general".
  namedFirstChannel: false,
  // The roster is {actorId, displayName, expiresAt, revoked} and nothing more.
  memberDetail: false,
  reactions: false,
  attachments: true,
  signIn: {
    startPath: "/auth/github/start",
    returnToParam: "return_to",
    label: "Continue with GitHub",
    prompt: "Sign in to open your spaces and invite an agent into one.",
    note: "Scout Chat reads your GitHub account id, name and verified email to identify you.",
  },
};

interface HostedSession {
  authenticated: boolean;
  account?: { id: string; displayName: string };
  csrfToken?: string;
}

interface HostedSpace {
  id: string;
  title: string;
  slug: string;
}

interface HostedChannel {
  id: string;
  title: string;
}

interface HostedMessage {
  id: string;
  channelId: string;
  actorId: string;
  actorName?: string;
  body: string;
  createdAt: number;
  replyToMessageId: string | null;
  class?: string;
  attachments?: ChatMessage["attachments"];
}

/**
 * A capability the hosted Worker does not have. Never a silent empty result.
 *
 * Its callers are declared `async` so the refusal arrives as a rejection: a
 * method typed `Promise<T>` that throws synchronously is a trap for any caller
 * that holds the promise before awaiting it.
 */
function unsupported(what: string): never {
  throw new ChatApiError(
    `Hosted Scout Chat does not support ${what}.`,
    501,
    "capability_unsupported",
  );
}

/**
 * One hosted channel as a `ConversationDefinition`.
 *
 * The Worker sends an id and a title, which is what the surface renders. The
 * remaining fields are required by the protocol shape and are filled with what
 * is true of a hosted channel — it is private, it is shared by invitation, and
 * its own space is the authority that accepts redemptions for it. None of them
 * is read by anything in `screens/chat-space/`.
 */
function toConversation(channel: HostedChannel, spaceId: string): ConversationDefinition {
  return {
    id: channel.id,
    kind: "channel",
    title: channel.title,
    visibility: "private",
    shareMode: "local",
    authorityNodeId: spaceId,
    participantIds: [],
  };
}

function toMessage(message: HostedMessage): ChatMessage {
  return {
    id: message.id,
    actorId: message.actorId,
    body: message.body,
    // The Worker stamps every message `agent`; rendered verbatim rather than
    // re-classified here.
    class: (message.class ?? "agent") as ChatMessage["class"],
    createdAt: message.createdAt,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
  };
}

/**
 * One hosted member, as much as the Worker reports of one.
 *
 * `participation: "api"` is a fact, not a fallback: every hosted member joined
 * through `/participate` and holds a bearer credential it polls with. Saying so
 * is what makes the shared surface correctly refuse to offer it as an ask
 * target, and label it "via API — post to reach it" in the mention list.
 *
 * `reception` is the one required field the Worker sends no evidence for, so it
 * is filled with the reading that *is* true of an HTTP participant — a poller,
 * not a listener — and its `detail` says exactly that rather than implying a
 * route the hosted service does not have.
 */
function toMember(member: {
  actorId: string;
  displayName: string;
  expiresAt?: number;
}): ChannelMemberView {
  return {
    actorId: member.actorId,
    kind: "agent",
    displayName: member.displayName,
    participation: "api",
    reception: {
      state: "unavailable",
      routeKind: "none",
      listening: false,
      summary: "Polls",
      detail:
        "This participant joined over HTTP and reads the channel by polling. Hosted Chat cannot wake it; it sees a message on its next poll.",
      evidenceAt: null,
      attachedSessionId: null,
      redeemedAt: null,
    },
  };
}

export function createHostedChatApi(): ChatApi {
  /** Slug → hosted space id. Repopulated on every spaces read. */
  const spaceIds = new Map<string, string>();
  let csrfToken: string | null = null;

  async function raw<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
        headers: { accept: "application/json", ...(init?.headers ?? {}) },
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
      const reason = typeof record.reason === "string"
        ? record.reason
        : typeof record.error === "string"
          ? record.error
          : null;
      throw new ChatApiError(
        hostedMessageFor(reason) ?? `${init?.method ?? "GET"} ${path} failed (${response.status})`,
        response.status,
        reason,
      );
    }
    return (payload ?? {}) as T;
  }

  async function session(force = false): Promise<HostedSession> {
    const found = await raw<HostedSession>("/api/auth/session");
    if (found.authenticated && found.csrfToken) csrfToken = found.csrfToken;
    else if (force || !found.authenticated) csrfToken = null;
    return found;
  }

  /**
   * A write. Hosted mutations carry the CSRF token and a JSON content type, and
   * the Worker refuses anything else before it looks at the body.
   */
  async function write<T>(path: string, body: unknown): Promise<T> {
    if (!csrfToken) {
      const found = await session();
      if (!found.authenticated) {
        throw new ChatApiError("Sign in to continue.", 401, "owner_sign_in_required");
      }
    }
    const send = () =>
      raw<T>(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken ?? "",
        },
        body: JSON.stringify(body ?? {}),
      });
    try {
      return await send();
    } catch (error) {
      // A rotated session is recoverable exactly once, and only for CSRF. A
      // permission refusal is never retried.
      if (error instanceof ChatApiError && error.reason === "csrf_denied") {
        const found = await session(true);
        if (found.authenticated && csrfToken) return await send();
      }
      throw error;
    }
  }

  /**
   * The shared surface speaks slugs; the Worker's endpoints take space ids.
   *
   * Only the map answers. A selector that is neither a known slug nor already a
   * space id fails here rather than being sent on as a guess — the Worker would
   * refuse it anyway, and failing locally says which half is wrong.
   */
  function spaceId(slug: string | null | undefined): string {
    const known = slug ? spaceIds.get(slug) : undefined;
    if (known) return known;
    if (slug && /^[a-f0-9]{32}$/.test(slug)) return slug;
    throw new ChatApiError("That space is not one of yours.", 404, "space_not_found");
  }

  async function listSpaces(): Promise<HostedSpace[]> {
    const { spaces } = await raw<{ spaces: HostedSpace[] }>("/api/chat/spaces");
    spaceIds.clear();
    for (const space of spaces) spaceIds.set(space.slug, space.id);
    return spaces;
  }

  const toSpaceView = (space: HostedSpace, channelCount?: number): ChatSpaceView => ({
    slug: space.slug,
    title: space.title,
    conversationId: null,
    // Hosted Chat has no default space: an account's first space is simply its
    // first, and calling it "default" would claim a fallback that does not exist.
    isDefault: false,
    ...(channelCount === undefined ? {} : { channelCount }),
  });

  return {
    async bootstrap(options = {}): Promise<ChatBootstrap> {
      const found = await session();
      if (!found.authenticated || !found.account) {
        throw new ChatApiError(
          "Sign in to open your spaces.",
          401,
          "owner_sign_in_required",
        );
      }
      const viewer = {
        actorId: found.account.id,
        displayName: found.account.displayName,
        // The signed-in GitHub account owns every space it can see here, so it
        // is this deployment's host: it may create spaces and channels.
        isOperator: true,
      };
      const spaces = await listSpaces();
      if (spaces.length === 0) {
        return { viewer, channels: [], spaces: [] };
      }
      const asked = options.space ?? null;
      const selected = spaces.find((space) => space.slug === asked)
        ?? spaces.find((space) => space.id === asked)
        ?? spaces[0]!;
      const detail = await raw<{ channels: HostedChannel[] }>(
        `/api/chat/spaces/${encodeURIComponent(selected.id)}`,
      );
      const channels = (detail.channels ?? []).map((channel) =>
        toConversation(channel, selected.id));
      return {
        viewer,
        channels,
        space: selected.slug,
        spaces: spaces.map((space) =>
          toSpaceView(space, space.id === selected.id ? channels.length : undefined)),
      };
    },

    async spaces(): Promise<{ spaces: ChatSpaceView[] }> {
      return { spaces: (await listSpaces()).map((space) => toSpaceView(space)) };
    },

    async createSpace(input) {
      // The Worker derives the slug from `requestId`, and a retry with the same
      // id resumes the same reservation instead of making a second space.
      const requestId = crypto.randomUUID();
      const created = await write<{ space: HostedSpace; existed: boolean }>(
        "/api/chat/spaces",
        { requestId, title: input.title },
      );
      spaceIds.set(created.space.slug, created.space.id);
      const detail = await raw<{ channels: HostedChannel[] }>(
        `/api/chat/spaces/${encodeURIComponent(created.space.id)}`,
      );
      // The Worker creates "general" with the space and names it itself; the
      // surface does not offer a first-channel field here (`namedFirstChannel`).
      const first = detail.channels?.[0];
      if (!first) {
        throw new ChatApiError(
          "That space was created without a channel.",
          502,
          "space_channel_missing",
        );
      }
      return {
        space: toSpaceView(created.space, detail.channels.length),
        existed: created.existed,
        channel: toConversation(first, created.space.id),
        channelExisted: created.existed,
      };
    },

    signOut(): Promise<{ ok?: boolean }> {
      return write<{ ok?: boolean }>("/auth/logout", {});
    },

    async createChannel(input) {
      const id = spaceId(input.space);
      const created = await write<{ conversation: HostedChannel; existed: boolean }>(
        `/api/chat/spaces/${encodeURIComponent(id)}/channels`,
        { title: input.title },
      );
      return { conversation: toConversation(created.conversation, id) };
    },

    async feed(channelId, space): Promise<ChannelFeed> {
      const id = spaceId(space);
      const found = await raw<{ messages: HostedMessage[] }>(
        `/api/channels/${encodeURIComponent(channelId)}/feed?space=${encodeURIComponent(id)}`,
      );
      // `requests` is empty because the Worker has no asks, not because none are
      // outstanding — and the surface does not draw request state here at all.
      return { messages: (found.messages ?? []).map(toMessage), requests: [] };
    },

    async members(channelId, space): Promise<ChannelMembers> {
      const id = spaceId(space);
      const found = await raw<{
        members: { actorId: string; displayName: string; expiresAt: number; revoked: number }[];
      }>(`/api/channels/${encodeURIComponent(channelId)}/members?space=${encodeURIComponent(id)}`);
      return {
        channelId,
        members: (found.members ?? [])
          // A revoked membership is not a member with a flag on it; it is
          // somebody who is no longer in the room.
          .filter((member) => !member.revoked)
          .map(toMember),
      };
    },

    async postMessage(channelId, input): Promise<{ message: ChatMessage }> {
      const id = spaceId(input.space);
      const posted = await write<{ message: HostedMessage }>(
        `/api/channels/${encodeURIComponent(channelId)}/messages?space=${encodeURIComponent(id)}`,
        {
          requestId: input.requestId,
          body: input.body,
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.attachments && input.attachments.length > 0
            ? { attachments: input.attachments.map((attachment) => ({ id: attachment.id })) }
            : {}),
        },
      );
      return { message: toMessage(posted.message) };
    },

    async uploadAttachments(channelId: string, files: File[], space?: string | null) {
      const id = spaceId(space);
      const { resolvedUploadMediaType } = await import("../lib/media-blobs.ts");
      const attachments = [];
      for (const file of files) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = typeof reader.result === "string" ? reader.result : "";
            const comma = result.indexOf(",");
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
          };
          reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
          reader.readAsDataURL(file);
        });
        const posted = await write<{ attachment: { id: string; mediaType: string; fileName?: string; url: string } }>(
          `/api/channels/${encodeURIComponent(channelId)}/blobs?space=${encodeURIComponent(id)}`,
          {
            requestId: crypto.randomUUID(),
            mediaType: resolvedUploadMediaType(file),
            fileName: file.name,
            data,
          },
        );
        attachments.push(posted.attachment);
      }
      return attachments;
    },

    async postAsk(): Promise<{ message: ChatMessage; request: TrackedRequest }> {
      return unsupported("addressed asks");
    },

    async cancelAsk(): Promise<{ ok: true; replayed: boolean; request: TrackedRequest }> {
      return unsupported("cancelling an ask");
    },

    async addReaction(): Promise<{ ok: true; replayed: boolean }> {
      return unsupported("message reactions");
    },

    async removeReaction(): Promise<{ ok: true; replayed: boolean }> {
      return unsupported("message reactions");
    },

    async invites(): Promise<ChannelInviteList> {
      return unsupported("listing a channel's invitations");
    },

    async createInvite(
      channelId: string,
      input: InviteCreateInput & { space?: string | null },
    ): Promise<CreatedChannelInvite> {
      const id = spaceId(input.space);
      const created = await write<{
        token: string;
        inviteUrl: string;
        expiresAt: number;
        maxRedemptions: number;
        conversationId: string;
      }>(
        `/api/channels/${encodeURIComponent(channelId)}/invites?space=${encodeURIComponent(id)}`,
        { maxRedemptions: 1 },
      );
      // The Worker keeps no public invitation record — it mints a token and
      // forgets everything but its hash — so this view is assembled from the
      // creation response and what is true by construction: freshly created,
      // unredeemed, single-use, and owned by the member who asked for it.
      const invite: ChannelInvitePublicView = {
        // No server-side invitation id exists. The token's own routing prefix
        // is the only stable handle, and it is never used to redeem anything.
        id: created.token.slice(0, 35),
        channelId,
        createdByActorId: input.createdByActorId,
        scope: "channel_participation",
        state: "active",
        tokenHint: created.token.slice(-6),
        createdAt: Date.now(),
        expiresAt: created.expiresAt,
        maxRedemptions: created.maxRedemptions,
        redemptionCount: 0,
        route: {
          authorityNodeId: spaceId(input.space),
          host: window.location.host,
          baseUrl: window.location.origin,
          // The Worker sends no reachability evidence of its own, so the route
          // claims none. The note below carries the reading that *is* evidenced.
          reachability: "unknown",
        },
        redemptions: [],
      };
      const publicOrigin = window.location.protocol === "https:";
      return {
        invite,
        token: created.token,
        inviteUrl: created.inviteUrl,
        // Served by the Worker at this exact path; see `apps/hosted-chat/src/index.ts`.
        agentInstructionsUrl: `${created.inviteUrl}/agent.md`,
        // Derived from the origin this page is being read from, which is the
        // origin the link points at — not a guess about the network beyond it.
        reachability: {
          reachability: "unknown",
          label: publicOrigin ? "Hosted link" : "Local only",
          detail: publicOrigin
            ? `This link is on ${window.location.host}, the same address you are reading this page from. Anyone you send it to can open it.`
            : `This deployment is running on ${window.location.host} over plain HTTP, so the link only works on this machine.`,
          remoteUsable: publicOrigin,
        },
        serviceHost: window.location.host,
      };
    },

    async revokeInvite(): Promise<{ ok: true; invite: ChannelInvitePublicView }> {
      // The Worker revokes by raw token, which is shown once and not retained.
      return unsupported("revoking an invitation from this screen");
    },

    async deleteSpace(slug: string): Promise<{ deleted: true }> {
      const id = spaceId(slug);
      await write<{ deleted: true }>(
        `/api/chat/spaces/${encodeURIComponent(id)}/delete`,
        {},
      );
      spaceIds.delete(slug);
      return { deleted: true };
    },

    async invitePreview(): Promise<InvitePreview> {
      return unsupported("previewing an invitation in the browser");
    },

    async joinInvite(): Promise<InviteJoinResult> {
      return unsupported("joining a channel from the browser");
    },

    async me(): Promise<{ member: ChannelMemberIdentity | null }> {
      return unsupported("member identity lookup");
    },
  };
}

/** The Worker's refusal reasons, said in a sentence a person can act on. */
function hostedMessageFor(reason: string | null): string | null {
  if (!reason) return null;
  const sentences: Record<string, string> = {
    owner_sign_in_required: "Your session ended. Sign in again to continue.",
    authentication_required: "Your session ended. Sign in again to continue.",
    csrf_denied: "Your session changed. Reload this page before trying again.",
    origin_denied: "That request did not come from this site.",
    space_not_found: "That space is not available to your account.",
    space_deleted: "That space has been deleted.",
    channel_not_found: "That channel no longer exists.",
    channel_access_denied: "You no longer have access to this channel.",
    slug_taken: "That address is already in use. Choose another.",
    invalid_slug: "Use lowercase letters, numbers and hyphens for the address.",
    message_limit: "This channel has reached its message limit.",
    channel_limit: "This space has reached its channel limit.",
    member_limit: "This channel has reached its member limit.",
    invite_limit: "This space has reached its invitation limit.",
    space_request_limit: "Too many requests. Wait a moment and try again.",
    space_payload_limit: "This space has reached its storage limit.",
    invitation_unavailable: "That invitation is no longer usable.",
    membership_expired_or_invalid: "That membership has expired.",
    admission_closed: "Scout Chat is not accepting new accounts yet.",
    signup_paused: "New accounts are not being accepted.",
    service_paused: "Scout Chat is temporarily paused.",
    invites_paused: "Invitations are paused.",
    space_read_only: "This space is read-only.",
    operator_required: "This page is limited to the service operator.",
    environment_lock: "That pause is locked by the deployment configuration.",
    github_auth_unconfigured: "GitHub sign-in is not configured on this deployment.",
    github_unavailable: "GitHub did not answer. Try again in a moment.",
    stale: "Older history has expired. Reopen the channel to see what is retained.",
  };
  return sentences[reason] ?? null;
}
