import { describe, expect, test } from "bun:test";
import {
  createOpenScoutWebServer,
  makeStaticRoot,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: voice routes", () => {
  test("keeps strict voice health 503 while serving quiet browser probes as handled readiness", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const strictResponse = await server.app.request("http://localhost/api/voice/health");
    expect(strictResponse.status).toBe(503);
    await expect(strictResponse.json()).resolves.toMatchObject({
      ok: false,
      adapter: "hudson-dictation",
      capture: "native",
    });

    const quietResponse = await server.app.request("http://localhost/api/voice/health?quiet=1");
    expect(quietResponse.status).toBe(200);
    await expect(quietResponse.json()).resolves.toMatchObject({ ok: false });
  });

  test("bridges dictation and speech between the web client and Scout Menu", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const registerResponse = await server.app.request("http://localhost/api/voice/host/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: "scout-menu",
        platform: "macos",
        bundle: "app.openscout.scout.menu",
      }),
    });
    expect(registerResponse.status).toBe(200);

    const sessionResponse = await server.app.request("http://localhost/api/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "openscout-web",
        surface: "chat-composer",
      }),
    });
    expect(sessionResponse.status).toBe(200);
    const { sessionId } = await sessionResponse.json() as { sessionId: string };
    expect(sessionId).toMatch(/^scout-voice:/);

    const commandResponse = await server.app.request(
      "http://localhost/api/voice/host/commands?hostId=scout-menu&timeoutMs=1000",
    );
    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toMatchObject({
      command: { type: "session.start", sessionId },
    });

    const eventResponse = await server.app.request("http://localhost/api/voice/host/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: "scout-menu",
        sessionId,
        event: "session.final",
        data: { text: "Hello from HudsonKit.", durationMs: 512 },
      }),
    });
    expect(eventResponse.status).toBe(200);

    const speakResponsePromise = server.app.request("http://localhost/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Scout owns this path.",
        modelId: "system",
        speed: 1.1,
      }),
    });
    const speechCommandResponse = await server.app.request(
      "http://localhost/api/voice/host/commands?hostId=scout-menu&timeoutMs=1000",
    );
    expect(speechCommandResponse.status).toBe(200);
    const speechCommandBody = await speechCommandResponse.json() as {
      command: { type: string; sessionId: string };
    };
    expect(speechCommandBody.command).toMatchObject({
      type: "speech.synthesize",
      text: "Scout owns this path.",
      modelId: "system",
      speed: 1.1,
    });

    const speechEventResponse = await server.app.request("http://localhost/api/voice/host/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: "scout-menu",
        sessionId: speechCommandBody.command.sessionId,
        event: "speech.result",
        data: {
          contentType: "audio/wav",
          audioBase64: "UklGRg==",
          modelId: "system",
          voiceId: "system-default",
          audioBytes: 4,
        },
      }),
    });
    expect(speechEventResponse.status).toBe(200);

    const speakResponse = await speakResponsePromise;
    expect(speakResponse.status).toBe(200);
    await expect(speakResponse.json()).resolves.toMatchObject({
      contentType: "audio/wav",
      audioBase64: "UklGRg==",
      modelId: "system",
      voiceId: "system-default",
      route: "scout-menu",
    });

    const transcriptionForm = new FormData();
    transcriptionForm.set("audio", new Blob(["legacy-audio"], { type: "audio/wav" }), "voice.wav");
    const transcriptionResponse = await server.app.request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: transcriptionForm,
    });
    expect(transcriptionResponse.status).toBe(501);
    await expect(transcriptionResponse.json()).resolves.toMatchObject({
      code: "uploaded_transcription_unsupported",
    });
  });
});
