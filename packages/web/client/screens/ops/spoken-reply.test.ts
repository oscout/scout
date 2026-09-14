import { describe, expect, test } from "bun:test";

import { spokenReplyAnnouncement, spokenReplyLead } from "./spoken-reply.ts";

describe("spokenReplyLead", () => {
  test("returns short replies whole", () => {
    expect(spokenReplyLead("Done — tests pass.")).toBe("Done — tests pass.");
  });

  test("drops fenced code rather than reading braces aloud", () => {
    const body = "Fixed it.\n\n```ts\nconst x = { a: 1 };\n```\n\nRebuilt clean.";
    expect(spokenReplyLead(body)).toBe("Fixed it. Rebuilt clean.");
  });

  test("keeps link and heading text without the punctuation", () => {
    const body = "## Result\n\nSee [the PR](https://example.com/pr/1) for **details**.";
    expect(spokenReplyLead(body)).toBe("Result See the PR for details.");
  });

  test("reads list items as prose", () => {
    expect(spokenReplyLead("- one\n- two\n- three")).toBe("one two three");
  });

  test("cuts at a sentence boundary when over the limit", () => {
    const body = `${"A".repeat(60)}. ${"B".repeat(60)}. ${"C".repeat(200)}.`;
    const lead = spokenReplyLead(body, 140);
    expect(lead.endsWith(".")).toBe(true);
    expect(lead.length).toBeLessThanOrEqual(141);
    expect(lead).not.toContain("C");
  });

  test("falls back to a word boundary when no sentence ends in range", () => {
    const body = `${"word ".repeat(80)}end.`;
    const lead = spokenReplyLead(body, 100);
    expect(lead.endsWith("…")).toBe(true);
    expect(lead.length).toBeLessThanOrEqual(101);
    expect(lead).not.toContain("wor…");
  });

  test("is empty when the reply is only code", () => {
    expect(spokenReplyLead("```\nrm -rf build\n```")).toBe("");
  });
});

describe("spokenReplyAnnouncement", () => {
  test("names the speaker", () => {
    expect(spokenReplyAnnouncement("hudson", "All green.")).toBe("hudson says: All green.");
  });

  test("says so when there is nothing speakable", () => {
    expect(spokenReplyAnnouncement("hudson", "```\ncode\n```"))
      .toBe("hudson replied, but there was nothing to read out.");
  });
});
