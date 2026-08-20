import { describe, expect, test } from "bun:test";

import { parseScoutbotReminderIntent } from "./scoutbot-reminder-intent.ts";

describe("Scoutbot reminder intents", () => {
  test("parses direct remind-me phrasing", () => {
    expect(parseScoutbotReminderIntent("Remind me in three minutes to check lattices status", 1_000))
      .toEqual({
        title: "check lattices status",
        body: "check lattices status",
        delayMs: 180_000,
        dueAt: 181_000,
      });
  });

  test("parses check-back phrasing", () => {
    expect(parseScoutbotReminderIntent("check back in 2 mins on this status", 10_000))
      .toEqual({
        title: "this status",
        body: "this status",
        delayMs: 120_000,
        dueAt: 130_000,
      });
  });

  test("parses update phrasing", () => {
    expect(parseScoutbotReminderIntent("can I get an update in five minutes", 10_000))
      .toEqual({
        title: "give me an update",
        body: "give me an update",
        delayMs: 300_000,
        dueAt: 310_000,
      });
  });

  test("ignores generic reminder discussion", () => {
    expect(parseScoutbotReminderIntent("we should make reminders a primitive", 10_000)).toBeNull();
  });
});
