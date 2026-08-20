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
mock.module("motion/react", () => ({
  LazyMotion: ({ children }: { children: unknown }) => children,
  m: {
    span: ({ children, initial: _initial, animate: _animate, transition: _transition, ...props }: Record<string, unknown>) =>
      createElement("span", props, children),
  },
  useReducedMotion: () => true,
}));

const {
  ObserveReasoningDisclosure,
  ObserveStreamCursor,
} = await import("./ObserveTextFlow.tsx");

describe("observed text flow", () => {
  test("marks the real stream edge without replaying its text", () => {
    const html = renderToStaticMarkup(createElement(ObserveStreamCursor, {
      text: "A harness-owned chunk",
    }));

    expect(html).toContain("s-observe-stream-cursor");
    expect(html).toContain('data-receiving="true"');
    expect(html).not.toContain("A harness-owned chunk");
  });

  test("keeps live reasoning open while it is arriving", () => {
    const html = renderToStaticMarkup(createElement(ObserveReasoningDisclosure, {
      text: "Inspecting the request before choosing the narrowest safe change.",
      live: true,
    }));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Thinking");
    expect(html).toContain("Inspecting the request");
    expect(html).toContain("s-observe-stream-cursor");
  });

  test("folds completed reasoning into an accessible summary", () => {
    const html = renderToStaticMarkup(createElement(ObserveReasoningDisclosure, {
      text: "First inspect the request. Then verify the implementation details. Finally run the focused checks and report the result without inventing state.",
      live: false,
      compact: true,
    }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Show reasoning"');
    expect(html).toContain("Reasoning");
    expect(html).toContain("First inspect the request");
    expect(html).toContain('aria-hidden="true"');
  });
});
