import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileAuthoritativeMessages } from "./chat-runtime.ts";

/** F9 (send → optimistic → ack/failure/retry) and F10 (incoming insertion,
 * pinned vs scrolled-up, jump-to-latest). */

const dir = import.meta.dir;
const css = readFileSync(join(dir, "scout-chat.css"), "utf8");
const main = readFileSync(join(dir, "main.tsx"), "utf8");

function ruleFor(source: string, selector: string) {
  const index = source.indexOf(selector);
  if (index === -1) return null;
  const open = source.indexOf("{", index);
  const close = source.indexOf("}", open);
  return open === -1 || close === -1 ? null : source.slice(open + 1, close);
}

describe("F9 — send, acknowledge, fail, retry", () => {
  it("inserts optimistically and replaces by clientMessageId, not by position", () => {
    // Matching on the client id is what stops an ack from duplicating the
    // message or reordering the tail under the reader.
    const echoed = { id: "persisted", clientMessageId: "client-1" };
    const replaced = { id: "optimistic", clientMessageId: "client-1", optimistic: true };
    const pending = { id: "pending", clientMessageId: "client-2", optimistic: true };

    expect(reconcileAuthoritativeMessages([replaced, pending], [echoed])).toEqual([echoed, pending]);
    expect(main.includes("reconcileAuthoritativeMessages(current, authoritative)")).toBe(true);
  });

  it("distinguishes a refusal from an unconfirmed write", () => {
    // These are different truths: one was rejected, the other may have landed.
    // Collapsing them would make the retry a lie in one direction or the other.
    expect(main.includes('deliveryIssue: "failed"')).toBe(true);
    expect(main.includes('deliveryIssue: "unconfirmed"')).toBe(true);
  });

  it("offers a retry that reuses the original client id", () => {
    expect(main.includes("setRetryClientMessageId(")).toBe(true);
  });

  it("keeps the retry affordance at a thumb-sized target", () => {
    const mark = ruleFor(css, ".delivery-issue-mark");
    expect(mark).not.toBeNull();
  });
});

describe("F10 — incoming insertion", () => {
  it("autoscrolls only when the reader is already at the bottom", () => {
    expect(main.includes("if (pinnedToBottom.current) {")).toBe(true);
  });

  it("counts arrivals instead of yanking a scrolled-up reader", () => {
    // Scrolling up is a deliberate position. The transcript must not move.
    expect(main.includes("const arrived = messages.length - seenCount.current;")).toBe(true);
    expect(main.includes("if (arrived > 0) setUnseenCount((current) => current + arrived);")).toBe(true);
  });

  it("clears the backlog once the reader is caught up", () => {
    expect(main.includes("setUnseenCount(0);")).toBe(true);
  });

  it("says how far behind you are, not merely that there is a down", () => {
    expect(main.includes("jump-count")).toBe(true);
    expect(main.includes("`Jump to latest, ${unseenCount} new ${unseenCount === 1 ? \"message\" : \"messages\"}`")).toBe(true);
    // Singular/plural matters: "1 new messages" is the kind of detail that
    // makes an interface feel machine-written.
    expect(main.includes('unseenCount === 1 ? "message" : "messages"')).toBe(true);
  });

  it("caps the badge rather than letting it widen the control", () => {
    expect(main.includes('unseenCount > 99 ? "99+" : unseenCount')).toBe(true);
  });
});

describe("insertion motion stays inside the language", () => {
  it("animates the bubble, never the row that owns the layout", () => {
    // Animating the row's own box would reflow the transcript under the reader.
    expect(css).toContain(".message-row:last-child .message-bubble{animation:scout-message-in");
    expect(css).not.toContain(".message-row:last-child{animation");
  });

  it("uses transform and opacity only", () => {
    const frames = /@keyframes scout-message-in\{([^@]*?)\}\s*$/m.exec(css)?.[1]
      ?? /@keyframes scout-message-in\{from\{([^}]*)\}to\{([^}]*)\}\}/.exec(css)?.slice(1).join(";")
      ?? "";
    expect(frames).toContain("opacity");
    expect(frames).toContain("transform");
    for (const banned of ["height", "margin", "padding", "width"]) {
      expect(frames, banned).not.toContain(banned);
    }
  });

  it("is quick — an arrival should not hold the eye", () => {
    expect(css).toContain("animation:scout-message-in var(--motion-quick)");
  });
});
