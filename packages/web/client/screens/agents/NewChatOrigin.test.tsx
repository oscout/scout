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

const { NewChatOrigin } = await import("./NewChatOrigin.tsx");

const noop = () => {};
const PAGE = [
  { label: "Page", value: "Agents — openscout" },
  { label: "URL", value: "https://scout.test/agents" },
];

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(NewChatOrigin, {
    context: PAGE, selection: "", attached: false, onToggleSelection: noop, ...props,
  }));
}

describe("NewChatOrigin", () => {
  test("renders nothing when there is no context to state", () => {
    expect(render({ context: [] })).toBe("");
  });

  test("states each captured fact so the sender can read it before sending", () => {
    const html = render({});
    expect(html).toContain("Agents — openscout");
    expect(html).toContain("https://scout.test/agents");
    expect(html).toContain(">Page<");
    expect(html).toContain(">URL<");
  });

  test("offers no attach control when nothing was selected", () => {
    expect(render({ selection: "" })).not.toContain("s-newchat-origin-attach");
  });

  test("offers selection as an opt-in, unpressed, with its size stated", () => {
    const html = render({ selection: "boom".repeat(10) });
    expect(html).toContain("s-newchat-origin-attach");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Attach selection (40 chars)");
  });

  test("a captured selection is never rendered until it is attached", () => {
    const secret = "PRIVATE-SELECTION-TEXT";
    expect(render({ selection: secret })).not.toContain(secret);
  });

  test("flips to a remove affordance once attached", () => {
    const html = render({
      selection: "boom",
      attached: true,
      context: [...PAGE, { label: "Selection", value: "boom" }],
    });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Remove selection");
  });
});
