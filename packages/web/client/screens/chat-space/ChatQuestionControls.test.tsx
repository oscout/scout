import { expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");
const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;

const { ChatQuestionControls, ChatQuestionResponder } = await import("./ChatQuestionControls.tsx");
const { mergeChatRequestResponsibilities } = await import("./chat-request-state.ts");
import type { TrackedRequest } from "./chat-api.ts";

const question = { recordId: "q", kind: "question" as const, state: "open", title: "Which release?", settled: false, updatedAt: 1, actions: ["answer" as const] };
const render = (value: NonNullable<TrackedRequest["responsibility"]>) => renderToStaticMarkup(createElement(ChatQuestionResponder.Provider, { value: async () => {} }, createElement(ChatQuestionControls, { question: value })));

test("response controls follow explicit actions and backend support", () => {
  expect(render(question)).toContain("Send answer");
  expect(render(question)).not.toContain("Accept answer");
  expect(render({ ...question, state: "answered", actions: ["close", "reopen"] })).toContain("Accept answer");
  expect(render({ ...question, actions: [] })).toBe("");
  expect(renderToStaticMarkup(createElement(ChatQuestionControls, { question }))).toBe("");
});

test("an older feed cannot revert an acknowledged answer", () => {
  const request: TrackedRequest = { flightId: "f", messageId: "m", targetActorId: "agent", state: "completed", responsibility: question };
  const accepted = { ...question, state: "closed", settled: true, updatedAt: 3, actions: [] };
  expect(mergeChatRequestResponsibilities([{ ...request, responsibility: accepted }], [request])[0]?.responsibility).toBe(accepted);
  expect(mergeChatRequestResponsibilities([request], [{ ...request, responsibility: accepted }])[0]?.responsibility).toBe(accepted);
  expect(mergeChatRequestResponsibilities([request], [{ ...request, responsibility: undefined }])[0]?.responsibility).toBeUndefined();
});
