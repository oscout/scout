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

const { createTextDocument, TextDocumentSurface } = await import("./TextDocumentSurface.tsx");

describe("TextDocumentSurface", () => {
  test("highlights TypeScript code previews", () => {
    const document = createTextDocument({
      id: "preview",
      filename: "page.tsx",
      mediaType: "text/typescript",
      value: "const url = \"http://localhost:3500/talkie-marks\";\nreturn url;",
      kind: "code",
      readOnly: true,
    });

    const html = renderToStaticMarkup(createElement(TextDocumentSurface, { document, mode: "read" }));

    expect(html).toContain("s-syntax-keyword");
    expect(html).toContain("s-syntax-string");
    expect(html).toContain("http://localhost:3500/talkie-marks");
  });

  test("renders inline markdown emphasis in preview mode", () => {
    const document = createTextDocument({
      id: "agent-md",
      filename: "AGENT.md",
      mediaType: "text/markdown",
      value: "Use **bold**, *italic*, `code`, ~~old~~ and a [link](https://example.com). Keep file_name literal.",
      kind: "markdown",
      readOnly: true,
    });

    const html = renderToStaticMarkup(createElement(TextDocumentSurface, { document, mode: "preview" }));

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain("href=\"https://example.com\"");
    // snake_case must not be italicized (underscore opens only at a word boundary)
    expect(html).toContain("file_name");
    expect(html).not.toContain("<em>name</em>");
  });

  test("renders markdown pipe tables in preview mode", () => {
    const document = createTextDocument({
      id: "proposal-md",
      filename: "proposal.md",
      mediaType: "text/markdown",
      value: [
        "| Term | Meaning | Count |",
        "|:-----|---------|------:|",
        "| **Harness** | Uses `codex` or `claude` | 2 |",
      ].join("\n"),
      kind: "markdown",
      readOnly: true,
    });

    const html = renderToStaticMarkup(createElement(TextDocumentSurface, { document, mode: "preview" }));

    expect(html).toContain("s-text-document-table");
    expect(html).toContain("<th data-align=\"left\">Term</th>");
    expect(html).toContain("<th data-align=\"right\">Count</th>");
    expect(html).toContain("<strong>Harness</strong>");
    expect(html).toContain("<code>codex</code>");
    expect(html).not.toContain("|:-----|");
  });
});
