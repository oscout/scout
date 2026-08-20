import { describe, expect, test } from "bun:test";

import {
  parseLabelCommandOptions,
  renderLabelBrief,
  renderLabelCommandHelp,
  renderLabelFeed,
  renderLabelFeedEvent,
} from "./label.ts";

describe("renderLabelCommandHelp", () => {
  test("documents brief and watch", () => {
    const help = renderLabelCommandHelp();

    expect(help).toContain("Usage: scout label <command>");
    expect(help).toContain("brief <label>");
    expect(help).toContain("feed <label>");
    expect(help).toContain("watch <label>");
  });
});

describe("parseLabelCommandOptions", () => {
  test("defaults to a brief for a bare label", () => {
    expect(parseLabelCommandOptions(["release:0.2.66"])).toEqual({
      command: "brief",
      label: "release:0.2.66",
    });
  });

  test("parses watch interval, once, since, and limit", () => {
    expect(parseLabelCommandOptions([
      "watch",
      "goal:ios",
      "--interval",
      "15",
      "--since",
      "12345",
      "--limit",
      "25",
      "--once",
    ])).toEqual({
      command: "watch",
      label: "goal:ios",
      intervalSeconds: 15,
      since: 12345,
      limit: 25,
      once: true,
    });
  });

  test("parses feed as a one-shot normalized event backlog", () => {
    expect(parseLabelCommandOptions(["feed", "release:0.2.66", "--limit=10"])).toEqual({
      command: "feed",
      label: "release:0.2.66",
      limit: 10,
    });
  });
});

describe("renderLabelBrief", () => {
  test("renders active flights, recent flights, and work items", () => {
    const rendered = renderLabelBrief({
      label: "release:0.2.66",
      generatedAt: 1_000_000,
      lastActivityAt: 999_000,
      participants: ["codex", "hudson.main"],
      counts: {
        flights: 2,
        activeFlights: 1,
        workItems: 1,
      },
      flightsByState: {
        running: 1,
        completed: 1,
      },
      activeFlights: [
        {
          id: "flt-1",
          invocationId: "inv-1",
          state: "running",
          requesterId: "codex",
          targetAgentId: "hudson.main",
          summary: "Running tests.",
          output: null,
          error: null,
          labels: ["release:0.2.66"],
          conversationId: "dm.codex.hudson",
          messageId: "msg-1",
          workId: "work-1",
          startedAt: 999_000,
          completedAt: null,
          lastActivityAt: 999_000,
        },
      ],
      recentFlights: [
        {
          id: "flt-2",
          invocationId: "inv-2",
          state: "completed",
          requesterId: "codex",
          targetAgentId: "hudson.main",
          summary: "Reviewed.",
          output: "Looks good.",
          error: null,
          labels: ["release:0.2.66"],
          conversationId: "dm.codex.hudson",
          messageId: "msg-2",
          workId: "work-1",
          startedAt: 998_000,
          completedAt: 998_500,
          lastActivityAt: 998_500,
        },
      ],
      workItems: [
        {
          id: "work-1",
          title: "Ship bump",
          state: "working",
          ownerId: "hudson.main",
          nextMoveOwnerId: "hudson.main",
          summary: "Package review.",
          labels: ["release:0.2.66"],
          updatedAt: 999_500,
        },
      ],
    });

    expect(rendered).toContain("Label: release:0.2.66");
    expect(rendered).toContain("Flights: 1 active / 2 total");
    expect(rendered).toContain("Active flights:");
    expect(rendered).toContain("flt-1 - running");
    expect(rendered).toContain("Recent flights:");
    expect(rendered).toContain("flt-2 - completed");
    expect(rendered).toContain("Work items:");
    expect(rendered).toContain("work-1 - working");
  });
});

describe("renderLabelFeed", () => {
  test("renders normalized event lines", () => {
    const event = {
      id: "work-event:evt-1",
      label: "release:0.2.66",
      at: 1_000_000,
      kind: "work_event" as const,
      category: "work" as const,
      actorId: "hudson.main",
      targetAgentId: "hudson.main",
      conversationId: "dm.operator.hudson",
      messageId: null,
      invocationId: null,
      flightId: null,
      workId: "work-1",
      state: "working",
      eventKind: "progressed",
      summary: "Tests are still running.",
      labels: ["release:0.2.66"],
    };

    expect(renderLabelFeedEvent(event)).toContain("work_event actor hudson.main");

    const rendered = renderLabelFeed({
      label: "release:0.2.66",
      generatedAt: 1_000_100,
      cursor: event.id,
      since: null,
      counts: {
        events: 1,
        messages: 0,
        invocations: 0,
        flights: 0,
        workEvents: 1,
      },
      events: [event],
    });

    expect(rendered).toContain("Label: release:0.2.66");
    expect(rendered).toContain("Tests are still running.");
  });
});
