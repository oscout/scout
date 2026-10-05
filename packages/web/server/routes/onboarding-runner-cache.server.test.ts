import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenScoutWebServer,
  installWebServerTestHooks,
  loadWebServerUnderTest,
  makeStaticRoot,
  testDirectories,
  useIsolatedOpenScoutHome,
} from "../web-server-test-harness.ts";

// Keep the real durable onboarding save, but never install or start a service
// in this test. A failed readiness step must still invalidate the old catalog.
const onboarding = await import("@openscout/runtime/onboarding");
mock.module("@openscout/runtime/onboarding", () => ({
  ...onboarding,
  runOpenScoutOnboardingSetup: async () => { throw new Error("test service is still starting"); },
}));
await loadWebServerUnderTest();
installWebServerTestHooks();

test("saving Codex during onboarding invalidates a warm runner catalog immediately", async () => {
  const home = useIsolatedOpenScoutHome();
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  const currentDirectory = mkdtempSync(join(tmpdir(), "openscout-onboarding-catalog-"));
  testDirectories.add(currentDirectory);
  const server = await createOpenScoutWebServer({ currentDirectory, assetMode: "static", staticRoot: makeStaticRoot() });
  const before = await (await server.app.request("http://localhost/api/runner/options")).json();
  expect(before.defaults.harness).toBe("claude");
  const saved = await server.app.request("http://localhost/api/onboarding/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contextRoot: currentDirectory, sourceRoots: [currentDirectory], defaultHarness: "codex" }),
  });
  expect(saved.status).toBe(500);
  expect((await saved.json()).error).toBe("test service is still starting");
  const after = await (await server.app.request("http://localhost/api/runner/options")).json();
  expect(after.defaults.harness).toBe("codex");
  expect(after.projects.every((project: { defaultHarness: string }) => project.defaultHarness === "codex")).toBe(true);
});
