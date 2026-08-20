import { afterEach, describe, expect, test } from "bun:test";

import { engageScoutVoiceDictation } from "./scout-voice-engage.ts";
import {
  awaitScoutVoiceHostCommand,
  registerScoutVoiceHost,
  resetScoutVoiceSessionStateForTests,
} from "./scout-voice-session.ts";

afterEach(() => {
  resetScoutVoiceSessionStateForTests();
});

describe("engageScoutVoiceDictation", () => {
  test("reports host offline when Scout Menu is not registered", () => {
    const result = engageScoutVoiceDictation();
    expect(result.ready).toBe(false);
    expect(result.issue?.code).toBe("host_offline");
    expect(result.issue?.action).toBe("launch_host");
  });

  test("reports microphone denied with open settings action", () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      platform: "macos",
      devices: [{ id: "mic-1", name: "Built-in", isDefault: true }],
      settings: {
        permissions: [
          { kind: "microphone", status: "denied", granted: false, canRequest: false },
          { kind: "speechRecognition", status: "authorized", granted: true, canRequest: false },
        ],
      },
    });

    const result = engageScoutVoiceDictation();
    expect(result.ready).toBe(false);
    expect(result.issue?.code).toBe("microphone_denied");
    expect(result.issue?.action).toBe("open_microphone_settings");
    expect(result.inputDevice?.id).toBe("mic-1");
  });

  test("queues a native request for not-yet-requested microphone access", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      platform: "macos",
      devices: [{ id: "mic-1", name: "Built-in", isDefault: true }],
      settings: {
        permissions: [
          { kind: "microphone", status: "notDetermined", granted: false, canRequest: true },
          { kind: "speechRecognition", status: "authorized", granted: true, canRequest: false },
        ],
      },
    });

    const result = engageScoutVoiceDictation({ requestPermissions: true });
    expect(result.ready).toBe(false);
    expect(result.issue?.code).toBe("microphone_not_requested");
    expect(result.issue?.action).toBe("request_microphone");

    await expect(awaitScoutVoiceHostCommand("scout-menu", 1_000)).resolves.toMatchObject({
      command: { type: "permissions.request", kind: "microphone" },
    });
  });

  test("queues permission recovery for a denied microphone on mic engage", async () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      platform: "macos",
      devices: [{ id: "mic-1", name: "Built-in", isDefault: true }],
      settings: {
        permissions: [
          { kind: "microphone", status: "denied", granted: false, canRequest: false },
          { kind: "speechRecognition", status: "notDetermined", granted: false, canRequest: true },
        ],
      },
    });

    const result = engageScoutVoiceDictation({ requestPermissions: true });
    expect(result.ready).toBe(false);
    expect(result.issue?.code).toBe("microphone_denied");
    expect(result.issue?.action).toBe("open_microphone_settings");

    await expect(awaitScoutVoiceHostCommand("scout-menu", 1_000)).resolves.toMatchObject({
      command: { type: "permissions.request", kind: "microphone" },
    });
  });

  test("is ready when host, permissions, and input device are available", () => {
    registerScoutVoiceHost({
      hostId: "scout-menu",
      platform: "macos",
      devices: [{ id: "mic-1", name: "ATR2500x", isDefault: true }],
      settings: {
        preference: "auto",
        inputDeviceId: "mic-1",
        inputDeviceName: "ATR2500x",
        permissions: [
          { kind: "microphone", status: "authorized", granted: true, canRequest: false },
          { kind: "speechRecognition", status: "authorized", granted: true, canRequest: false },
        ],
      },
    });

    const result = engageScoutVoiceDictation();
    expect(result.ready).toBe(true);
    expect(result.issue).toBeNull();
    expect(result.inputDevice).toEqual({ id: "mic-1", name: "ATR2500x" });
  });
});
