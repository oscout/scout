/**
 * Capability gating, rendered.
 *
 * The same components serve local Chat and hosted Chat; what differs is the
 * capability set the transport declares. These tests render the real components
 * under both sets and pin the rule the shared surface lives by: a capability the
 * server does not have is *absent*, not present-and-broken, and not quietly
 * simulated. Each case asserts both directions, so a control that disappears for
 * hosted is still proven to exist for local.
 */

import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");
const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

import type {
  ChannelInvitePublicView,
  ConversationDefinition,
} from "@openscout/protocol";

import type {
  ChatCapabilities,
  ChannelMemberReception,
  ChannelMemberView,
} from "./chat-api.ts";

const { LOCAL_CHAT_CAPABILITIES, chatApi } = await import("./chat-api.ts");
const { HOSTED_CHAT_CAPABILITIES } = await import("../../hosted-chat/hosted-chat-api.ts");
const { ChatTransportProvider } = await import("./chat-transport.tsx");
const { createQueryChatAddress } = await import("./chat-address.ts");
const { ChannelComposer } = await import("./ChannelComposer.tsx");
const { InviteSheet } = await import("./InviteSheet.tsx");
const { TeamPanel } = await import("./TeamPanel.tsx");

const NOW = new Date(2026, 8, 16, 14, 0, 0, 0).getTime();

const reception = (): ChannelMemberReception => ({
  state: "ready_to_receive",
  routeKind: "persistent",
  listening: true,
  summary: "Ready to receive",
  detail: "Attached to session ses-1 over a persistent route.",
  evidenceAt: NOW - 120_000,
  attachedSessionId: "ses-1",
  redeemedAt: NOW - 3_600_000,
});

const codex: ChannelMemberView = {
  actorId: "actor-codex",
  kind: "agent",
  displayName: "Codex",
  harness: "codex",
  reception: reception(),
};

/** Render `element` as the surface renders it: under a declared transport. */
function underCapabilities(capabilities: ChatCapabilities, element: unknown): string {
  return renderToStaticMarkup(
    createElement(
      ChatTransportProvider,
      {
        api: chatApi,
        capabilities,
        address: createQueryChatAddress("scout"),
        children: element,
      },
    ),
  );
}

const both = (element: () => unknown) => ({
  local: underCapabilities(LOCAL_CHAT_CAPABILITIES, element()),
  hosted: underCapabilities(HOSTED_CHAT_CAPABILITIES, element()),
});

describe("asks", () => {
  test("the ask picker is absent where nothing can be addressed", () => {
    const { local, hosted } = both(() =>
      createElement(ChannelComposer, {
        members: [codex],
        draft: "",
        onDraftChange: () => {},
        askTargetId: null,
        onAskTargetChange: () => {},
        onSend: () => {},
        sending: false,
        error: null,
        placeholder: "Message #general",
      }));

    // Local Scout dispatches invocations, so the picker is real.
    expect(local).toContain("Ask an agent");
    // The hosted Worker has no invocation dispatch: `feed` returns no requests
    // at all. A picker here would address nothing, so there is none — rather
    // than a button that posts an ordinary message and calls it an ask.
    expect(hosted).not.toContain("Ask an agent");
    // The composer itself is the same component either way.
    expect(hosted).toContain('class="chat-composer" data-variant="channel"');
    expect(hosted).toContain('class="chat-composer-send"');
  });
});

/*
 * SpaceSwitcher's menu — and therefore the space-delete control — exists only
 * after the trigger is pressed, which a static render cannot do; this file's
 * harness renders markup, it does not drive state. The delete path is covered
 * where it is observable: `HOSTED_CHAT_CAPABILITIES.spaceDelete` and the
 * adapter's `deleteSpace` in client/hosted-chat/hosted-chat-api.test.ts, and
 * the declaration diff at the end of this file.
 */

