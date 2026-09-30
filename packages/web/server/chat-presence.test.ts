import { expect, test } from "bun:test";
import { ChatPresence } from "../shared/chat-presence.ts";
const beat = (sequence: number, active = true) => ({ clientId: "tab", sequence, active, typing: active });
test("activity is scoped, expires, and cannot be revived by an older tab request", () => {
  let now = 0; const presence = new ChatPresence(() => now);
  const allowed = new Set(["alex", "maya"]);
  presence.update("room", "alex", "Alex", false, beat(1));
  presence.update("other", "maya", "Maya", false, beat(1));
  expect(presence.read("room", allowed)).toMatchObject([{ actorId: "alex", typing: [{ threadId: null, expiresInMs: 6000 }] }]);
  now = 6001; expect(presence.read("room", allowed)[0]!.typing).toEqual([]);
  presence.update("room", "alex", "Alex", false, beat(3, false));
  presence.update("room", "alex", "Alex", false, beat(2));
  expect(presence.read("room", allowed)).toEqual([]);
  presence.update("room", "alex", "Alex", false, { ...beat(1), clientId: "second", threadId: "root" });
  expect(presence.read("room", allowed)).toMatchObject([{ actorId: "alex", typing: [{ threadId: "root" }] }]);
  expect(presence.read("room", new Set())).toEqual([]);
  now = 42000; expect(presence.read("room", allowed)).toEqual([]);
});
test("client storage is bounded and capacity recovers after expiry", () => {
  let now = 0; const presence = new ChatPresence(() => now, 1);
  expect(presence.update("room", "alex", "Alex", true, beat(1))).toBe(true);
  expect(presence.update("room", "maya", "Maya", false, beat(1))).toBe(false);
  expect(presence.read("room", new Set())).toHaveLength(1);
  now = 35001;
  expect(presence.update("room", "maya", "Maya", false, beat(1))).toBe(true);
});
