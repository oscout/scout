/**
 * The Invite sheet: three invitation kinds, one sheet (§7.1).
 *
 * A teammate invitation admits a human. An agent invitation is minted by, and
 * bound to, the member issuing it — that binding is how "Maya's Codex" gets
 * its ownership, and why an agent invitation copied by Maya cannot enrol an
 * agent as anybody else's. A no-install invitation admits an agent with
 * nothing but an HTTP client: the server mints its identity when it joins,
 * it reads the room by polling, and it can never be woken or sent a tracked
 * ask — the sheet says so before the invitation exists.
 *
 * The reachability line is the honesty rule with teeth: the sheet prints the
 * route the invitation was actually minted with, and the server's own caveat
 * in connection details. A doorway name that resolves per machine is never presented as an
 * address a teammate can reach.
 */

import { useCallback, useEffect, useState } from "react";
import { Bot, Users, Link2, Monitor, Globe, CircleHelp, Webhook } from "lucide-react";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import type { ConversationDefinition } from "@openscout/protocol";

import { chatApi, ChatApiError, type CreatedChannelInvite } from "./chat-api.ts";
import { CopyAction } from "./ChatBits.tsx";
import {
  channelLabel,
  expiryLabel,
  inviteCopyBlock,
  reachabilityView,
  type InviteKind,
} from "./chat-space-model.ts";

type SheetInvite = CreatedChannelInvite | null;

/**
 * Everything one section says, in one place, so the three kinds stay parallel
 * and the copy is reviewable side by side. Facts only a real endpoint backs:
 * `metaFacts` for the no-install kind claims polling, never availability.
 */
const SECTION_COPY: Record<InviteKind, {
  ariaLabel: string;
  heading: string;
  explain: string;
  mintLabel: string;
  preMintNote: string;
  copyLabel: string;
  copiedLabel: string;
  postCopyNote: string;
  metaFacts: string;
  previewLabel: string;
}> = {
  teammate: {
    ariaLabel: "Teammate invitation",
    heading: "Make room for a teammate",
    explain: "Share a link. They join in their browser and can bring their own agent.",
    mintLabel: "Create invite link",
    preMintNote: "They choose their own name when they join.",
    copyLabel: "Copy invite link",
    copiedLabel: "Link copied",
    postCopyNote: "Send it to your teammate.",
    metaFacts: "Reusable link",
    previewLabel: "Preview invite link",
  },
  agent: {
    ariaLabel: "Agent invitation",
    heading: "Bring your agent into the conversation",
    explain: "Bring an agent you already have running. Its session and workspace stay right where they are.",
    mintLabel: "Create agent invitation",
    preMintNote: "You’ll get instructions to paste into your agent’s chat.",
    copyLabel: "Copy agent instructions",
    copiedLabel: "Instructions copied",
    postCopyNote: "Paste into your agent’s current chat.",
    metaFacts: "One agent · Joins as yours",
    previewLabel: "Preview agent instructions",
  },
  api: {
    ariaLabel: "No-install agent invitation",
    heading: "Invite an agent with nothing installed",
    explain: "For an agent that can make HTTP requests and nothing else. It joins over plain HTTP, reads the room by polling, and posts its replies — it can’t be woken or sent tracked asks.",
    mintLabel: "Create no-install invitation",
    preMintNote: "You’ll get one instruction to paste into any agent’s chat.",
    copyLabel: "Copy no-install instructions",
    copiedLabel: "Instructions copied",
    postCopyNote: "Paste into the agent’s chat. It joins over HTTP — nothing to install.",
    metaFacts: "One agent · Reads by polling",
    previewLabel: "Preview no-install instructions",
  },
};

function ReachabilityLine({ invite }: { invite: CreatedChannelInvite }) {
  const view = reachabilityView(invite.invite.route, invite.reachability ?? null);
  const reachability = invite.invite.route.reachability;
  const Icon = view.remoteUsable ? Globe : reachability === "local_only" ? Monitor : CircleHelp;
  const summary = view.remoteUsable
    ? "Works through your Scout network."
    : reachability === "local_only"
      ? "Use this link on this Mac. It cannot be opened on another machine."
      : reachability === "lan"
        ? "Use this link on the same local network."
        : "Other machines may not be able to open this link.";
  return (
    <div className="chat-invite-connection" data-restricted={!view.remoteUsable}>
      <Icon size={16} aria-hidden="true" />
      <div>
        <p className="chat-invite-connection-title">{view.remoteUsable ? "Network invitation" : reachability === "local_only" ? "This Mac only" : reachability === "lan" ? "Same network only" : "Connection not verified"}</p>
        <p>{summary}</p>
        <details className="chat-invite-details">
          <summary>Connection details</summary>
          <p>{view.state} — {view.line}</p>
          {view.caveat ? <p>{view.caveat}</p> : null}
        </details>
      </div>
    </div>
  );
}

