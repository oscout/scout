import { afterEach, expect, test } from "bun:test";
import type { MachineRecord } from "@openscout/protocol";
import { hostApiPath, hostChatUrl } from "./chat-host.ts";
import { startProjectSession } from "./session-start.ts";
import { mergeContextCaptureDraft } from "./context-capture-draft.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const machine = (webUrl: string) => ({ evidence: [{ kind: "scout", webUrl }] }) as MachineRecord;

test("remote launch addresses the selected host and never retries on this machine", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    requests.push(String(path));
    return new Response(JSON.stringify({ error: "Host offline" }), { status: 503 });
  }) as typeof fetch;
  await expect(startProjectSession({ machineId: "host:mini", projectPath: "/work/project" })).rejects.toThrow();
  expect(requests).toEqual(["/api/hosts/host%3Amini/api/sessions"]);
  expect(hostApiPath(undefined, "/api/sessions")).toBe("/api/sessions");
});

test("peer chat links preserve peer authority and reject loopback or credential-bearing URLs", () => {
  expect(hostChatUrl(machine("https://mini.example:444/"), "chat:1")).toBe("https://mini.example:444/c/chat%3A1");
  for (const url of ["http://localhost:43120", "http://127.0.0.1:43120", "http://[::1]", "https://user:pass@mini.example", "javascript:alert(1)"]) {
    expect(hostChatUrl(machine(url), "chat:1")).toBeNull();
  }
});

test("reopening a draft preserves its destination alongside the text", () => {
  const draft = mergeContextCaptureDraft(null, { machineId: "host:mini", message: "Keep this", projectPath: "/work" });
  expect(mergeContextCaptureDraft(draft, { intent: "new-task" })).toMatchObject({ machineId: "host:mini", message: "Keep this", projectPath: "/work" });
});
