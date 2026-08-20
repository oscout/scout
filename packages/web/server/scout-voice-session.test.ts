import { afterEach, describe, expect, test } from "bun:test";

import {
  awaitScoutVoiceHostCommand,
  createScoutVoiceSession,
  getScoutVoiceHealthSnapshot,
  listScoutVoiceSessionHistory,
  pushScoutVoiceHostEvent,
  registerScoutVoiceHost,
  resetScoutVoiceSessionStateForTests,
  stopScoutVoiceSession,
  subscribeScoutVoiceSession,
} from "./scout-voice-session.ts";

afterEach(() => {
  resetScoutVoiceSessionStateForTests();
});

describe("scout voice native sessions", () => {
  test("reports unavailable health until a host registers", () => {
    expect(getScoutVoiceHealthSnapshot()).toMatchObject({
      ok: false,
      adapter: "hudson-dictation",
      capture: "native",
    });
  });

  test("reports not-yet-requested microphone as requestable, not denied", () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      platform: "macos",
      settings: {
        permissions: [
          { kind: "microphone", status: "notDetermined", granted: false, canRequest: true },
        ],
      },
    });

    expect(getScoutVoiceHealthSnapshot()).toMatchObject({
      ok: false,
      microphoneGranted: false,
      microphoneCanRequest: true,
      detail: "Microphone has not been requested yet. Tap the mic or choose Request access to show the macOS prompt.",
    });
  });

  test("creates a session, dispatches start to the host, and streams events", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      platform: "macos",
      bundle: "app.openscout.scout.menu",
      settings: {
        permissions: [
          { kind: "microphone", status: "authorized", granted: true, canRequest: false },
          { kind: "speechRecognition", status: "authorized", granted: true, canRequest: false },
        ],
      },
    });

    const seen: string[] = [];
    const { sessionId } = createScoutVoiceSession({
      clientId: "openscout-web",
      surface: "chat-composer",
    });

    const unsubscribe = subscribeScoutVoiceSession(sessionId, (event) => {
      seen.push(event.event);
    });

    const commandPromise = awaitScoutVoiceHostCommand("scout-menu", 1_000);
    await expect(commandPromise).resolves.toMatchObject({
      command: {
        type: "session.start",
        sessionId,
        surface: "chat-composer",
      },
    });

    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      sessionId,
      event: "session.state",
      data: { state: "recording" },
    });
    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      sessionId,
      event: "session.partial",
      data: { text: "hello" },
    });

    stopScoutVoiceSession(sessionId);
    const stopCommand = await awaitScoutVoiceHostCommand("scout-menu", 1_000);
    expect(stopCommand.command).toMatchObject({ type: "session.stop", sessionId });

    pushScoutVoiceHostEvent({
      hostId: "scout-menu",
      sessionId,
      event: "session.final",
      data: { text: "Hello there.", durationMs: 420 },
    });

    unsubscribe();
    expect(seen).toEqual([
      "session.started",
      "session.state",
      "session.partial",
      "session.state",
      "session.final",
    ]);
    expect(getScoutVoiceHealthSnapshot()).toMatchObject({
      ok: true,
      capture: "native",
      microphoneGranted: true,
      host: { hostId: "scout-menu" },
    });

    const history = listScoutVoiceSessionHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sessionId,
      status: "done",
      lastEvent: "session.final",
      lastTranscript: "Hello there.",
    });
  });

  test("queues stop behind start when capture is toggled before the host polls", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });

    const { sessionId } = createScoutVoiceSession({ surface: "macos.native-composer" });
    stopScoutVoiceSession(sessionId);

    await expect(awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process")).resolves.toMatchObject({
      command: { type: "session.start", sessionId },
    });
    await expect(awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process")).resolves.toMatchObject({
      command: { type: "session.stop", sessionId },
    });
  });

  test("a stale helper poll cannot consume a replacement helper's command", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "old-process",
      platform: "macos",
    });
    const stalePoll = awaitScoutVoiceHostCommand("scout-menu", 1_000, "old-process");

    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "new-process",
      platform: "macos",
    });
    const { sessionId } = createScoutVoiceSession({ surface: "macos.native-composer" });

    await expect(stalePoll).resolves.toEqual({ command: null });
    await expect(awaitScoutVoiceHostCommand("scout-menu", 1_000, "new-process")).resolves.toMatchObject({
      command: { type: "session.start", sessionId },
    });
  });

  test("a replacement poll supersedes an abandoned poll from the same helper", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const abandonedPoll = awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");
    const replacementPoll = awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");

    const { sessionId } = createScoutVoiceSession({ surface: "macos.native-composer" });

    await expect(abandonedPoll).resolves.toEqual({ command: null });
    await expect(replacementPoll).resolves.toMatchObject({
      command: { type: "session.start", sessionId },
    });
  });

  test("an aborted poll releases command ownership immediately", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const controller = new AbortController();
    const abortedPoll = awaitScoutVoiceHostCommand(
      "scout-menu",
      1_000,
      "menu-process",
      controller.signal,
    );

    controller.abort();
    const { sessionId } = createScoutVoiceSession({ surface: "macos.native-composer" });

    await expect(abortedPoll).resolves.toEqual({ command: null });
    await expect(awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process")).resolves.toMatchObject({
      command: { type: "session.start", sessionId },
    });
  });
});
