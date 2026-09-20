import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../node_modules/react-dom/server.node.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const { ScoutShimmerMark } = await import("./ScoutShimmerMark.tsx");

function dotCount(html: string): number {
  return html.split("scout-shimmer-dot").length - 1;
}

describe("ScoutShimmerMark", () => {
  test("draws a real dot field, not a token handful", () => {
    const html = renderToStaticMarkup(createElement(ScoutShimmerMark, {}));
    // The hex outline plus the inner hex. A wrong falloff or radius collapses
    // this to a few dozen dots, which is what the count is here to catch.
    expect(dotCount(html)).toBeGreaterThan(100);
  });

  test("is decorative: hidden from the accessibility tree, no text glyphs", () => {
    const html = renderToStaticMarkup(createElement(ScoutShimmerMark, {}));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<text");
  });

  test("carries a per-dot crest alpha and a column-staggered delay", () => {
    const html = renderToStaticMarkup(createElement(ScoutShimmerMark, {}));
    expect(html).toContain("--shimmer-peak");
    // The wave is a stagger, so the delays must differ across the field.
    const delays = new Set(html.match(/animation-delay:-[0-9.]+s/g) ?? []);
    expect(delays.size).toBeGreaterThan(8);
  });

  test("scales the box to the requested width", () => {
    const html = renderToStaticMarkup(createElement(ScoutShimmerMark, { width: 234 }));
    expect(html).toContain("width:234px");
  });
});
