import { describe, expect, mock, test } from "bun:test";
import type { MessageAttachment } from "../lib/types.ts";

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

const { MessageEmbeds } = await import("./MessageEmbeds.tsx");

function renderMessage(body: string, attachments: MessageAttachment[] = []) {
  return renderToStaticMarkup(createElement(MessageEmbeds, {
    message: {
      id: "message-1",
      conversationId: "conversation-1",
      actorName: "Arach",
      body,
      createdAt: 1_700_000_000_000,
      class: "chat",
      attachments,
    },
  }));
}

describe("MessageEmbeds", () => {
  test("does not fabricate a rich preview for a bare URL", () => {
    const url = "http://127.0.0.1:43120/api/blobs/blob-1";

    expect(renderMessage(`Screenshot: ${url}`)).toBe("");
  });

  test("still embeds a bare URL that names an image", () => {
    const url = "https://example.com/screenshot.png";
    const html = renderMessage(url);

    expect(html).toContain('class="s-message-embed s-message-embed--image"');
    expect(html).toContain(`src="${url}"`);
  });

  test("does not duplicate an image attachment whose URL also appears in the body", () => {
    const url = "http://127.0.0.1:43120/api/blobs/blob-1";
    const html = renderMessage(url, [{
      id: "attachment-1",
      mediaType: "image/png",
      fileName: "screenshot.png",
      url,
    }]);

    expect(html.match(/s-message-embed--image/g)).toHaveLength(1);
    expect(html).not.toContain("s-message-embed--link");
  });

  test("renders a blob image attachment through a same-origin path", () => {
    const html = renderMessage("Capture", [{
      id: "attachment-1",
      mediaType: "image/png",
      fileName: "capture.png",
      url: "http://scout.local/api/blobs/blob-1",
    }]);

    expect(html).toContain('src="/api/blobs/blob-1"');
    expect(html).not.toContain("http://scout.local");
  });

  test("leaves non-blob image URLs on their own origin", () => {
    const url = "https://example.com/screenshot.png";
    const html = renderMessage("Shot", [{
      id: "attachment-1",
      mediaType: "image/png",
      url,
    }]);

    expect(html).toContain(`src="${url}"`);
  });

  test("renders link attachments that carry real preview metadata", () => {
    const html = renderMessage("Release notes", [{
      id: "attachment-1",
      mediaType: "text/x-uri",
      url: "https://example.com/releases/1",
      metadata: {
        title: "OpenScout 1.0",
        description: "Release notes",
        siteName: "OpenScout",
      },
    }]);

    expect(html).toContain("s-message-embed--link");
    expect(html).toContain("OpenScout 1.0");
    expect(html).toContain("Release notes");
  });
});
