import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createOpenScoutWebServer,
  makeStaticRoot,
  useIsolatedOpenScoutHome,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: onboarding routes", () => {
  test("POST /api/user validates runtime lists and round-trips them", async () => {
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = join(home, ".openscout");
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const bad = await server.app.request("http://localhost/api/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeShortlist: ["notharness/x"] }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual(expect.objectContaining({ error: expect.any(String) }));

    const badPreset = await server.app.request("http://localhost/api/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimePresets: [{ id: "fable", runtime: "claude/claude-opus-5" }] }),
    });
    expect(badPreset.status).toBe(400);

    const ok = await server.app.request("http://localhost/api/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtimeShortlist: ["claude/claude-opus-5"],
        runtimePresets: [{ id: "Fusion", label: "Fusion", runtime: "claude/claude-fable-5/medium" }],
      }),
    });
    expect(ok.status).toBe(200);
    const saved = await ok.json() as {
      runtimeShortlist: string[];
      runtimePresets: Array<{ id: string; label?: string; runtime: string }>;
    };
    expect(saved.runtimeShortlist).toEqual(["claude/claude-opus-5"]);
    expect(saved.runtimePresets).toEqual([
      { id: "fusion", label: "Fusion", runtime: "claude/claude-fable-5/medium" },
    ]);

    const cleared = await server.app.request("http://localhost/api/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeShortlist: [], runtimePresets: [] }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json() as typeof saved;
    expect(clearedBody.runtimeShortlist).toEqual([]);
    expect(clearedBody.runtimePresets).toEqual([]);
  });
});
