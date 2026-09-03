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
      devices: [
        { id: "mic-1", name: "ATR2500x", isDefault: true },
      ],
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
        inputDeviceId: "mic-1",
        inputDeviceName: "ATR2500x",
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
      inputDevice: { id: "mic-1", name: "ATR2500x" },
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

  test("delivers a newly queued command to a waiting host without an interval tick", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const waiting = awaitScoutVoiceHostCommand("scout-menu", 1_000, "menu-process");
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    const { sessionId } = createScoutVoiceSession({ surface: "macos.native-composer" });
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      command: { type: "session.start", sessionId },
    });
  });

  test("keeps independent event-driven waiters for different hosts", async () => {
    registerScoutVoiceHost({ hostId: "menu-a", instanceId: "a", platform: "macos" });
    const { sessionId: firstSessionId } = createScoutVoiceSession({ surface: "first" });
    await expect(awaitScoutVoiceHostCommand("menu-a", 1_000, "a")).resolves.toMatchObject({
      command: { type: "session.start", sessionId: firstSessionId },
    });

    // Ensure the second host is the newest host selected for the next session.
    await new Promise((resolve) => setTimeout(resolve, 2));
    registerScoutVoiceHost({ hostId: "menu-b", instanceId: "b", platform: "macos" });
    const { sessionId: secondSessionId } = createScoutVoiceSession({ surface: "second" });
    await expect(awaitScoutVoiceHostCommand("menu-b", 1_000, "b")).resolves.toMatchObject({
      command: { type: "session.start", sessionId: secondSessionId },
    });

    const firstWait = awaitScoutVoiceHostCommand("menu-a", 1_000, "a");
    const secondWait = awaitScoutVoiceHostCommand("menu-b", 1_000, "b");
    let firstSettled = false;
    let secondSettled = false;
    void firstWait.then(() => {
      firstSettled = true;
    });
    void secondWait.then(() => {
      secondSettled = true;
    });

    stopScoutVoiceSession(firstSessionId);
    await Promise.resolve();
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(false);

    stopScoutVoiceSession(secondSessionId);
    await Promise.resolve();
    expect(secondSettled).toBe(true);
    await expect(firstWait).resolves.toMatchObject({
      command: { type: "session.stop", sessionId: firstSessionId },
    });
    await expect(secondWait).resolves.toMatchObject({
      command: { type: "session.stop", sessionId: secondSessionId },
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

  test("reset resolves active command waiters so shutdown does not wait for timeout", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      instanceId: "menu-process",
      platform: "macos",
    });
    const waiting = awaitScoutVoiceHostCommand("scout-menu", 10_000, "menu-process");
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    resetScoutVoiceSessionStateForTests();
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(waiting).resolves.toEqual({ command: null });
  });
});
