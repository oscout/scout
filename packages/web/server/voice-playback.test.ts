import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  SCOUT_VOICE_PLAYBACK_SETTINGS_PATH,
  parseScoutVoicePlayback,
  type ScoutVoicePlayback,
} from "../shared/voice-playback.ts";
import { mountScoutVoiceRoutes } from "./routes/voice.ts";
import { resolveScoutVoicePlaybackSettings } from "./voice-playback.ts";

describe("Scout voice playback setting", () => {
  test("resolves the operator setting with an optional environment override", () => {
    expect(parseScoutVoicePlayback(" Host ")).toBe("host");
    expect(parseScoutVoicePlayback("speaker")).toBeNull();
    expect(resolveScoutVoicePlaybackSettings("host", {})).toEqual({
      playback: "host",
      configuredPlayback: "host",
      source: "settings",
      locked: false,
    });
    expect(resolveScoutVoicePlaybackSettings("host", { OPENSCOUT_VOICE_PLAYBACK: "browser" })).toEqual({
      playback: "browser",
      configuredPlayback: "host",
      source: "environment",
      locked: true,
    });
    expect(resolveScoutVoicePlaybackSettings("browser", { OPENSCOUT_VOICE_PLAYBACK: "nonsense" })).toMatchObject({
      playback: "browser",
      source: "settings",
    });
  });

  test("lets the operator move spoken replies onto the Mac without a restart", async () => {
    let configured: ScoutVoicePlayback = "browser";
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      readVoicePlayback: async () => configured,
      writeVoicePlayback: async (playback) => {
        configured = playback;
        return configured;
      },
      voiceEnvironment: {},
    });

    const initial = await app.request(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      playback: "browser",
      configuredPlayback: "browser",
      source: "settings",
      locked: false,
    });

    const onHost = await app.request(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playback: "host" }),
    });
    expect(onHost.status).toBe(200);
    expect(await onHost.json()).toEqual(expect.objectContaining({ playback: "host", configuredPlayback: "host" }));
    expect(configured).toBe("host");

    const invalid = await app.request(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playback: "speaker" }),
    });
    expect(invalid.status).toBe(400);
    expect(configured).toBe("host");
  });

  test("keeps an environment-pinned mode locked", async () => {
    let wrote: ScoutVoicePlayback | null = null;
    const app = new Hono();
    mountScoutVoiceRoutes(app, {
      readVoicePlayback: async () => "host",
      writeVoicePlayback: async (playback) => {
        wrote = playback;
        return playback;
      },
      voiceEnvironment: { OPENSCOUT_VOICE_PLAYBACK: "browser" },
    });

    const snapshot = await app.request(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH);
    expect(await snapshot.json()).toEqual({
      playback: "browser",
      configuredPlayback: "host",
      source: "environment",
      locked: true,
    });

    const update = await app.request(SCOUT_VOICE_PLAYBACK_SETTINGS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playback: "host" }),
    });
    expect(update.status).toBe(409);
    expect(wrote).toBeNull();
  });

  test("rejects an unknown per-request playback before touching the host", async () => {
    const app = new Hono();
    mountScoutVoiceRoutes(app, { readVoicePlayback: async () => "browser", voiceEnvironment: {} });
    const response = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello", playback: "speaker" }),
    });
    expect(response.status).toBe(400);
  });
});
