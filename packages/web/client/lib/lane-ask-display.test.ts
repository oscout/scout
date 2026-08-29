import { describe, expect, test } from "bun:test";

import { buildLaneAskDisplay, laneAskHeadline, laneAskPreview } from "./lane-ask-display.ts";
import type { ObserveEvent } from "./types.ts";

function ask(text: string, overrides: Partial<ObserveEvent> = {}): ObserveEvent {
  return {
    id: "ask-1",
    t: 10,
    kind: "ask",
    text,
    ...overrides,
  };
}

describe("lane ask display", () => {
  test("uses the task after injected AGENTS instructions as the compact title", () => {
    const event = ask(`# AGENTS.md instructions for /Users/art/dev/hudson

<INSTRUCTIONS>
# Global Codex Build Hygiene

Do not put DerivedData under /tmp.
</INSTRUCTIONS>

Aida (@art) -> hudson-galileo ask/Task: bump HudsonKit/HudsonTerminal to Termin 4 GhosttyKit 0.16. delivery: waking session fresh session`);

    const model = buildLaneAskDisplay(event);

    expect(model.title).toBe("bump HudsonKit/HudsonTerminal to Termin 4 GhosttyKit 0.16. delivery: waking session fresh session");
    expect(model.preview).not.toContain("Global Codex Build Hygiene");
    expect(model.fullText).toContain("Global Codex Build Hygiene");
  });

  test("falls back to the first meaningful request line", () => {
    const event = ask(`

Please review the lane ask preview and make the full text readable.

Extra context follows here.`);

    expect(laneAskHeadline(event)).toBe("Please review the lane ask preview and make the full text readable.");
    expect(laneAskPreview(event)).toContain("Extra context follows here.");
  });

  test("skips a generic leading Ask label before injected instructions", () => {
    const event = ask(`Ask

# AGENTS.md instructions for /Users/art/dev/openscout

<INSTRUCTIONS>
Do not put DerivedData under /tmp.
</INSTRUCTIONS>

Ship the message-card design pass.`);

    const model = buildLaneAskDisplay(event);

    expect(model.title).toBe("Ship the message-card design pass.");
    expect(model.preview).not.toContain("DerivedData");
    expect(model.preview).not.toBe("Ask");
  });

  test("strips Scout routed ask envelopes from the request title", () => {
    const model = buildLaneAskDisplay(ask("⌖ Claude (@claude) → openscout-pauli-2 (@session-mr5ogsi1-q7eoiz) · ask:wej9zx › # Codex task — review OPEN PRs for merge-readiness\nYou are doing an adversarial merge-readiness pass over the diff."));

    expect(model.title).toBe("review OPEN PRs for merge-readiness");
    expect(model.preview).toContain("adversarial merge-readiness");
    expect(model.preview).not.toContain("ask:wej9zx");
  });

  test("records human answers with delay metadata", () => {
    const model = buildLaneAskDisplay(ask("Proceed with the migration?", {
      to: "human",
      answer: "Yes",
      answerT: 75,
    }));

    expect(model.label).toBe("To operator");
    expect(model.fields).toContainEqual({ label: "answer", value: "1m 5s" });
    expect(model.answer).toEqual({ label: "answered after 1m 5s", text: "Yes" });
  });

  test("prefers the explicit user request over attachments and project instructions", () => {
    const model = buildLaneAskDisplay(ask(`# AGENTS.md instructions for /Users/art/dev/openscout

<INSTRUCTIONS>
# Global Codex Build Hygiene

Do not put DerivedData under /tmp.
</INSTRUCTIONS>

# Files mentioned by the user:

## Talkie Capture.png: /Users/art/Library/Application Support/Talkie/Screenshots/Talkie Capture.png

## My request for Codex:
ask claude to come up with a much nicer user message presentation

also let's have a filter on the lanes that collapses technical events in turns (as a toggle of course)`));

    expect(model.label).toBe("User request");
    expect(model.title).toBe("ask claude to come up with a much nicer user message presentation");
    expect(model.preview).toContain("filter on the lanes");
    expect(model.preview).not.toContain("DerivedData");
    expect(model.preview).not.toContain("Talkie Capture");
  });

  test("lifts injected context tags into chips instead of raw markup", () => {
    const model = buildLaneAskDisplay(ask(`<in-app-browser-context source="ambient-ui-state"> This block is automatically supplied ambient UI state, not part of the user's request.
</in-app-browser-context>

Ship the chat-style request card.`));

    expect(model.contextTags).toEqual([
      {
        name: "in-app-browser-context",
        detail: "ambient-ui-state",
        raw: '<in-app-browser-context source="ambient-ui-state">',
      },
    ]);
    expect(model.title).toBe("This block is automatically supplied ambient UI state, not part of the user's request.");
    expect(model.preview).toContain("Ship the chat-style request card.");
    expect(model.preview).not.toContain("<in-app-browser-context");
    expect(model.fullText).toContain("<in-app-browser-context");
  });

  test("dedupes repeated context tags and keeps the attributed variant", () => {
    const model = buildLaneAskDisplay(ask(`<system-reminder>one</system-reminder>
<system-reminder source="clock">two</system-reminder>
Do the thing.`));

    expect(model.contextTags).toEqual([
      { name: "system-reminder", detail: "clock", raw: '<system-reminder source="clock">' },
    ]);
    expect(model.preview).toContain("one");
    expect(model.preview).toContain("Do the thing.");
    expect(model.preview).not.toContain("</system-reminder>");
  });

  test("leaves prose angle-bracket mentions in place", () => {
    const model = buildLaneAskDisplay(ask("Use the <Task> tool and keep <b> intact."));

    expect(model.contextTags).toEqual([]);
    expect(model.title).toBe("Use the <Task> tool and keep <b> intact.");
  });
});
