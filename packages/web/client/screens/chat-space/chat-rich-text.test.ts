import { describe, expect, test } from "bun:test";

import { htmlToMarkdown, markdownToHtml } from "./chat-rich-text.ts";

describe("markdownToHtml", () => {
  test("paints the marks the feed can show", () => {
    const html = markdownToHtml("See **bold** and `code`.\n\n- one\n- two");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<code class="chat-md-code">code</code>');
    expect(html).toContain("<ul");
    expect(html).toContain("<li>");
  });

  test("escapes raw html in the draft", () => {
    expect(markdownToHtml("a <script>alert(1)</script> b")).not.toContain("<script>");
    expect(markdownToHtml("a <script>alert(1)</script> b")).toContain("&lt;script&gt;");
  });

  test("fences stay pre/code", () => {
    const html = markdownToHtml("```ts\nconst n = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("const n = 1;");
  });
});

describe("htmlToMarkdown", () => {
  test("round-trips the marks the composer paints", () => {
    if (typeof document === "undefined") return;
    const root = document.createElement("div");
    root.innerHTML = markdownToHtml("See **bold** and *em* and `code`.");
    expect(htmlToMarkdown(root)).toContain("**bold**");
    expect(htmlToMarkdown(root)).toContain("*em*");
    expect(htmlToMarkdown(root)).toContain("`code`");
  });

  test("lists become markdown lists", () => {
    if (typeof document === "undefined") return;
    const root = document.createElement("div");
    root.innerHTML = "<ul><li>one</li><li>two</li></ul>";
    const markdown = htmlToMarkdown(root);
    expect(markdown).toContain("- one");
    expect(markdown).toContain("- two");
  });
});
