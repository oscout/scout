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

  test("only the redeemable kinds are offered, and one kind needs no switch", () => {
    const { local, hosted } = both(sheet);

    // Local Chat redeems all three kinds, so all three are offered.
    expect(local).toContain("chat-invite-switch");
    for (const kind of ["Teammate", "Agent", "No install"]) {
      expect(local).toContain(`</svg> ${kind}</button>`);
    }
    // The hosted Worker's only redemption path mints an API participant, so the
    // other two are not offered — and with one kind left there is no switch to
    // draw at all, rather than a switch with a single dead position.
    expect(hosted).not.toContain("chat-invite-switch");
    expect(hosted).not.toContain("</svg> Teammate</button>");
    expect(hosted).not.toContain("</svg> Agent</button>");
    // It is still the same sheet, opened on the one kind this server has.
    expect(hosted).toContain("chat-sheet");
    expect(hosted).toContain('aria-label="Invite to #general"');

    // Local lists invitations, so it can point at where to revoke them.
    expect(local).toContain("Members");
    // Hosted keeps no public invitation record, so it says the link is shown
    // once rather than promising a list that does not exist.
    expect(hosted).not.toContain("Manage or revoke invitations in Members.");
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
      "inviteList",
      "inviteRevoke",
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