function InviteSection({
  kind,
  channel,
  inviterName,
  invite,
  error,
  pending,
  onMint,
}: {
  kind: InviteKind;
  channel: ConversationDefinition;
  inviterName: string;
  invite: SheetInvite;
  error: string | null;
  pending: boolean;
  onMint: () => void;
}) {
  const nowMs = Date.now();
  const [previewOpen, setPreviewOpen] = useState(false);
  const copy = SECTION_COPY[kind];
  const MintIcon = kind === "teammate" ? Link2 : kind === "agent" ? Bot : Webhook;

  const body = invite
    ? inviteCopyBlock({
        kind,
        channelTitle: channel.title,
        channelTopic: channel.topic ?? null,
        inviterName,
        inviteUrl: invite.inviteUrl,
        agentInstructionsUrl: invite.agentInstructionsUrl,
      })
    : null;

  const copyValue = kind === "teammate" ? invite?.inviteUrl : body;
  return (
    <section className="chat-sheet-sec" aria-label={copy.ariaLabel}>
      <h3 className="chat-invite-heading">{copy.heading}</h3>
      <p className="chat-sheet-explain">{copy.explain}</p>
      {error ? <p className="chat-sheet-error" role="alert">{error}</p> : null}
      {invite && body && copyValue ? (
        <>
          <ReachabilityLine invite={invite} />
          <div className="chat-invite-primary">
            <CopyAction
              value={copyValue}
              label={copy.copyLabel}
              copiedLabel={copy.copiedLabel}
              className="btn btn--accent chat-invite-copy"
              onCopyFailed={() => setPreviewOpen(true)}
            />
            <p className="chat-invite-next">{copy.postCopyNote}</p>
          </div>
          <p className="chat-invite-meta">
            {expiryLabel(invite.invite.expiresAt, nowMs)} · {copy.metaFacts}
          </p>
          <details className="chat-invite-preview" open={previewOpen} onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
            <summary>{copy.previewLabel}</summary>
            <div className="surface-card--inset chat-copy-block" tabIndex={0}>{copyValue}</div>
            <p className="chat-invite-meta">Copy before closing. This invitation is not shown again.</p>
          </details>
        </>
      ) : (
        <div className="chat-invite-primary">
          <button type="button" className="btn btn--accent chat-invite-copy" onClick={onMint} disabled={pending}>
            <MintIcon size={16} aria-hidden="true" />
            {pending ? "Creating invitation…" : copy.mintLabel}
          </button>
          <p className="chat-invite-next">{copy.preMintNote}</p>
        </div>
      )}
    </section>
  );
}

export function InviteSheet({
  channel,
  space,
  viewerActorId,
  viewerName,
  onClose,
  onInvitesChanged,
}: {
  channel: ConversationDefinition;
  space?: string;
  viewerActorId: string;
  viewerName: string;
  onClose: () => void;
  onInvitesChanged: () => void;
}) {
  const [kind, setKind] = useState<InviteKind>("teammate");
  const { ref: dialogRef } = useFocusTrap<HTMLDivElement>();
  const [invites, setInvites] = useState<Record<InviteKind, SheetInvite>>({
    teammate: null,
    agent: null,
    api: null,
  });
  const [errors, setErrors] = useState<Record<InviteKind, string | null>>({
    teammate: null,
    agent: null,
    api: null,
  });
  const [pending, setPending] = useState<InviteKind | null>(null);

  const mint = useCallback(
    async (kind: InviteKind) => {
      setPending(kind);
      setErrors((current) => ({ ...current, [kind]: null }));
      try {
        const created = await chatApi.createInvite(channel.id, {
          kind,
          space,
          createdByActorId: viewerActorId,
          // The agent invitation carries its issuer, so the agent that redeems
          // it joins as theirs. A no-install invitation carries nobody: the
          // server mints the participant's identity when it joins.
          ...(kind === "agent" ? { inviteeDisplayName: viewerName, inviteeActorId: viewerActorId } : {}),
        });
        setInvites((current) => ({ ...current, [kind]: created }));
        onInvitesChanged();
      } catch (error) {
        const message = error instanceof ChatApiError
          ? error.message
          : "Could not create this invitation.";
        setErrors((current) => ({ ...current, [kind]: message }));
      } finally {
        setPending(null);
      }
    },
    [channel.id, space, onInvitesChanged, viewerActorId, viewerName],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="chat-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], summary, [tabindex="0"]',
        )).filter((node) => node.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }} tabIndex={-1} className="chat-sheet" role="dialog" aria-modal="true" aria-label={`Invite to ${channelLabel(channel.title)}`}>
        <div className="chat-sheet-title">
          <h2>{`Invite to ${channelLabel(channel.title)}`}</h2>
          <button
            type="button"
            className="chat-rpanel-close"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close invite sheet"
          >
            ×
          </button>
        </div>

        <div className="chat-invite-switch" role="group" aria-label="Who are you inviting?">
          <button type="button" aria-pressed={kind === "teammate"} onClick={() => setKind("teammate")}>
            <Users size={16} aria-hidden="true" /> Teammate
          </button>
          <button type="button" aria-pressed={kind === "agent"} onClick={() => setKind("agent")}>
            <Bot size={16} aria-hidden="true" /> Agent
          </button>
          <button type="button" aria-pressed={kind === "api"} onClick={() => setKind("api")}>
            <Webhook size={16} aria-hidden="true" /> No install
          </button>
        </div>
        <InviteSection
          key={kind}
          kind={kind}
          channel={channel}
          inviterName={viewerName}
          invite={invites[kind]}
          error={errors[kind]}
          pending={pending !== null}
          onMint={() => void mint(kind)}
        />
        <p className="chat-sheet-foot">Manage or revoke invitations in Members.</p>
      </div>
    </div>
  );
}
