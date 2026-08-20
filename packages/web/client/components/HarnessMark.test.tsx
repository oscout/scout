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

const { HarnessMark, harnessLabel, normalizeHarnessKey } = await import("./HarnessMark.tsx");

describe("HarnessMark", () => {
  test("folds Kimi Code and Moonshot aliases into one harness identity", () => {
    expect(normalizeHarnessKey("kimi-acp")).toBe("kimi");
    expect(normalizeHarnessKey("Kimi Code")).toBe("kimi");
    expect(normalizeHarnessKey("moonshot-ai")).toBe("kimi");
    expect(harnessLabel("kimi_acp")).toBe("Kimi");
  });

  test("renders Kimi's dedicated angular mark instead of the letter fallback", () => {
    const html = renderToStaticMarkup(createElement(HarnessMark, {
      harness: "kimi",
      size: 14,
    }));

    expect(html).toContain("aria-label=\"Kimi\"");
    expect(html).toContain("<circle cx=\"20.2\" cy=\"3.8\" r=\"1.8\"");
    expect(html).not.toContain("<text");
  });

  test("folds oh-my-pi's labels into the Pi harness identity", () => {
    expect(normalizeHarnessKey("omp")).toBe("pi");
    expect(normalizeHarnessKey("oh-my-pi")).toBe("pi");
  });
});
