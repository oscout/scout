import { describe, expect, mock, test } from "bun:test";

import type { FleetAttentionItem } from "../../lib/types.ts";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));

const { createElement } = React;
const { renderToStaticMarkup } = ReactDomServer;
const { NeedsAttentionSection, selectNeedsAttentionItems } = await import("./left.tsx");

function attentionItem(recordId: string, updatedAt: number): FleetAttentionItem {
  return {
    kind: "work_item",
    recordId,
    title: `Attention ${recordId}`,
    summary: null,
    agentId: "agent-1",
    agentName: "Agent One",
    conversationId: "conversation-1",
    state: "review",
    acceptanceState: "pending",
    updatedAt,
  };
}

describe("home needs-attention rail", () => {
  test("selects the longest-waiting rows first", () => {
    const selection = selectNeedsAttentionItems([
      attentionItem("newest", 400),
      attentionItem("oldest", 100),
      attentionItem("middle-new", 300),
      attentionItem("middle-old", 200),
    ], new Set());

    expect(selection.items.map((item) => item.recordId)).toEqual([
      "oldest",
      "middle-old",
      "middle-new",
    ]);
    expect(selection.totalCount).toBe(4);
  });

  test("renders the collapsed total when the rail cap truncates rows", () => {
    const selection = selectNeedsAttentionItems([
      attentionItem("four", 400),
      attentionItem("one", 100),
      attentionItem("three", 300),
      attentionItem("two", 200),
    ], new Set());
    const html = renderToStaticMarkup(createElement(NeedsAttentionSection, {
      items: selection.items,
      totalCount: selection.totalCount,
      loading: false,
      onSelect: () => undefined,
      onDismiss: () => undefined,
    }));

    expect(html).toContain('<span class="ctx-panel-count">4</span>');
    expect(html).not.toContain("Attention four");
    expect(html.indexOf("Attention one")).toBeLessThan(html.indexOf("Attention two"));
    expect(html.indexOf("Attention two")).toBeLessThan(html.indexOf("Attention three"));
  });
});
