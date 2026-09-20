import { describe, expect, test } from "bun:test";

import type { ObserveData, SessionRefObservePayload } from "./core/observe/service.ts";
import {
  SESSION_RECAP_SYSTEM_PROMPT,
  buildSessionRecap,
  sanitizeRecapSummary,
  selectSessionRecapEvidence,
} from "./session-recap.ts";

function observe(events: ObserveData["events"], adapterType: string): ObserveData {
  return {
    events,
    files: [],
    contextUsage: [],
    live: true,
    metadata: { session: { adapterType } },
  };
}

function payload(adapterType: string, events: ObserveData["events"], sessionId = "sess-1"): SessionRefObservePayload {
  return {
    kind: "tail",
    refId: sessionId,
    agentId: null,
    source: "tail",
    fidelity: "synthetic",
    historyPath: "/tmp/sess.jsonl",
    sessionId,
    updatedAt: 1_000,
    data: observe(events, adapterType),
  };
}

describe("session recap evidence", () => {
  test("keeps public assistant and status text and drops reasoning and tool payloads", () => {
    const items = selectSessionRecapEvidence(observe([
      { id: "think-1", t: 1, kind: "think", text: "hidden reasoning" },
      { id: "tool-1", t: 2, kind: "tool", text: "bash ls", arg: "ls /secrets" },
      { id: "msg-1", t: 3, kind: "message", text: "Opened the file." },
      { id: "sys-1", t: 4, kind: "system", text: "Waiting on approval." },
    ], "claude"));
    expect(items.map((item) => item.id)).toEqual(["msg-1", "sys-1"]);
    expect(items.some((item) => item.text.includes("reasoning") || item.text.includes("/secrets"))).toBe(false);
  });

  test("does not label an incomplete update as completed", () => {
    const summary = sanitizeRecapSummary("The task is completed and tests passed.", [
      { id: "msg-1", kind: "message", text: "Still editing the parser." },
    ]);
    expect(summary.toLowerCase()).not.toContain("completed");
    expect(summary.toLowerCase()).not.toContain("tests passed");
  });
});

describe("buildSessionRecap", () => {
  test("denies a requested harness that does not match the observed source", async () => {
    const recap = await buildSessionRecap({
      sessionRef: "session-ms857tz2-9aybmi",
      harness: "devin",
      loadObserve: async () => payload("claude", [
        { id: "msg-1", t: 1, kind: "message", text: "Working on the parser." },
      ], "session-ms857tz2-9aybmi"),
    });
    expect(recap.status).toBe("unavailable");
    expect(recap.summary).toBe("");
  });

  test("returns unavailable when the source cannot be resolved", async () => {
    const recap = await buildSessionRecap({
      sessionRef: "missing",
      harness: "claude",
      loadObserve: async () => null,
    });
    expect(recap.status).toBe("unavailable");
  });

  test("returns the verbatim no-update line when there is no public evidence", async () => {
    const recap = await buildSessionRecap({
      sessionRef: "sess-1",
      harness: "claude",
      loadObserve: async () => payload("claude", [
        { id: "think-1", t: 1, kind: "think", text: "secret plan" },
      ]),
      summarize: async () => {
        throw new Error("model should not run");
      },
    });
    expect(recap.status).toBe("ready");
    expect(recap.summary).toBe("No verified update available");
  });

  test("sends only evidence JSON to summarization", async () => {
    let prompt = "";
    const recap = await buildSessionRecap({
      sessionRef: "sess-1",
      harness: "claude",
      loadObserve: async () => payload("claude", [
        { id: "msg-1", t: 1, kind: "message", text: "Still writing tests." },
      ]),
      summarize: async (body) => {
        prompt = JSON.stringify(body);
        return "Latest observed update: still writing tests.";
      },
    });
    expect(recap.status).toBe("ready");
    expect(prompt).toContain("Still writing tests.");
    expect(prompt).not.toContain("hidden");
    expect(SESSION_RECAP_SYSTEM_PROMPT).toContain("untrusted source material");
  });
});
