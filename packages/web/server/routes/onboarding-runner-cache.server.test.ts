import { expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCOUT_RUNTIME_CATALOG } from "@openscout/protocol";
import {
  createOpenScoutWebServer,
  installWebServerTestHooks,
  loadWebServerUnderTest,
  makeStaticRoot,
  stubs,
  testDirectories,
  useIsolatedOpenScoutHome,
} from "../web-server-test-harness.ts";

// Keep the real durable onboarding save, but never install or start a service
// in this test. A failed readiness step must still invalidate the old catalog.
const onboarding = await import("@openscout/runtime/onboarding");
const { writeOpenScoutSettings } = await import("@openscout/runtime/setup");
mock.module("@openscout/runtime/onboarding", () => ({
  ...onboarding,
  runOpenScoutOnboardingSetup: async () => { throw new Error("test service is still starting"); },
}));
await loadWebServerUnderTest();
installWebServerTestHooks();

function readSavedSettings() {
  return JSON.parse(readFileSync(join(process.env.OPENSCOUT_SUPPORT_DIRECTORY!, "settings.json"), "utf8"));
}

async function createFixtureServer(currentDirectory: string) {
  // Keep model transport synthetic; these cases exercise real settings writes.
  globalThis.fetch = (async () => Response.json({ catalog: SCOUT_RUNTIME_CATALOG, warnings: [] })) as typeof fetch;
  return createOpenScoutWebServer({ currentDirectory, assetMode: "static", staticRoot: makeStaticRoot(), backgroundServices: false });
}

function writeProjectRuntime(root: string, model: string) {
  mkdirSync(join(root, ".openscout"), { recursive: true });
  writeFileSync(join(root, ".openscout", "project.json"), JSON.stringify({
    version: 1, project: { id: "folder-intent-fixture", name: "Folder Intent", root: "." },
    agent: { runtime: { shortlist: [`claude/${model}`] } },
  }));
}

for (const savedProfile of [false, true]) {
  test(`runner project fallbacks stay genuine with ${savedProfile ? "unrelated saved profile" : "missing settings"}`, async () => {
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = join(home, ".openscout");
    const scanRoot = join(home, "dev");
    const projectRoot = join(scanRoot, "project");
    const launcher = join(home, "service");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(launcher);
    writeFileSync(join(projectRoot, "package.json"), '{"name":"runner-fallback-fixture"}\n');
    const support = process.env.OPENSCOUT_SUPPORT_DIRECTORY!;
    if (savedProfile) {
      mkdirSync(support, { recursive: true });
      writeFileSync(join(support, "settings.json"), JSON.stringify({ profile: { operatorName: "Fixture Operator" } }));
    }
    stubs.queryAgentsResult = [{ id: "fixture-agent", name: "Fixture", harness: "claude", projectRoot, cwd: projectRoot }];
    for (const currentDirectory of [projectRoot, launcher]) {
      const server = await createOpenScoutWebServer({ currentDirectory, assetMode: "static", staticRoot: makeStaticRoot(), backgroundServices: false });
      const response = await server.app.request("/api/runner/options");
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.defaults.directory).toBe(projectRoot);
      expect(payload.projects[0]).toMatchObject({ root: projectRoot, source: currentDirectory === projectRoot ? "currentDirectory" : "agent" });
      expect(payload.projects.some((project: { source: string }) => project.source === "contextRoot" || project.source === "workspaceRoot")).toBe(false);
      expect(payload.projects.some((project: { root: string }) => project.root === scanRoot)).toBe(false);
    }
  });
}

