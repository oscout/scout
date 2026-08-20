import { describe, expect, mock, test } from "bun:test";

import type { ScoutbotAssistantSessionState } from "./scoutbot-model.ts";

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
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));

const { ChatHistory } = await import("./ScoutbotChat.tsx");

const state: ScoutbotAssistantSessionState = {
  session: {
    id: "session-current",
    title: "Dispatch failures",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    model: "gpt-test",
    messageCount: 1,
    messages: [{
      id: "message-1",
      role: "user",
      body: "First failed example",
      createdAt: 1_700_000_001_000,
    }],
  },
  sessions: [{
    id: "session-current",
    title: "Dispatch failures",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    model: "gpt-test",
    messageCount: 1,
  }],
  config: {
    editable: true,
    model: "gpt-test",
    systemPrompt: "test",
  },
};

function renderHistory(startingNewChat = false): string {
  return renderToStaticMarkup(
    createElement(ChatHistory, {
      state,
      chatExpanded: true,
      onToggleExpanded: () => undefined,
      sessionPickerOpen: false,
      onToggleSessionPicker: () => undefined,
      onStartNewChat: () => undefined,
      startingNewChat,
      onSwitchSession: () => undefined,
      switchingSessionId: null,
      sending: false,
      briefing: false,
      pendingAsk: null,
      onArchiveSession: () => undefined,
      archivingSessionId: null,
    }),
  );
}

describe("ChatHistory", () => {
  test("offers a first-class new chat action beside the chat picker", () => {
    const html = renderHistory();

    expect(html).toContain('aria-label="Start new chat"');
    expect(html).toContain("Start a new chat (keeps this chat in Chats)");
    expect(html).toContain("New chat");
    expect(html).toContain('aria-label="Switch chat"');
    expect(html).toContain("Chats");
  });

  test("disables the action while a new chat is being created", () => {
    const html = renderHistory(true);

    expect(html).toContain('aria-label="Start new chat"');
    expect(html).toContain("Starting");
    expect(html).toContain("disabled");
  });
});
