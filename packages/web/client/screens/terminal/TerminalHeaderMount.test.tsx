import { describe, expect, mock, test } from "bun:test";
import type * as ReactModule from "react";
import type * as ReactJsxRuntimeModule from "react/jsx-runtime";
import type * as ReactJsxDevRuntimeModule from "react/jsx-dev-runtime";
import type * as ReactDomServerModule from "react-dom/server";

// Keep Bun on the runtime modules instead of the local TS declaration aliases.
// @ts-expect-error -- untyped relative runtime import
const React = (await import("../../../node_modules/react/index.js")) as typeof ReactModule;
// @ts-expect-error -- untyped relative runtime import
const ReactJsxRuntime = (await import("../../../node_modules/react/jsx-runtime.js")) as typeof ReactJsxRuntimeModule;
// @ts-expect-error -- untyped relative runtime import
const ReactJsxDevRuntime = (await import("../../../node_modules/react/jsx-dev-runtime.js")) as typeof ReactJsxDevRuntimeModule;
// @ts-expect-error -- untyped relative runtime import
const ReactDomServer = (await import("../../../node_modules/react-dom/server.node.js")) as typeof ReactDomServerModule;

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));

const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const { TerminalHeaderMount } = await import("./TerminalHeaderMount.tsx");

describe("TerminalHeaderMount", () => {
  test("keeps task-completing controls in content when no title-row host exists", () => {
    const html = renderToStaticMarkup(createElement(
      TerminalHeaderMount,
      null,
      createElement("button", { type: "button" }, "Create"),
    ));

    expect(html).toContain("data-scout-terminal-header-fallback");
    expect(html).toContain(">Create</button>");
  });
});
