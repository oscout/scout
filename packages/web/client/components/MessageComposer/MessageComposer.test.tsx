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

const { MessageComposer } = await import("./MessageComposer.tsx");
const { MessageComposerEmbedBoundary } = await import("./MessageComposerEmbedBoundary.tsx");
const { MessageComposerSuggestions } = await import("./MessageComposerSuggestions.tsx");

describe("MessageComposer overlays", () => {
  test("renders suggestions outside the clipped composer shell", () => {
    const html = renderToStaticMarkup(createElement(MessageComposer, {
      value: "/",
      onChange: () => undefined,
      onSend: () => undefined,
      showDictation: false,
      overlay: createElement("div", { role: "listbox" }, "Slash commands"),
    }));

    const frameStart = html.indexOf('class="s-msg-compose-frame"');
    const overlayStart = html.indexOf('role="listbox"');
    const shellStart = html.indexOf('class="s-msg-compose-shell"');
    expect(frameStart).toBeGreaterThanOrEqual(0);
    expect(overlayStart).toBeGreaterThan(frameStart);
    expect(shellStart).toBeGreaterThan(overlayStart);
    expect(html).toContain(
      'role="listbox">Slash commands</div><div class="s-msg-compose-shell"',
    );
  });

  test("marks suggestions that should stay inside a modal composer", () => {
    const html = renderToStaticMarkup(createElement(MessageComposerSuggestions, {
      label: "Mention agent",
      items: [{ id: "arach", token: "@arach", description: "Arach" }],
      activeIndex: 0,
      placement: "inside",
      onPick: () => undefined,
      onActiveIndexChange: () => undefined,
    }));

    expect(html).toContain('data-placement="inside"');
    expect(html).toContain('aria-label="Mention agent"');
  });
});

describe("MessageComposer embed ownership", () => {
  test("drops the shared composer anywhere inside an embed boundary", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageComposerEmbedBoundary,
        null,
        createElement(MessageComposer, {
          value: "",
          onChange: () => undefined,
          onSend: () => undefined,
          showDictation: false,
        }),
      ),
    );

    expect(html).toBe("");
  });

  test("supports an explicit embed-owned composer", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageComposerEmbedBoundary,
        null,
        createElement(MessageComposer, {
          value: "",
          onChange: () => undefined,
          onSend: () => undefined,
          showDictation: false,
          renderWhenEmbedded: true,
        }),
      ),
    );

    expect(html).toContain('class="s-msg-compose');
  });
});
