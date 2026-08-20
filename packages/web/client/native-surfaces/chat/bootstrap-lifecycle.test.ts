import { describe, expect, it } from "bun:test";
import { stripLaunchOnlyFields } from "./bootstrap-lifecycle.ts";

/** P0.2 — the identity card must not reopen after the operator dismisses it.
 *
 * The failure this pins: the host re-injects its whole bootstrap on any
 * preference change, and that payload still carries the launch-time
 * `openIdentity`. Replaying it reopened a dismissed card, which — together with
 * the thread re-push (P0.1) — is why Back appeared to loop in the operator's
 * captures. */

describe("bootstrap re-read", () => {
  it("drops the launch instruction so a re-read cannot reopen the card", () => {
    const relaunched = stripLaunchOnlyFields({ openIdentity: true });
    expect(relaunched.openIdentity).toBe(false);
  });

  it("keeps every preference the host re-sends", () => {
    const next = stripLaunchOnlyFields({
      protocolVersion: 1,
      conversationId: "c1",
      title: "Fable",
      mode: "techie",
      style: "whatsapp",
      density: "compact",
      capabilities: ["chat.send"],
      openIdentity: true,
    });
    expect(next).toMatchObject({
      protocolVersion: 1,
      conversationId: "c1",
      title: "Fable",
      mode: "techie",
      style: "whatsapp",
      density: "compact",
      capabilities: ["chat.send"],
    });
    // Only the launch instruction is withheld.
    expect(next.openIdentity).toBe(false);
  });

  it("drops the actions capture seam too, not just the identity card", () => {
    // Both are launch instructions. The seam's own guard is a component ref,
    // which a remount resets — so the launch-only contract has to be enforced
    // here, where every such field is handled together.
    const relaunched = stripLaunchOnlyFields({ openIdentity: true, openActions: true });
    expect(relaunched.openActions).toBe(false);
    expect(relaunched.openIdentity).toBe(false);
  });

  it("is idempotent — repeated re-reads stay closed", () => {
    let config = { openIdentity: true };
    for (let i = 0; i < 5; i += 1) config = stripLaunchOnlyFields(config);
    expect(config.openIdentity).toBe(false);
  });

  it("does not mutate the payload it was handed", () => {
    const original = { openIdentity: true };
    stripLaunchOnlyFields(original);
    expect(original.openIdentity).toBe(true);
  });

  it("leaves a payload that never asked for the card alone", () => {
    expect(stripLaunchOnlyFields({}).openIdentity).toBe(false);
    expect(stripLaunchOnlyFields({ openIdentity: false }).openIdentity).toBe(false);
  });
});
