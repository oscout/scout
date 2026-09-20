/**
 * The composer's polish is only polish if the boundary still shows and every
 * control in the toolbar is real. These tests pin both: the structure a person
 * sees (roomy field, quiet toolbar, round send) and the promise the surface
 * makes (no affordance that does nothing, formatting the feed can paint,
 * no send that fires on an empty draft).
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

import type { ChannelMemberReception, ChannelMemberView } from "./chat-api.ts";

const { ChannelComposer, mentionInsertion } = await import("./ChannelComposer.tsx");

const NOW = new Date(2026, 8, 16, 14, 0, 0, 0).getTime();

const reception = (overrides: Partial<ChannelMemberReception> = {}): ChannelMemberReception => ({
  state: "ready_to_receive",
  routeKind: "persistent",
  listening: true,
  summary: "Ready to receive",
  detail: "Attached to session ses-1 over a persistent route.",
  evidenceAt: NOW - 120_000,
  attachedSessionId: "ses-1",
  redeemedAt: NOW - 3_600_000,
  ...overrides,
});

const maya: ChannelMemberView = {
  actorId: "actor-maya",
  kind: "person",
  displayName: "Maya",
  reception: reception({ routeKind: "none", listening: false, state: "waiting_for_agent" }),
};

const codex: ChannelMemberView = {
  actorId: "actor-codex",
  kind: "agent",
  displayName: "Codex",
  harness: "codex",
  owner: { actorId: "actor-maya", displayName: "Maya" },
  reception: reception(),
};

const composer = (overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(ChannelComposer, {
      members: [maya, codex],
      draft: "",
      onDraftChange: () => {},
      askTargetId: null,
      onAskTargetChange: () => {},
      onSend: () => {},
      sending: false,
      error: null,
      placeholder: "Message #build",
      ...overrides,
    }),
  );

describe("ChannelComposer toolbar", () => {
  test("is a roomy field over a quiet toolbar, closed by a round send", () => {
    const html = composer();
    expect(html).toContain('class="chat-composer" data-variant="channel"');
    expect(html).toContain('class="chat-composer-input"');
    expect(html).toContain('class="chat-composer-tools"');
    expect(html).toContain('class="chat-composer-send"');
    // The send is the only filled control; the toolbar carries no button box.
    expect(html).not.toContain("btn--primary");
  });

  test("carries no affordance that does nothing", () => {
    const html = composer().toLowerCase();
    expect(html).toContain("attach a file");
    // No emoji or voice control: none of them is wired to anything.
    for (const absent of ["emoji", "record", "microphone", "voice"]) {
      expect(html).not.toContain(absent);
    }
    for (const absent of ["strikethrough", "blockquote", "code block"]) {
      expect(html).not.toContain(absent);
    }
    expect(html).toContain('aria-label="bold"');
    expect(html).toContain('aria-label="italic"');
    expect(html).toContain('aria-label="code"');
    expect(html).toContain('aria-label="list"');
  });

  test("the send does not fire on an empty draft without files, and wakes on text", () => {
    expect(composer({ draft: "" })).toContain(
      '<button type="button" class="chat-composer-send" disabled=""',
    );
    expect(composer({ draft: "   \n  " })).toContain(
      '<button type="button" class="chat-composer-send" disabled=""',
    );
    const ready = composer({ draft: "ship it" });
    expect(ready).toContain('class="chat-composer-send"');
    expect(ready).not.toContain('class="chat-composer-send" disabled=""');
  });

  test("an icon-only control still says what it is", () => {
    const html = composer();
    expect(html).toContain('aria-label="Mention a member"');
    expect(html).toContain('title="Mention a member"');
    expect(html).toContain('aria-label="Send to the channel"');
  });

  test("sending is visible on the send itself, and nothing else claims it", () => {
    const html = composer({ draft: "ship it", sending: true });
    expect(html).toContain("chat-composer-spin");
    expect(html).toContain('aria-label="Sending…"');
    expect(html).toContain('class="chat-composer-send" disabled=""');
    // The field and the tools go with it — no half-editable composer.
    expect(html).toMatch(/class="chat-composer-input"[^>]*aria-disabled="true"/u);
    expect(html).toMatch(/class="chat-composer-tool chat-composer-tool--icon" disabled=""/u);
  });

  test("a send failure gets its own line instead of squeezing the toolbar", () => {
    const html = composer({ draft: "ship it", error: "That did not send." });
    expect(html).toContain('<p class="chat-send-error" role="alert">That did not send.</p>');
  });
});

describe("ChannelComposer routing boundary", () => {
  test("untargeted: the ask selector reads as an invitation, not a warning", () => {
    const html = composer();
    expect(html).toContain("Ask an agent");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    // Nothing is asked yet, so nothing is claimed about tracked work.
    expect(html).not.toContain("Creates a tracked request");
    expect(html).not.toContain("chat-ask-target");
  });

  test("targeted: the chip names the agent and the hint states the boundary", () => {
    const html = composer({ draft: "check the build", askTargetId: "actor-codex" });
    expect(html).toContain("Asking");
    expect(html).toContain("Maya&#x27;s Codex");
    expect(html).toContain("Creates a tracked request for Maya&#x27;s Codex");
    expect(html).toContain("reply lands in this thread");
    expect(html).toContain("Change agent");
    // Send says where it is going, and the target stays clearable.
    expect(html).toContain("aria-label=\"Send — asks Maya&#x27;s Codex\"");
    expect(html).toContain("Clear ask target");
  });

  test("thread: one reply target, so no ask selector and no channel hint", () => {
    const html = composer({ variant: "thread", placeholder: "Reply in thread…" });
    expect(html).toContain('data-variant="thread"');
    expect(html).not.toContain("Ask an agent");
    expect(html).not.toContain("Change agent");
    expect(html).toContain("↵ send");
    expect(html).not.toContain("⇧↵ newline");
    // Mentioning a member is still real in a thread: the feed highlights it.
    expect(html).toContain('aria-label="Mention a member"');
    expect(html).toContain('aria-label="Send reply"');
  });
});

describe("mentionInsertion", () => {
  test("an empty draft just gets the @", () => {
    expect(mentionInsertion("", 0)).toEqual({ next: "@", caret: 1 });
  });

  test("mid-word, it supplies the space the token needs to be recognised", () => {
    expect(mentionInsertion("hi", 2)).toEqual({ next: "hi @", caret: 4 });
  });

  test("after whitespace, it adds none of its own", () => {
    expect(mentionInsertion("hi ", 3)).toEqual({ next: "hi @", caret: 4 });
    expect(mentionInsertion("hi\n", 3)).toEqual({ next: "hi\n@", caret: 3 + 1 });
  });

  test("it types at the caret, not at the end", () => {
    expect(mentionInsertion("hi there", 2)).toEqual({ next: "hi @ there", caret: 4 });
  });

  test("a caret outside the draft is clamped, never used to slice past the end", () => {
    expect(mentionInsertion("hi", 99)).toEqual({ next: "hi @", caret: 4 });
    expect(mentionInsertion("hi", -1)).toEqual({ next: "@hi", caret: 1 });
  });
});
