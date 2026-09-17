/**
 * `/invite/<token>` — the human half of an invitation (§7.2).
 *
 * A shell-less page: it mounts no operator surface and makes exactly two
 * requests, both scoped to the token in the URL. Opening a link never joins
 * anything — the preview is a pure GET, and joining is an explicit POST behind
 * a button the person presses.
 *
 * Every rejection is a sentence with a way out, not an error code.
 */

import { useCallback, useEffect, useState } from "react";

import {
  chatApi,
  ChatApiError,
  type ChannelMemberIdentity,
  type InvitePreview,
} from "./chat-api.ts";
import { ChatSpaceTheme, useScoutStandaloneTheme } from "./ChatSpaceTheme.tsx";
import { inviteLandingView, reachabilityView } from "./chat-space-model.ts";

const NAME_STORAGE_KEY = "scout.chat.invite.displayName";

function readRememberedName(): string {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberName(value: string) {
  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, value);
  } catch {
    // A private window is allowed to forget. Nothing here depends on it.
  }
}

export function InviteLandingScreen({ token }: { token: string }) {
  const theme = useScoutStandaloneTheme();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [member, setMember] = useState<ChannelMemberIdentity | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(() => readRememberedName());
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled([chatApi.invitePreview(token), chatApi.me()]).then((results) => {
      if (cancelled) return;
      const [previewResult, meResult] = results;
      if (previewResult.status === "fulfilled") {
        setPreview(previewResult.value);
        setLoadError(null);
      } else {
        const error = previewResult.reason;
        setLoadError(
          error instanceof ChatApiError
            ? error.message
            : "This invitation link could not be checked.",
        );
      }
      // A returning member is recognised, but not knowing who they are is
      // never fatal: the form simply asks again.
      if (meResult.status === "fulfilled") setMember(meResult.value.member);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const openChannel = useCallback((channelId: string) => {
    window.location.href = `/chat?channel=${encodeURIComponent(channelId)}`;
  }, []);

  const join = useCallback(async () => {
    if (!preview) return;
    const displayName = name.trim();
    if (!displayName) {
      setJoinError("A name is required to join.");
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      const result = await chatApi.joinInvite(token, displayName);
      rememberName(displayName);
      openChannel(result.conversationId);
    } catch (error) {
      setJoinError(
        error instanceof ChatApiError ? error.message : "Joining did not work. Try again.",
      );
      setJoining(false);
    }
  }, [name, openChannel, preview, token]);

  if (loading) {
    return (
      <ChatSpaceTheme theme={theme} className="chat-centered">
        <p className="chat-card-meta">Checking this invitation…</p>
      </ChatSpaceTheme>
    );
  }

  if (!preview) {
    return (
      <ChatSpaceTheme theme={theme} className="chat-centered">
        <div className="chat-card">
          <span className="chat-card-eyebrow">Scout Chat</span>
          <h1>This invitation is not valid</h1>
          <p>{loadError ?? "This invitation link is not valid."}</p>
        </div>
      </ChatSpaceTheme>
    );
  }

  const alreadyMember = Boolean(
    member && member.channelIds.includes(preview.channel.id),
  );
  const inviterName = preview.inviter?.displayName?.trim() || null;
  const view = inviteLandingView({
    channelTitle: preview.channel.title,
    invite: preview.invite,
    inviterName,
    alreadyMember,
    nowMs: Date.now(),
  });
  const reach = reachabilityView(preview.invite.route, preview.reachability ?? null);

  return (
    <ChatSpaceTheme theme={theme} className="chat-centered">
      <div className="chat-card">
        <span className="chat-card-eyebrow">
          {`Scout Chat on ${preview.invite.route.host}`}
        </span>
        <h1>{view.channelTitle ?? preview.channel.title}</h1>
        {preview.channel.topic ? <p>{preview.channel.topic}</p> : null}
        <p className="chat-card-meta">
          {[
            inviterName ? `Invited by ${inviterName}` : null,
            `${preview.channel.memberCount} in this channel`,
          ].filter(Boolean).join(" · ")}
        </p>

        {view.mode === "closed" ? (
          <p>{view.message}</p>
        ) : view.mode === "open" ? (
          <>
            <button
              type="button"
              className="btn btn--accent"
              onClick={() => openChannel(preview.channel.id)}
            >
              {view.cta}
            </button>
            <p className="chat-card-note">{view.note}</p>
          </>
        ) : (
          <>
            <label className="chat-card-field">
              <span className="label-md">Join as</span>
              <input
                className="chat-input"
                value={name}
                autoFocus
                placeholder="Your name"
                aria-label="Your name"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void join();
                  }
                }}
              />
            </label>
            {joinError ? <p className="chat-card-error">{joinError}</p> : null}
            <button
              type="button"
              className="btn btn--accent"
              disabled={joining || name.trim().length === 0}
              onClick={() => void join()}
            >
              {joining ? "Joining…" : view.cta}
            </button>
            <p className="chat-card-note">{view.note}</p>
          </>
        )}

        {/* Say where this link reaches, on the page the link itself landed on. */}
        <p className="chat-card-note">{`${reach.state} — ${reach.line}`}</p>
        {reach.caveat ? <p className="chat-card-note">{reach.caveat}</p> : null}
      </div>
    </ChatSpaceTheme>
  );
}
