import { afterEach, describe, expect, test } from "bun:test";

import { engageScoutVoiceDictation } from "./scout-voice-engage.ts";
import {
  awaitScoutVoiceHostCommand,
  registerScoutVoiceHost,
  resetScoutVoiceSessionStateForTests,
} from "./scout-voice-session.ts";
import { SCOUT_VOICE_HOST_REGISTRATION_GRACE_MS } from "../shared/voice-issues.ts";

afterEach(() => {
  resetScoutVoiceSessionStateForTests();
});

describe("engageScoutVoiceDictation", () => {
  // A web restart empties the in-process host registry while Scout Menu keeps
  // running, so "nothing registered" is only evidence of a missing host once
  // the host has had a registration cycle to check back in.
  test("reports reconnecting while the registry is still within its grace", () => {
    const result = engageScoutVoiceDictation();
    expect(result.ready).toBe(false);
    expect(result.issue?.code).toBe("host_reconnecting");
    expect(result.issue?.action).toBe("none");
  });

  test("reports host offline once the grace has passed with no registration", () => {
    const result = engageScoutVoiceDictation(
      {},
      Date.now() + SCOUT_VOICE_HOST_REGISTRATION_GRACE_MS + 1_000,
    );
    expect(result.ready).toBe(false);
    expect(result.issue?.code).toBe("host_offline");
    expect(result.issue?.action).toBe("launch_host");
    expect(result.issue?.actionLabel).toBe("Launch Scout Menu");
  });

  // Allow a bounded grace after a missed check-in.
  test("a stale registration reads as reconnecting, not offline", () => {
    registerScoutVoiceHost({ hostId: "scout-menu", platform: "macos" });
    const result = engageScoutVoiceDictation(
      {},
      Date.now() + 46_000,
    );
    expect(result.issue?.code).toBe("host_reconnecting");
  });

  test("offers launch again after a stale host exhausts its reconnect grace", () => {
    registerScoutVoiceHost({ hostId: "scout-menu", platform: "macos", devices: [{ id: "mic", name: "Mic", isDefault: true }] });
    const result = engageScoutVoiceDictation({}, Date.now() + 90_000);
    expect(result.hostOnline).toBe(false);
    expect(result.issue?.code).toBe("host_offline");
    expect(result.issue?.action).toBe("launch_host");
  });

  test("a connected host with no device gets the microphone action", () => {
    registerScoutVoiceHost({ hostId: "scout-menu", platform: "macos" });
    expect(engageScoutVoiceDictation().issue?.code).toBe("no_input_device");
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
