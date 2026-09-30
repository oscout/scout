import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenScoutWebServer,
  makeStaticRoot,
  testDirectories,
  useIsolatedOpenScoutHome,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: work routes", () => {
  test("serves and writes global material heuristics", async () => {
    const home = useIsolatedOpenScoutHome();
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const defaultsResponse = await server.app.request("http://localhost/api/heuristics/defaults");
    expect(defaultsResponse.status).toBe(200);
    await expect(defaultsResponse.json()).resolves.toMatchObject({
      path: null,
      config: {
        classify: {
          exclude: expect.arrayContaining(["node_modules/**"]),
        },
      },
    });

    const raw = JSON.stringify({ classify: { spec: { include: ["sco-*.md"] } } }, null, 2);
    const putResponse = await server.app.request("http://localhost/api/heuristics/global", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({
      path: join(home, ".openscout", "heuristics.json"),
      raw,
      config: { classify: { spec: { include: ["sco-*.md"] } } },
    });
    expect(readFileSync(join(home, ".openscout", "heuristics.json"), "utf8")).toBe(raw);
  });

  test("returns editor-friendly errors for invalid heuristic JSON", async () => {
    useIsolatedOpenScoutHome();
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/heuristics/global", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: "{\n  \"classify\": " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid JSON",
      lineNumber: 2,
    });
  });

  test("serves project material heuristics for a workspace root", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-web-heuristics-project-"));
    testDirectories.add(root);
    mkdirSync(join(root, ".openscout"), { recursive: true });
    writeFileSync(
      join(root, ".openscout", "heuristics.json"),
      JSON.stringify({ classify: { planning: { include: ["roadmap/*.md"] } } }),
      "utf8",
    );
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      `http://localhost/api/heuristics/project?workspaceRoot=${encodeURIComponent(root)}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      path: join(root, ".openscout", "heuristics.json"),
      config: { classify: { planning: { include: ["roadmap/*.md"] } } },
    });
  });
});
