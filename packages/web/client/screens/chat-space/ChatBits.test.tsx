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

import { REACTION_EMOJI_MORE, REACTION_EMOJI_QUICK } from "@openscout/protocol";
import type { MessageRecord } from "@openscout/protocol";
import type { ChannelMemberReception, ChannelMemberView, TrackedRequest } from "./chat-api.ts";

const { MessageBody, ReceptionBlock, TrackedAskCard, Turn } = await import("./ChatBits.tsx");
const { ChatTransportProvider } = await import("./chat-transport.tsx");
const { HOSTED_CHAT_CAPABILITIES } = await import("../../hosted-chat/hosted-chat-api.ts");
const { chatApi } = await import("./chat-api.ts");
const { createQueryChatAddress } = await import("./chat-address.ts");

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
  test("only canonical mentions of the viewer receive an attention label", () => {
    const render = (mentions?: MessageRecord["mentions"]) => renderToStaticMarkup(createElement(Turn, {
      message: message({ id: "mention", body: "@Maya quoted text", mentions }), members: roster(maya), nowMs: NOW, viewerActorId: "actor-maya",
    }));
    expect(render()).not.toContain("Mentions you");
    expect(render([{ actorId: "someone-else" }])).not.toContain("Mentions you");
    expect(render([{ actorId: "actor-maya" }])).toContain("Mentions you");
  });

  test("a departed author keeps the server label without rejoining the roster", () => {
    const members = roster();
    const html = renderToStaticMarkup(createElement(Turn, {
      message: { ...message({ id: "historical" }), actorName: "Former teammate" }, members, nowMs: NOW,
    }));
    expect(html).toContain("Former teammate");
    expect(members.size).toBe(0);
    expect(html).not.toContain("Ready to receive");
  });

  test("the clock copies a link when asked", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({ id: "m-link" }),
        members: roster(maya),
        nowMs: NOW,
        onCopyLink: () => {},
      }),
    );
    expect(html).toContain("Copy link to this message");
    expect(html).toContain('data-message-id="m-link"');
  });

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
    expect(html).toContain("Tracked request for Maya&#x27;s Codex, running");
    expect(html).toContain("Maya&#x27;s Codex is working");
    expect(html).toContain('data-tone="owed"');
    expect(html).toContain("⌵ 2 replies · last 3m ago");
    expect(html.match(/chat-ask-card/gu)?.length).toBe(1);
  });

  test("local capability draws chips and a hover picker, never a plus", () => {
    const withReactions = renderToStaticMarkup(
      createElement(Turn, {
        message: message({ id: "m1", reactions: [{ emoji: "👍", count: 2, me: true }] } as never),
        members: roster(maya),
        nowMs: NOW,
        onReact: () => {},
      }),
    );
    expect(withReactions).toContain("chat-reaction");
    expect(withReactions).toContain("chat-reaction-picker");
    expect(withReactions).toContain("including you");
    expect(withReactions).not.toContain("Add reaction");
    expect(withReactions).not.toContain("＋");

    const hosted = renderToStaticMarkup(
      createElement(
        ChatTransportProvider,
        {
          api: chatApi,
          capabilities: HOSTED_CHAT_CAPABILITIES,
          address: createQueryChatAddress("home"),
          children: createElement(Turn, {
            message: message({ id: "m1", reactions: [{ emoji: "👍", count: 2, me: true }] } as never),
            members: roster(maya),
            nowMs: NOW,
            onReact: () => {},
          }),
        },
      ),
    );
    expect(hosted).not.toContain("chat-reaction");
    expect(hosted).not.toContain("chat-reaction-picker");
  });

  test("a reaction chip names who reacted on hover, from the roster", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({ id: "m1", reactions: [{ emoji: "👍", count: 2, me: true, actorIds: [maya.actorId, "viewer"] }] } as never),
        members: roster(maya),
        nowMs: NOW,
        viewerActorId: "viewer",
        onReact: () => {},
      }),
    );
    expect(html).toContain(`data-reactors="${maya.displayName}, You"`);
    expect(html).toContain(`from ${maya.displayName}, You, including you`);
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
    // Starting a thread is an action in the hover toolbar, not a reserved row.
    expect(html).toContain('aria-label="Reply in thread to');
    expect(html).toContain('role="toolbar"');
    expect(html).not.toContain("chat-thread-stub");
  });

  test("with no thread handler there is no reply affordance at all", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, { message: message({ id: "m1" }), members: roster(maya), nowMs: NOW }),
    );
    expect(html).not.toContain("chat-thread-stub");
  });

  test("video and html attachments use media and a sandbox, not a plus", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({
          id: "m1",
          attachments: [
            { id: "v1", mediaType: "video/mp4", fileName: "clip.mp4", url: "http://scout.local/api/blobs/v1" },
            { id: "h1", mediaType: "text/html", fileName: "note.html", url: "http://scout.local/api/blobs/h1" },
          ],
        } as never),
        members: roster(maya),
        nowMs: NOW,
      }),
    );
    expect(html).toContain("chat-attach-video");
    expect(html).toContain("chat-attach-html");
    expect(html).toContain("sandbox=\"\"");
    // A clip is a player, not a frame: real controls, and only its metadata
    // fetched until somebody presses play.
    expect(html).toContain("controls=\"\"");
    expect(html).toContain("preload=\"metadata\"");
    expect(html).toContain("playsInline=\"\"");
    // Neither an iframe nor an image below the fold is worth a request yet.
    expect(html).toContain("loading=\"lazy\"");
  });

  test("image attachments render on the turn", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({
          id: "m1",
          attachments: [{
            id: "att-1",
            mediaType: "image/png",
            fileName: "shot.png",
            url: "http://scout.local/api/blobs/att-1",
          }],
        } as never),
        members: roster(maya),
        nowMs: NOW,
      }),
    );
    expect(html).toContain("chat-attach-image");
    expect(html).toContain("/api/blobs/att-1");
    expect(html).not.toContain("http://scout.local/api/blobs/att-1");
    expect(html).toContain("loading=\"lazy\"");
    expect(html).toContain("decoding=\"async\"");
    // No size is asserted for a file whose shape we have not been told. The
    // stylesheet reserves a band; the browser replaces it with the truth.
    expect(html).not.toContain("width=\"360\"");
    expect(html).not.toContain("height=\"240\"");
  });

  test("the hover strip stays five; the rest of the allowlist waits behind ›", () => {
    const html = renderToStaticMarkup(
      createElement(Turn, {
        message: message({ id: "m1" }),
        members: roster(maya),
        nowMs: NOW,
        onReact: () => {},
      }),
    );
    for (const emoji of REACTION_EMOJI_QUICK) expect(html).toContain(emoji);
    // Closed, the picker is the strip and one affordance — not a ribbon of
    // seventeen cells laid across the meta row.
    for (const emoji of REACTION_EMOJI_MORE) expect(html).not.toContain(emoji);
    expect(html).toContain("More emoji");
    expect(html).not.toContain("chat-reaction-sheet");
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
  test("recorded outcomes and waiting uncertainty are explicit", () => {
    const render = (request: TrackedRequest) => renderToStaticMarkup(createElement(TrackedAskCard, { request, target: null, withTarget: true }));
    const request = { messageId: "m", flightId: "f", targetActorId: "codex", state: "completed", requesterActorId: "maya", requesterName: "Maya", output: "Tests passed", outputTruncated: true };
    const complete = render(request);
    expect(complete).toContain("<dt>Requested by</dt><dd>Maya</dd>");
    expect(complete).toContain("Done");
    expect(complete).toContain("Recorded outcome");
    expect(complete).toContain("Tests passed");
    expect(complete).toContain("Preview limited");
    expect(render({ ...request, outputUrl: "/api/channels/c/asks/f/output" })).toContain('href="/api/channels/c/asks/f/output"');
    expect(render({ ...request, outputUrl: "https://example.com/outcome" })).not.toContain("Read full outcome");
    expect(render({ ...request, outputUrl: "javascript:alert(1)" })).not.toContain("Read full outcome");
    expect(complete).not.toContain("Stop");
    const responsibility = { recordId: "q", kind: "question" as const, state: "answered", title: "Release approval", settled: false, actorId: "maya", actorName: "Maya", answer: "Release two" };
    const review = render({ ...request, responsibility });
    expect(review).toContain("Waiting on Maya to review the answer");
    expect(review).not.toContain('data-needs-you');
    expect(review).toContain("Release two");
    expect(render({ ...request, responsibility: { ...responsibility, actions: ["close", "reopen"] } })).toContain("Answer ready for your review");
    const closed = render({ ...request, responsibility: { ...responsibility, settled: true, state: "closed" } });
    expect(closed).not.toContain("Waiting on Maya");
    expect(closed).toContain("Question · closed");
    expect(render({ ...request, state: "waiting" })).toContain("next actor is not available");
    expect(render({ ...request, output: undefined })).toContain("Completed without a recorded outcome");
  });

  test("a queued flight stays queued even when the roster is unavailable", () => {
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
    expect(html).toContain("Queued for");
    expect(html).not.toContain("blocked");
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
    expect(html).toContain("Couldn&#x27;t finish");
    expect(html).not.toContain("Stop");
    const withError = renderToStaticMarkup(createElement(TrackedAskCard, {
      request: { messageId: "m1", flightId: "flight-1", state: "failed", targetActorId: "actor-codex", error: "exit 1" },
      target: codex(),
      withTarget: true,
    }));
    expect(withError).toContain("Maya&#x27;s Codex couldn&#x27;t finish");
    expect(withError).toContain('class="chat-ask-error" role="alert"');
    expect(withError).toContain("exit 1");
  });

  test("a queued ask offers cancellation", () => {
    const html = renderToStaticMarkup(
      createElement(TrackedAskCard, {
        request: {
          messageId: "m1",
          flightId: "flight-1",
          state: "queued",
          targetActorId: "actor-codex",
        },
        target: codex(),
        withTarget: true,
        onStop: () => {},
      }),
    );
    expect(html).toContain("Queued for Maya&#x27;s Codex");
    expect(html).toContain("Cancel request");
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

  test("http urls in the body become links", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBody, {
        message: message({
          id: "m-url",
          body: "repo: https://github.com/arach/openscout.",
        }),
      }),
    );
    expect(html).toContain('class="chat-url"');
    expect(html).toContain('href="https://github.com/arach/openscout"');
    expect(html).toContain("repo: ");
  });

  test("markdown blocks and inline marks render, mentions stay record-only", () => {
    const html = renderToStaticMarkup(
      createElement(MessageBody, {
        message: message({
          id: "m-md",
          body: [
            "### Notes",
            "",
            "See **bold** and `code` for @Maya's Codex and @nobody.",
            "",
            "- one",
            "- two",
            "",
            "```ts",
            "const n = 1;",
            "```",
          ].join("\n"),
          mentions: [{ actorId: "actor-codex", label: "Maya's Codex" }],
        }),
      }),
    );
    expect(html).toContain("chat-md-h");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("chat-md-code");
    expect(html).toContain("chat-md-list");
    expect(html).toContain("chat-md-pre");
    expect(html).toContain("const n = 1;");
    expect(html).toContain('<span class="chat-mention">@Maya&#x27;s Codex</span>');
    expect(html).not.toContain('<span class="chat-mention">@nobody</span>');
  });
});
