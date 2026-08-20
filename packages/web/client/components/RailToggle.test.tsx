import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../node_modules/react-dom/server.node.js");
const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const {
  RailToggle,
  railToggleChevron,
  railToggleLabel,
} = await import("./RailToggle.tsx");

describe("RailToggle pure helpers (SCO-086)", () => {
  test("left rail chevrons: collapsed ›, expanded ‹", () => {
    expect(railToggleChevron("left", true)).toBe("›");
    expect(railToggleChevron("left", false)).toBe("‹");
  });

  test("right rail chevrons: collapsed ‹, expanded ›", () => {
    expect(railToggleChevron("right", true)).toBe("‹");
    expect(railToggleChevron("right", false)).toBe("›");
  });

  test("labels include panel name", () => {
    expect(railToggleLabel(true, "Sidebar")).toBe("Expand Sidebar");
    expect(railToggleLabel(false, "Inspector")).toBe("Collapse Inspector");
    expect(railToggleLabel(true)).toBe("Expand panel");
  });
});

describe("RailToggle rendering (SCO-086)", () => {
  test("renders edge chevron button without HudsonKit or shadcn imports", () => {
    const html = renderToStaticMarkup(
      createElement(RailToggle, {
        side: "left",
        collapsed: true,
        label: "Sidebar",
        onToggle: () => {},
      }),
    );

    expect(html).toContain('data-scout-rail-toggle=""');
    expect(html).toContain('data-side="left"');
    expect(html).toContain('data-direction="right"');
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('aria-label="Expand Sidebar"');
    expect(html).toContain("<svg");
    expect(html).toContain("M6 4.5 9.5 8 6 11.5");
    expect(html).not.toContain("data-sidebar");
    expect(html).not.toContain("data-hudson");
  });

  test("expanded right rail shows collapse chevron", () => {
    const html = renderToStaticMarkup(
      createElement(RailToggle, {
        side: "right",
        collapsed: false,
        label: "Inspector",
        onToggle: () => {},
      }),
    );

    expect(html).toContain('data-collapsed="false"');
    expect(html).toContain('data-direction="right"');
    expect(html).toContain('aria-label="Collapse Inspector"');
    expect(html).toContain("M6 4.5 9.5 8 6 11.5");
  });
});
