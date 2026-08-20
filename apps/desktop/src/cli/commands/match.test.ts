import { describe, expect, test } from "bun:test";

import type {
  ScoutRendezvousRequest,
  ScoutRendezvousResponse,
} from "@openscout/protocol";
import { BrokerRendezvousService } from "@openscout/runtime";

import { createScoutCommandContext } from "../context.js";
import {
  parseMatchCommandOptions,
  renderMatchCommandHelp,
  renderMatchResponse,
  runMatchCommand,
  type MatchCommandDependencies,
} from "./match.js";

describe("scout match options", () => {
  test("parses a human codename, first message, and exact session override", () => {
    expect(parseMatchCommandOptions([
      "--session",
      "thread-one",
      "--project=../talkie",
      "new",
      "BlueBird",
      "--message",
      "hello from A",
    ])).toEqual({
      action: "create",
      sessionId: "thread-one",
      projectPath: "../talkie",
      codename: "BlueBird",
      message: "hello from A",
      waitMs: 600_000,
    });
  });

  test("keeps generated creation as the zero-input fallback", () => {
    expect(parseMatchCommandOptions(["new"])).toEqual({
      action: "create",
      sessionId: null,
      projectPath: null,
      codename: null,
      message: null,
      waitMs: 600_000,
    });
  });

  test("preserves join display form and supports a non-blocking poll", () => {
    expect(parseMatchCommandOptions(["--wait=0", "bluebird"])).toEqual({
      action: "join",
      sessionId: null,
      projectPath: null,
      codename: "bluebird",
      message: null,
      waitMs: 0,
    });
  });

  test("rejects excessive waits, creator wait overrides, invalid codenames, and join messages", () => {
    expect(() => parseMatchCommandOptions(["--wait=601", "BLUEBIRD"])).toThrow(
      "between 0 and 600 seconds",
    );
    expect(() => parseMatchCommandOptions(["new", "--wait=1"])).toThrow(
      "fixed 10-minute invitation",
    );
    expect(() => parseMatchCommandOptions(["new", "BLUE-BIRD"])).toThrow(
      "ASCII letters or digits",
    );
    expect(() => parseMatchCommandOptions(["BLUEBIRD", "--message", "hello"])).toThrow(
      "only valid when creating",
    );
  });

  test("documents the codename-first facilitated ceremony", () => {
    const help = renderMatchCommandHelp();
    expect(help).toContain("scout match new <codename>");
    expect(help).toContain("scout match <codename>");
    expect(help).toContain("BLUEBIRD");
    expect(help).toContain("case-insensitively");
    expect(help).toContain("4 hours");
    expect(help).toContain("match exactly two");
    expect(help).toContain("--message");
    expect(help).toContain("generated fallback");
  });

  test("prints the invitation immediately and waits as its creator", async () => {
    const requests: ScoutRendezvousRequest[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const context = createScoutCommandContext({
      cwd: process.cwd(),
      env: {},
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    const dependencies = createDependencies(async (request) => {
      requests.push(request);
      if (request.action === "create") {
        return createdResponse(request.projectRoot, 601_000, request.codename ?? "AB2CDE");
      }
      return matchedResponse(request.projectRoot);
    });

    await runMatchCommand(
      context,
      ["new", "BlueBird", "--project", "."],
      dependencies,
    );

    expect(requests).toEqual([
      expect.objectContaining({
        action: "create",
        codename: "BlueBird",
        participantId: "session:creator",
      }),
      expect.objectContaining({
        action: "join",
        codename: "BlueBird",
        participantId: "session:creator",
        waitMs: 600_000,
      }),
    ]);
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toContain("Match codename: BlueBird");
    expect(stdout[0]).toContain("Give the other session: scout match BlueBird");
    expect(stdout[1]).toContain("Matched with session:peer");
    expect(stderr).toEqual([expect.stringContaining("Waiting for the other session")]);
  });

  test("emits created and matched states with codename JSON fields", async () => {
    const stdout: string[] = [];
    const context = createScoutCommandContext({
      cwd: process.cwd(),
      env: {},
      outputMode: "json",
      stdout: (line) => stdout.push(line),
    });
    const dependencies = createDependencies(async (request) => request.action === "create"
      ? createdResponse(request.projectRoot, 601_000, request.codename ?? "AB2CDE")
      : matchedResponse(request.projectRoot));

    await runMatchCommand(
      context,
      ["new", "BlueBird", "--project", "."],
      dependencies,
    );

    const events = stdout.map((line) => JSON.parse(line));
    expect(events.map((event) => event.status)).toEqual(["created", "matched"]);
    expect(events[0]).toMatchObject({ codename: "BlueBird" });
    expect(events[0]).not.toHaveProperty("code");
  });

  test("sends the first message through the exact-session path after matching", async () => {
    const stdout: string[] = [];
    const sendCalls: Parameters<MatchCommandDependencies["sendMessage"]>[0][] = [];
    const context = createScoutCommandContext({
      cwd: process.cwd(),
      env: {},
      outputMode: "json",
      stdout: (line) => stdout.push(line),
    });
    const dependencies = createDependencies(
      async (request) => request.action === "create"
        ? createdResponse(request.projectRoot, 601_000, "BlueBird")
        : matchedResponse(request.projectRoot, "BlueBird"),
      async (input) => {
        sendCalls.push(input);
        return {
          usedBroker: true,
          conversationId: "dm-conversation",
          messageId: "message-1",
          invokedTargets: ["peer-agent"],
          unresolvedTargets: [],
          routeKind: "dm",
        };
      },
    );

    await runMatchCommand(
      context,
      ["new", "BlueBird", "--message", "hello from A", "--project", "."],
      dependencies,
    );

    expect(sendCalls).toEqual([
      expect.objectContaining({
        senderId: "scout.sender",
        body: "hello from A",
        targetLabel: "session:peer",
        source: "scout-cli-match",
      }),
    ]);
    const events = stdout.map((line) => JSON.parse(line));
    expect(events.map((event) => event.status)).toEqual([
      "created",
      "matched",
      "message_sent",
    ]);
    expect(events[2]).toMatchObject({
      codename: "BlueBird",
      targetSessionId: "session:peer",
      conversationId: "dm-conversation",
      messageId: "message-1",
    });
  });

  test("does not treat a message as match evidence", async () => {
    let sendCount = 0;
    const context = createScoutCommandContext({
      cwd: process.cwd(),
      env: {},
      outputMode: "json",
      stdout: () => {},
    });
    const dependencies = createDependencies(
      async (request) => request.action === "create"
        ? createdResponse(request.projectRoot, 601_000, "BlueBird")
        : waitingResponse(request.projectRoot, "BlueBird"),
      async () => {
        sendCount += 1;
        throw new Error("must not send");
      },
    );

    await runMatchCommand(
      context,
      ["new", "BlueBird", "--message", "hello", "--project", "."],
      dependencies,
    );
    expect(sendCount).toBe(0);
  });

  test("completes the two-command ceremony against one broker service", async () => {
    const service = new BrokerRendezvousService({
      createMatchId: () => "match-ceremony",
      cleanupIntervalMs: 0,
    });
    const ownerOutput: string[] = [];
    const peerOutput: string[] = [];
    let ownerStartedWaiting: (() => void) | null = null;
    const ownerIsWaiting = new Promise<void>((resolve) => {
      ownerStartedWaiting = resolve;
    });
    const ownerContext = createScoutCommandContext({
      cwd: process.cwd(),
      env: {},
      outputMode: "json",
      stdout: (line) => ownerOutput.push(line),
    });
    const peerContext = createScoutCommandContext({
      cwd: process.cwd(),
      env: {},
      outputMode: "json",
      stdout: (line) => peerOutput.push(line),
    });
    const ownerDependencies = createDependencies((request) => {
      if (request.action === "join") ownerStartedWaiting?.();
      return service.match(request);
    });
    const peerDependencies = createDependencies(
      (request) => service.match(request),
      undefined,
      "session:peer",
    );

    const ownerCommand = runMatchCommand(
      ownerContext,
      ["new", "BlueBird", "--project", "."],
      ownerDependencies,
    );
    await ownerIsWaiting;
    await runMatchCommand(
      peerContext,
      ["bluebird", "--project", ".", "--wait", "0"],
      peerDependencies,
    );
    await ownerCommand;

    const ownerEvents = ownerOutput.map((line) => JSON.parse(line));
    const peerEvents = peerOutput.map((line) => JSON.parse(line));
    expect(ownerEvents.map((event) => event.status)).toEqual(["created", "matched"]);
    expect(peerEvents.map((event) => event.status)).toEqual(["matched"]);
    expect(ownerEvents[1]).toMatchObject({ matchId: "match-ceremony", codename: "BlueBird" });
    expect(peerEvents[0]).toMatchObject({ matchId: "match-ceremony", codename: "BlueBird" });
    expect(ownerEvents[1].communication).toMatchObject({
      peerSessionIds: ["session:peer"],
      sendCommand: 'scout send --to session:peer "<message>"',
      inboxCommand: "scout inbox --latest 10 --json",
      coordinationChecklist: [
        "worktree path or creation request",
        "base branch or SHA",
        "task branch",
        "touched paths",
        "commit and merge policy",
      ],
    });
    expect(peerEvents[0].communication).toMatchObject({
      peerSessionIds: ["session:creator"],
      sendCommand: 'scout send --to session:creator "<message>"',
      inboxCommand: "scout inbox --latest 10 --json",
    });
    service.dispose();
  });

  test("returns a failing command state for expiry", async () => {
    const stdout: string[] = [];
    const context = createScoutCommandContext({
      cwd: process.cwd(),
      env: {},
      outputMode: "json",
      stdout: (line) => stdout.push(line),
    });
    const dependencies = createDependencies(async (request) => ({
      status: "expired",
      codename: request.codename ?? "AB2CDE",
      projectRoot: request.projectRoot,
      participantId: "session:creator",
      expiresAt: 1_000,
      suggestion: "choose_another_codename",
    }));

    await expect(runMatchCommand(
      context,
      ["BLUEBIRD", "--project", ".", "--wait", "0"],
      dependencies,
    )).rejects.toThrow("expired");
    expect(JSON.parse(stdout[0] ?? "{}").status).toBe("expired");
  });

  test("renders an exact-session continuation command after matching", () => {
    const rendered = renderMatchResponse(matchedResponse("/repo/talkie"));
    expect(rendered).toContain('scout send --to session:peer "<message>"');
    expect(rendered).toContain("scout inbox --latest 10 --json");
    expect(rendered).toContain("Project: /repo/talkie");
    expect(rendered).toContain(
      "worktree path or creation request, base branch or SHA, task branch, touched paths, commit and merge policy",
    );
    expect(rendered).toContain("message is stored even if the peer is busy or unreachable");
    expect(rendered).toContain("do not create another match");
  });
});

function createDependencies(
  matchRendezvous: MatchCommandDependencies["matchRendezvous"],
  sendMessage: MatchCommandDependencies["sendMessage"] = async () => ({
    usedBroker: true,
    conversationId: "conversation-1",
    messageId: "message-1",
    invokedTargets: ["peer-agent"],
    unresolvedTargets: [],
    routeKind: "dm",
  }),
  participantId = "session:creator",
): MatchCommandDependencies {
  return {
    matchRendezvous,
    resolveParticipantId: async () => participantId,
    resolveSenderId: async () => "scout.sender",
    sendMessage,
    now: () => 1_000,
  };
}

function createdResponse(
  projectRoot: string,
  expiresAt: number,
  codename = "AB2CDE",
): ScoutRendezvousResponse {
  return {
    status: "created",
    codename,
    projectRoot,
    participantId: "session:creator",
    createdAt: 1_000,
    expiresAt,
  };
}

function waitingResponse(
  projectRoot: string,
  codename = "AB2CDE",
): ScoutRendezvousResponse {
  return {
    status: "waiting",
    codename,
    projectRoot,
    participantId: "session:creator",
    joinedAt: 1_000,
    expiresAt: 601_000,
  };
}

function matchedResponse(
  projectRoot: string,
  codename = "AB2CDE",
): ScoutRendezvousResponse {
  return {
    status: "matched",
    matchId: "match-1",
    codename,
    projectRoot,
    participantId: "session:creator",
    participantIds: ["session:creator", "session:peer"],
    peerParticipantIds: ["session:peer"],
    createdAt: 1_000,
    expiresAt: 121_000,
  };
}
