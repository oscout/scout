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

import type { MessageRecord } from "@openscout/protocol";
import type { ChannelMemberReception, ChannelMemberView, TrackedRequest } from "./chat-api.ts";

const { MessageBody, ReceptionBlock, TrackedAskCard, Turn } = await import("./ChatBits.tsx");

const NOW = new Date(2026, 8, 16, 14, 0, 0, 0).getTime();
const MINUTE = 60_000;

const reception = (overrides: Partial<ChannelMemberReception> = {}): ChannelMemberReception => ({
  state: "ready_to_receive",
  routeKind: "persistent",
  listening: true,
  summary: "Ready to receive",
  detail: "Attached to session ses-1 over a persistent route.",
  evidenceAt: NOW - 2 * MINUTE,
  attachedSessionId: "ses-1",
  redeemedAt: NOW - 60 * MINUTE,
  ...overrides,
});

const maya: ChannelMemberView = {
  actorId: "actor-maya",
  kind: "person",
  displayName: "Maya",
  reception: reception({ routeKind: "none", listening: false, state: "waiting_for_agent" }),
};

const codex = (receptionOverrides: Partial<ChannelMemberReception> = {}): ChannelMemberView => ({
  actorId: "actor-codex",
  kind: "agent",
  displayName: "Codex",
  harness: "codex",
  owner: { actorId: "actor-maya", displayName: "Maya" },
  reception: reception(receptionOverrides),
});

const roster = (...members: ChannelMemberView[]): Map<string, ChannelMemberView> =>
  new Map(members.map((member) => [member.actorId, member]));

const message = (
  overrides: Partial<MessageRecord> & Pick<MessageRecord, "id">,
): MessageRecord => ({
  conversationId: "conv-chat",
  actorId: "actor-maya",
  originNodeId: "node-authority",
  class: "agent",
  body: "morning",
  visibility: "workspace",
  policy: "best_effort",
  createdAt: NOW - 5 * MINUTE,
  ...overrides,
});

describe("Turn", () => {
  test("is flat: a name, a clock, a body, and no delivery claim", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, { message: message({ id: "m1" }), members: roster(maya), nowMs: NOW }),
    );
    expect(html).toContain("Maya");
    expect(html).toContain("morning");
    expect(html).toContain("13:55");
    // No fake delivery ticks, read receipts, or per-message status anywhere.
    expect(html).not.toContain("✓");
    expect(html).not.toContain("Delivered");
    expect(html).not.toContain("Seen");
    expect(html).not.toContain("chat-ask-card");
  });

  test("an addressed turn carries exactly one card, naming its target", () => {
    const request: TrackedRequest = {
      messageId: "m1",
      flightId: "flight-1",
      state: "running",
      targetActorId: "actor-codex",
    };
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({ id: "m1", body: "@Maya's Codex check the build" }),
        members: roster(maya, codex()),
        nowMs: NOW,
        request,
        replyCount: 2,
        lastReplyAt: NOW - 3 * MINUTE,
        onOpenThread: () => {},
      }),
    );
    expect(html).toContain("Tracked request");
    expect(html).toContain("▸ Maya&#x27;s Codex · running");
    expect(html).toContain('data-tone="owed"');
    expect(html).toContain("⌵ 2 replies · last 3m ago");
    expect(html.match(/chat-ask-card/gu)?.length).toBe(1);
  });

  test("every root can start a thread, not only one that already has replies", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({ id: "m1" }),
        members: roster(maya),
        nowMs: NOW,
        onOpenThread: () => {},
      }),
    );
    expect(html).toContain("⌵ Reply in thread");
    // Quiet until the turn is hovered or focused, but present in the layout.
    expect(html).toContain('data-empty="true"');
  });

  test("with no thread handler there is no reply affordance at all", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, { message: message({ id: "m1" }), members: roster(maya), nowMs: NOW }),
    );
    expect(html).not.toContain("chat-thread-stub");
  });

  test("a message from somebody the roster forgot still renders", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({ id: "m1", actorId: "actor-ghost", body: "still here" }),
        members: roster(maya),
        nowMs: NOW,
      }),
    );
    expect(html).toContain("actor-ghost");
    expect(html).toContain("still here");
  });
});

describe("TrackedAskCard", () => {
  test("an owed ask at an unreachable agent says so instead of spinning", () => {
    const html = renderToStaticMarkup(
      createElement(TrackedAskCard, {
        request: {
          messageId: "m1",
          flightId: "flight-1",
          state: "queued",
          targetActorId: "actor-codex",
        },
        target: codex({ routeKind: "none", listening: false, state: "unavailable" }),
        withTarget: true,
      }),
    );
    expect(html).toContain("isn&#x27;t listening right now");
    expect(html).toContain('data-tone="owed"');
  });

  test("a failed ask is the only red in the feed", () => {
    const html = renderToStaticMarkup(
      createElement(TrackedAskCard, {
        request: {
          messageId: "m1",
          flightId: "flight-1",
          state: "failed",
          targetActorId: "actor-codex",
        },
        target: codex(),
        withTarget: false,
      }),
    );
    expect(html).toContain('data-tone="failed"');
    expect(html).toContain("▸ failed");
  });
});

describe("ReceptionBlock", () => {
  test("a live attached route earns the dot and shows its evidence", () => {
    const html = renderToStaticMarkup(
      createElement(ReceptionBlock, { member: codex(), nowMs: NOW }),
    );
    expect(html).toContain("dot dot--neutral");
    expect(html).toContain("Ready to receive");
    expect(html).toContain("Attached to session ses-1 over a persistent route.");
    expect(html).toContain("confirmed 2m ago");
  });

  test("a wake-on-delivery route explains itself and takes no dot", () => {
    const html = renderToStaticMarkup(
      createElement(ReceptionBlock, {
        member: codex({ routeKind: "wake_on_delivery", listening: false }),
        nowMs: NOW,
      }),
    );
    expect(html).not.toContain("dot dot--neutral");
    expect(html).toContain("a delivery starts or resumes this agent&#x27;s session.");
  });
});

describe("MessageBody", () => {
  test("only a mention the record carries is highlighted", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBody, {
        message: message({
          id: "m1",
          body: "@Maya's Codex and @nobody",
          mentions: [{ actorId: "actor-codex", label: "Maya's Codex" }],
        }),
      }),
    );
    expect(html).toContain('<span class="chat-mention">@Maya&#x27;s Codex</span>');
    expect(html).not.toContain('<span class="chat-mention">@nobody</span>');
  });
});
