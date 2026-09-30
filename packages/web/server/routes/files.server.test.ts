import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stubs,
  createOpenScoutWebServer,
  makeStaticRoot,
  testDirectories,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: files routes", () => {
  test("reveals local paths through the configured reveal hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-web-reveal-"));
    testDirectories.add(root);
    mkdirSync(join(root, "sessions"), { recursive: true });
    const transcriptPath = join(root, "sessions", "session.jsonl");
    writeFileSync(transcriptPath, "{}\n", "utf8");
    const realTranscriptPath = realpathSync(transcriptPath);
    stubs.agentObservePayloadResult = {
      agentId: "agent-1",
      source: "history",
      fidelity: "timestamped",
      historyPath: transcriptPath,
      sessionId: "session-1",
      updatedAt: Date.now(),
      data: {
        events: [],
        files: [],
        metadata: {
          session: {
            cwd: root,
            threadPath: "sessions/session.jsonl",
          },
        },
      },
    };
    const revealedPaths: string[] = [];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      revealPath: (targetPath) => {
        revealedPaths.push(targetPath);
      },
    });

    const response = await server.app.request("http://localhost/api/local-path/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "sessions/session.jsonl",
        basePath: root,
        agentId: "agent-1",
        sessionId: "session-1",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: realTranscriptPath });
    expect(revealedPaths).toEqual([realTranscriptPath]);
  });

  test("rejects reveal requests for paths outside the observed session", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-web-reveal-"));
    testDirectories.add(root);
    mkdirSync(join(root, "sessions"), { recursive: true });
    const transcriptPath = join(root, "sessions", "session.jsonl");
    writeFileSync(transcriptPath, "{}\n", "utf8");
    writeFileSync(join(root, "secret.txt"), "not in observe payload\n", "utf8");
    stubs.agentObservePayloadResult = {
      agentId: "agent-1",
      source: "history",
      fidelity: "timestamped",
      historyPath: transcriptPath,
      sessionId: "session-1",
      updatedAt: Date.now(),
      data: {
        events: [],
        files: [],
        metadata: {
          session: {
            cwd: root,
            threadPath: "sessions/session.jsonl",
          },
        },
      },
    };
    const revealedPaths: string[] = [];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
      revealPath: (targetPath) => {
        revealedPaths.push(targetPath);
      },
    });

    const response = await server.app.request("http://localhost/api/local-path/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "secret.txt",
        basePath: root,
        agentId: "agent-1",
        sessionId: "session-1",
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "path is not part of the observed session" });
    expect(revealedPaths).toEqual([]);
  });
});