for (const genuineCwd of [true, false]) {
  test(`real init, identity, and Set up later keep seeded roots manual with ${genuineCwd ? "project cwd" : "service cwd and known project"}`, async () => {
    const home = useIsolatedOpenScoutHome();
    process.env.OPENSCOUT_HOME = join(home, ".openscout");
    const scanRoot = join(home, "dev");
    const projectRoot = join(scanRoot, "project");
    const launcher = join(home, "service");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(launcher);
    writeFileSync(join(projectRoot, "package.json"), '{"name":"real-first-run-fixture"}\n');
    stubs.queryAgentsResult = [{ id: "fixture-agent", name: "Fixture", harness: "claude", projectRoot, cwd: projectRoot }];
    const server = await createFixtureServer(genuineCwd ? projectRoot : launcher);
    for (const [path, body] of [
      ["/api/onboarding/init", {}],
      ["/api/user", { name: "Fixture Operator" }],
      ["/api/onboarding/skip", {}],
    ] as const) {
      const mutation = await server.app.request(path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(mutation.status).toBe(200);
      const saved = readSavedSettings();
      expect(saved.discovery).toMatchObject({ contextRoot: null, workspaceRoots: [scanRoot] });
      const payload = await (await server.app.request("/api/runner/options")).json();
      expect(payload.defaults.directory).toBe(projectRoot);
      expect(payload.projects[0]).toMatchObject({ root: projectRoot, source: genuineCwd ? "currentDirectory" : "agent" });
      expect(payload.projects).toContainEqual(expect.objectContaining({ root: scanRoot, source: "workspaceScanRoot" }));
      expect(payload.projects.some((project: { source: string }) => project.source === "contextRoot" || project.source === "workspaceRoot")).toBe(false);
      expect(existsSync(join(projectRoot, ".openscout", "project.json"))).toBe(false);
      expect(existsSync(join(scanRoot, ".openscout", "project.json"))).toBe(false);
    }
    expect(readSavedSettings().onboarding.skippedAt).toBeNumber();
  });
}

test("legacy seeded roots survive a real identity save without displacing project runtime preferences", async () => {
  const home = useIsolatedOpenScoutHome();
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  const scanRoot = join(home, "dev");
  const projectRoot = join(scanRoot, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeProjectRuntime(scanRoot, "claude-fable-5");
  writeProjectRuntime(projectRoot, "claude-opus-5");
  const support = process.env.OPENSCOUT_SUPPORT_DIRECTORY!;
  mkdirSync(support, { recursive: true });
  writeFileSync(join(support, "settings.json"), JSON.stringify({ discovery: { contextRoot: null, workspaceRoots: [scanRoot] } }));
  const server = await createFixtureServer(projectRoot);
  const saved = await server.app.request("/api/user", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Fixture Operator" }),
  });
  expect(saved.status).toBe(200);
  expect(readSavedSettings().discovery).toMatchObject({ contextRoot: null, workspaceRoots: [scanRoot] });
  const payload = await (await server.app.request("/api/runner/options")).json();
  expect(payload.defaults.directory).toBe(projectRoot);
  expect(payload.projectRoot).toBe(projectRoot);
  expect(payload.projects[0]).toMatchObject({ root: projectRoot, source: "currentDirectory" });
  expect(payload.projects).toContainEqual(expect.objectContaining({ root: scanRoot, source: "workspaceScanRoot" }));
  expect(payload.shortlist).toContainEqual({ harness: "claude", model: "claude-opus-5", origin: "project" });
  expect(payload.shortlist).not.toContainEqual({ harness: "claude", model: "claude-fable-5", origin: "project" });
});

test("intentional workspace-only preferences remain manual choices, including empty folders and explicit remote roots", async () => {
  const home = useIsolatedOpenScoutHome();
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  const currentDirectory = join(home, "project");
  const firstScan = join(home, "empty-scan-a");
  const secondScan = join(home, "empty-scan-b");
  for (const root of [currentDirectory, firstScan, secondScan]) mkdirSync(root, { recursive: true });
  writeFileSync(join(currentDirectory, "package.json"), '{"name":"workspace-only-fixture"}');
  await writeOpenScoutSettings({ discovery: { workspaceRoots: [firstScan, secondScan] } }, { currentDirectory });
  const server = await createFixtureServer(currentDirectory);
  const read = async (root?: string) => (await server.app.request(`/api/runner/options${root ? `?projectRoot=${encodeURIComponent(root)}` : ""}`)).json();
  const initial = await read();
  expect(initial.defaults.directory).toBe(currentDirectory);
  expect(initial.projects.slice(1)).toMatchObject([
    { root: firstScan, source: "workspaceScanRoot" }, { root: secondScan, source: "workspaceScanRoot" },
  ]);
  await writeOpenScoutSettings({ profile: { operatorName: "Unrelated Edit" } }, { currentDirectory });
  expect(readSavedSettings().discovery).toMatchObject({ contextRoot: null, workspaceRoots: [firstScan, secondScan] });
  expect((await read()).defaults.directory).toBe(currentDirectory);
  const explicit = await read(firstScan);
  expect(explicit.defaults.directory).toBe(firstScan);
  expect(explicit.projects[0]).toMatchObject({ root: firstScan, source: "explicit" });
  expect(explicit.projects.filter((project: { root: string }) => project.root === firstScan)).toHaveLength(1);
  const remoteRoot = "/Users/remote/work/workspace-only-fixture";
  const remote = await read(remoteRoot);
  expect(remote.defaults.directory).toBe(remoteRoot);
  expect(remote.projectRoot).toBe(remoteRoot);
  expect(remote.projects[0]).toMatchObject({ root: remoteRoot, source: "explicit" });
  expect(existsSync(remoteRoot)).toBe(false);
});

test("completed empty context remains the default while explicit project scope controls runtime preferences", async () => {
  const home = useIsolatedOpenScoutHome();
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  const currentDirectory = join(home, "service");
  const context = join(home, "empty-context");
  const explicitProject = join(home, "explicit-project");
  for (const root of [currentDirectory, context, explicitProject]) mkdirSync(root, { recursive: true });
  writeProjectRuntime(currentDirectory, "claude-fable-5");
  writeProjectRuntime(explicitProject, "claude-opus-5");
  await writeOpenScoutSettings({
    onboarding: { completedAt: 100 }, discovery: { contextRoot: context, workspaceRoots: [context, explicitProject] },
  }, { currentDirectory });
  const server = await createFixtureServer(currentDirectory);
  const initial = await (await server.app.request("/api/runner/options")).json();
  expect(initial.defaults.directory).toBe(context);
  expect(initial.projectRoot).toBe(context);
  expect(initial.projects[0]).toMatchObject({ root: context, source: "contextRoot" });
  expect(initial.shortlist.some((entry: { origin: string }) => entry.origin === "project")).toBe(false);
  expect(existsSync(join(context, ".openscout"))).toBe(false);
  const explicit = await (await server.app.request(`/api/runner/options?projectRoot=${encodeURIComponent(explicitProject)}`)).json();
  expect(explicit.defaults.directory).toBe(explicitProject);
  expect(explicit.projectRoot).toBe(explicitProject);
  expect(explicit.projects[0]).toMatchObject({ root: explicitProject, source: "explicit" });
  expect(explicit.shortlist).toContainEqual({ harness: "claude", model: "claude-opus-5", origin: "project" });
  expect(explicit.shortlist).not.toContainEqual({ harness: "claude", model: "claude-fable-5", origin: "project" });
});

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

test("configured empty folders outrank service cwd and remain fresh without mutation invalidation", async () => {
  const home = useIsolatedOpenScoutHome();
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  const currentDirectory = join(home, "service");
  const context = join(home, "empty-workspace");
  const workspace = join(home, "empty-scan-folder");
  for (const root of [currentDirectory, context, workspace]) mkdirSync(root, { recursive: true });
  writeFileSync(join(currentDirectory, "package.json"), '{"name":"incidental-service"}');
  writeProjectRuntime(currentDirectory, "claude-fable-5");
  await writeOpenScoutSettings({ discovery: { contextRoot: context, workspaceRoots: [context, workspace] }, agents: { defaultHarness: "claude" } }, { currentDirectory });
  const server = await createOpenScoutWebServer({ currentDirectory, assetMode: "static", staticRoot: makeStaticRoot() });
  const read = async (query = "") => (await server.app.request(`http://localhost/api/runner/options${query}`)).json();
  const first = await read();
  expect(first.defaults.directory).toBe(context);
  expect(first.projectRoot).toBe(context);
  expect(first.projects.slice(0, 2)).toMatchObject([
    { root: context, source: "contextRoot" }, { root: workspace, source: "workspaceRoot" },
  ]);
  expect(first.projects.filter((project: { root: string }) => project.root === context)).toHaveLength(1);
  const explicitCwd = await read(`?projectRoot=${encodeURIComponent(currentDirectory)}`);
  expect(explicitCwd.defaults.directory).toBe(currentDirectory);
  expect(explicitCwd.projects[0]).toMatchObject({ root: currentDirectory, source: "explicit" });
  const remoteRoot = "/Users/remote/work/selected-project";
  const explicitRemote = await read(`?projectRoot=${encodeURIComponent(remoteRoot)}`);
  expect(explicitRemote.defaults.directory).toBe(remoteRoot);
  expect(explicitRemote.projectRoot).toBe(remoteRoot);
  // The CLI or another process can save preferences without hitting a web mutation.
  await writeOpenScoutSettings({ discovery: { contextRoot: workspace, workspaceRoots: [context, workspace] }, agents: { defaultHarness: "codex" } }, { currentDirectory });
  const changed = await read();
  expect(changed.defaults).toMatchObject({ directory: workspace, harness: "codex" });
  expect(changed.projects[0]).toMatchObject({ root: workspace, source: "contextRoot", defaultHarness: "codex" });
  writeProjectRuntime(context, "claude-opus-5");
  rmSync(workspace, { recursive: true });
  const removed = await read();
  expect(removed.defaults.directory).toBe("");
  expect(removed.projectRoot).toBe(workspace);
  expect(removed.projects).toContainEqual(expect.objectContaining({ root: context, source: "workspaceScanRoot" }));
  expect(removed.projects.some((project: { source: string }) => project.source === "contextRoot" || project.source === "workspaceRoot")).toBe(false);
  expect(removed.projects.some((project: { root: string }) => project.root === workspace)).toBe(false);
  expect(removed.shortlist.some((entry: { origin: string }) => entry.origin === "project")).toBe(false);
  expect(existsSync(workspace)).toBe(false);
  const explicitAfterRemoval = await read(`?projectRoot=${encodeURIComponent(context)}`);
  expect(explicitAfterRemoval.defaults.directory).toBe(context);
  expect(explicitAfterRemoval.projectRoot).toBe(context);
  expect(explicitAfterRemoval.projects[0]).toMatchObject({ root: context, source: "explicit" });
  expect(explicitAfterRemoval.shortlist).toContainEqual({ harness: "claude", model: "claude-opus-5", origin: "project" });
  const remoteAfterRemoval = await read(`?projectRoot=${encodeURIComponent(remoteRoot)}`);
  expect(remoteAfterRemoval.defaults.directory).toBe(remoteRoot);
  expect(remoteAfterRemoval.projectRoot).toBe(remoteRoot);
  await writeOpenScoutSettings({ discovery: { contextRoot: context } }, { currentDirectory });
  const replaced = await read();
  expect(replaced.defaults.directory).toBe(context);
  expect(replaced.projectRoot).toBe(context);
  expect(replaced.projects[0]).toMatchObject({ root: context, source: "contextRoot" });
});