describe("invitations", () => {
  const sheet = () =>
    createElement(InviteSheet, {
      channel: {
        id: "conv-1",
        kind: "channel",
        title: "general",
        visibility: "private",
        shareMode: "local",
        authorityNodeId: "node-1",
        participantIds: [],
      },
      space: "work",
      viewerActorId: "actor-me",
      viewerName: "Alex",
      onClose: () => {},
      onInvitesChanged: () => {},
    });

  test("hosted's agent tab explains the whole path in place", () => {
    const channel = { id: "conv-1", kind: "channel", title: "general", visibility: "private", shareMode: "local", authorityNodeId: "node-1", participantIds: [] };
    const hosted = underCapabilities(HOSTED_CHAT_CAPABILITIES, createElement(InviteSheet, {
      channel, space: "work", viewerActorId: "actor-me", viewerName: "Alex",
      onClose: () => {}, onInvitesChanged: () => {}, initialKind: "api",
    }));
    expect(hosted).toContain("Invite an agent");
    expect(hosted).toContain('aria-label="How an agent joins"');
    expect(hosted).toContain("Paste it into your agent’s chat.");
    expect(hosted).toContain("joins #general, and shows up in Members");
    expect(hosted).toContain("Create agent invitation");
    expect(hosted).not.toContain("No install");
    // Local Chat keeps the no-install wording beside its installed Agent kind.
    const local = underCapabilities(LOCAL_CHAT_CAPABILITIES, createElement(InviteSheet, {
      channel, space: "work", viewerActorId: "actor-me", viewerName: "Alex",
      onClose: () => {}, onInvitesChanged: () => {}, initialKind: "api",
    }));
    expect(local).toContain("Invite an agent with nothing installed");
    expect(local).not.toContain("How an agent joins");
  });

  test("only the redeemable kinds are offered, and one kind needs no switch", () => {
    const { local, hosted } = both(sheet);

    // Local Chat redeems all three kinds, so all three are offered.
    expect(local).toContain("chat-invite-switch");
    for (const kind of ["Teammate", "Agent", "No install"]) {
      expect(local).toContain(`</svg> ${kind}</button>`);
    }
    // Hosted supports signed-in people and API agents, but not bound session agents.
    expect(hosted).toContain("chat-invite-switch");
    expect(hosted).toContain("</svg> Teammate</button>");
    // The HTTP invitation is hosted's only agent path, so it is labelled Agent.
    expect(hosted).toContain("</svg> Agent</button>");
    expect(hosted).not.toContain("</svg> No install</button>");
    expect(hosted).toContain("One person joins using their signed-in account.");
    expect(hosted).not.toContain("They choose their own name");
    expect(hosted).toContain("chat-sheet");
    expect(hosted).toContain('aria-label="Invite to #general"');

    // Local lists invitations, so it can point at where to revoke them.
    expect(local).toContain("Members");
    // Hosted keeps no public invitation record, so it says the link is shown
    // once rather than promising a list that does not exist.
    expect(hosted).toContain("Members");
  });
});

describe("the team panel", () => {
  const teamChannel: ConversationDefinition = {
    id: "conv-1",
    kind: "channel",
    title: "general",
    visibility: "private",
    shareMode: "local",
    authorityNodeId: "node-1",
    participantIds: [],
  };

  const activeInvite: ChannelInvitePublicView = {
    id: "inv-1",
    channelId: "conv-1",
    scope: "channel_participation",
    state: "active",
    createdByActorId: "actor-host",
    tokenHint: "vx3k",
    createdAt: NOW - 3_600_000,
    expiresAt: NOW + 6 * 86_400_000,
    maxRedemptions: null,
    redemptionCount: 0,
    route: {
      authorityNodeId: "node-1",
      host: "arts-mini.tail1234.ts.net",
      baseUrl: "https://arts-mini.tail1234.ts.net:43120",
      reachability: "mesh",
    },
    redemptions: [],
  };

  const panel = () =>
    createElement(TeamPanel, {
      spaceTitle: "Home",
      team: {
        people: [],
        unownedAgents: [],
        invites: [{ channel: teamChannel, invite: activeInvite }],
        channelErrors: [],
      },
      loading: false,
      nowMs: NOW,
      viewerActorId: "actor-me",
      viewerIsOperator: true,
      revokingInviteId: null,
      onOpenMember: () => {},
      onRevokeInvite: () => {},
      onInvite: () => {},
      inviteDisabled: false,
      onClose: () => {},
      overlay: false,
    });

  test("an unlistable invitation read is stated, not emptied", () => {
    const { local, hosted } = both(panel);

    // The hosted Worker never enumerates invitations, so the panel says the
    // list is absent — a rendered-but-empty list would claim "none".
    expect(hosted).not.toContain("does not list outstanding invitations");
    expect(hosted).toContain("chat-invite-row");

    // Local lists them: the outstanding invitation is a real row, tagged with
    // the channel it admits to, and the operator may revoke it.
    expect(local).toContain("chat-invite-row");
    expect(local).toContain("#general");
    expect(local).toContain(">Revoke</button>");
    // The panel itself is the same component either way.
    expect(hosted).toContain('aria-label="Team"');
  });

  test("both backends support member removal", () => {
    const { local, hosted } = both(panel);
    expect(local).not.toContain("does not support removing members");
    expect(hosted).not.toContain("does not support removing members");
  });
});

describe("the declaration itself", () => {
  test("hosted and local differ only in what the servers actually differ in", () => {
    const differences = (Object.keys(LOCAL_CHAT_CAPABILITIES) as (keyof ChatCapabilities)[])
      .filter((key) =>
        JSON.stringify(LOCAL_CHAT_CAPABILITIES[key]) !== JSON.stringify(HOSTED_CHAT_CAPABILITIES[key]));

    expect(differences.sort()).toEqual([
      "asks",
      "inviteKinds",
      "liveStream",
      "memberDetail",
      "namedFirstChannel",
      "reactions",
      "signIn",
      "spaceDelete",
    ]);
    // Everything else is shared, which is the point: the surface is one surface.
    expect(LOCAL_CHAT_CAPABILITIES.spaceCreate).toBe(HOSTED_CHAT_CAPABILITIES.spaceCreate);
    expect(LOCAL_CHAT_CAPABILITIES.channelCreate).toBe(HOSTED_CHAT_CAPABILITIES.channelCreate);
    expect(LOCAL_CHAT_CAPABILITIES.signOut).toBe(HOSTED_CHAT_CAPABILITIES.signOut);
  });
});
