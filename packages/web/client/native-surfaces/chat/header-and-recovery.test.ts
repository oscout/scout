import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./scout-chat.css", import.meta.url), "utf8");

describe("chat header controls", () => {
  it("uses one matched Back and Search control geometry", () => {
    expect(css).toContain(".back-button, .header-actions button");
    expect(css).toMatch(/\.back-button, \.header-actions button \{[^}]*width: 44px;[^}]*height: 44px;/s);
    expect(css).toMatch(/\.back-button svg, \.header-actions svg \{[^}]*width: 18px;[^}]*height: 18px;/s);
    expect(main).not.toContain("back-label");
  });

  it("prevents transcript content from widening the header axis", () => {
    expect(css).toMatch(/\.chat-app > \* \{[^}]*min-width: 0;/s);
    expect(css).toMatch(/\.contact-button \{[^}]*right: 0;[^}]*left: 0;[^}]*margin-inline: auto;/s);
  });
});

describe("conversation recovery", () => {
  it("keeps retry separate from the alert surface", () => {
    expect(main).toContain('<div className="inline-error" role="alert"');
    expect(main).toContain("Can’t reach this conversation");
    expect(main).toContain('<button type="button" onClick={() => void refresh()}>Retry</button>');
    expect(main).not.toContain('<button className="inline-error"');
  });

  it("does not cover the conversation with a gesture tutorial", () => {
    expect(main).not.toContain("gestureHintVisible");
    expect(main).not.toContain("Reactions and replies");
  });

  it("does not turn the whole unavailable state into a danger fill", () => {
    const rule = /\.inline-error \{([^}]*)\}/s.exec(css)?.[1] ?? "";
    expect(rule).toContain("background: var(--chrome)");
    expect(rule).not.toContain("#fdebe9");
  });
});
