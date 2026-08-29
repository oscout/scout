import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");
const { renderToStaticMarkup } = ReactDomServer;

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const { fileRenderers } = await import("./index.ts");

describe("fileRenderers", () => {
  test("renders HTML files as browser previews before code fallback", () => {
    const resource = {
      kind: "file" as const,
      previewable: true as const,
      path: ".data/report.html",
      realPath: "/Users/art/dev/openscout/.data/report.html",
      rootPath: "/Users/art/dev/openscout",
      title: "report.html",
      mediaType: "text/html",
      rawUrl: "/api/file/raw/Users/art/dev/openscout/.data/report.html",
      content: "<!doctype html><title>Report</title>",
      sizeBytes: 128,
      truncated: false,
      generatedAt: 1,
    };

    const renderer = fileRenderers.find((candidate) => candidate.canHandle(resource));
    const html = renderToStaticMarkup(renderer?.render({ resource, openFilePreview: () => {} }));

    expect(renderer?.id).toBe("html");
    expect(html).toContain("s-file-preview-html-frame");
    expect(html).toContain("src=\"/api/file/raw/Users/art/dev/openscout/.data/report.html\"");
    expect(html).toContain("sandbox=\"allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts\"");
  });
});
