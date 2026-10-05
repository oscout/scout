import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Exercise real state reads and durable project saves without installing or
// starting services. Setup must receive the chosen folder, never package cwd.
const onboarding = await import("@openscout/runtime/onboarding");
const loadOnboardingState = onboarding.loadOpenScoutOnboardingState;
const setupCalls: Array<{ currentDirectory: string; contextRoot: string }> = [];
mock.module("@openscout/runtime/onboarding", () => ({
  ...onboarding,
  runOpenScoutOnboardingSetup: async (input: { currentDirectory: string; contextRoot: string }) => {
    setupCalls.push(input);
    const state = await loadOnboardingState({ currentDirectory: input.currentDirectory });
    return { setup: { currentProjectConfigPath: state.projectConfigPath }, broker: { reachable: false }, brokerWarning: null, state };
  },
}));
await loadWebServerUnderTest();
installWebServerTestHooks();

const originalSetupCwd = process.env.OPENSCOUT_SETUP_CWD;
afterEach(() => {
  if (originalSetupCwd === undefined) delete process.env.OPENSCOUT_SETUP_CWD;
  else process.env.OPENSCOUT_SETUP_CWD = originalSetupCwd;
});

type OnboardingBody = {
  needed: boolean;
  hasOperatorName: boolean;
  skippedAt: number | null;
  completedAt: number | null;
};

/** The static root `scout web` serves from the npm package: the basic client. */
function makeBasicStaticRoot(): string {
  const root = makeStaticRoot();
  writeFileSync(join(root, "scout-web-profile.json"), `${JSON.stringify({ profile: "basic" })}\n`);
  return root;
}

async function basicServer(options: { packaged?: boolean } = {}) {
  const home = useIsolatedOpenScoutHome();
  process.env.OPENSCOUT_HOME = `${home}/.openscout`;
  delete process.env.OPENSCOUT_OPERATOR_NAME;
  delete process.env.OPENSCOUT_SETUP_CWD;
  setupCalls.length = 0;
  const currentDirectory = options.packaged
    ? join(home, ".bun", "install", "global", "node_modules", "@openscout", "scout")
    : mkdtempSync(join(tmpdir(), "openscout-onboarding-cwd-"));
  if (options.packaged) {
    mkdirSync(currentDirectory, { recursive: true });
    writeFileSync(join(currentDirectory, "package.json"), '{"name":"@openscout/scout"}');
    // Match broker-web-control-service and web/server/index.ts production env.
    process.env.OPENSCOUT_SETUP_CWD = currentDirectory;
  } else testDirectories.add(currentDirectory);
  return createOpenScoutWebServer({
    currentDirectory,
    assetMode: "static",
    staticRoot: makeBasicStaticRoot(),
  });
}

async function state(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, path = "/api/onboarding/state", init?: RequestInit) {
  const response = await app.request(`http://localhost${path}`, init);
  expect(response.status).toBe(200);
  return await response.json() as OnboardingBody;
}

describe("basic web server: first-run routes", () => {
  test("a fresh machine reports setup as needed, with no name and nothing skipped or completed", async () => {
    const server = await basicServer();
    const body = await state(server.app);
    expect(body.needed).toBe(true);
    expect(body.hasOperatorName).toBe(false);
    expect(body.skippedAt).toBeNull();
    expect(body.completedAt).toBeNull();
  });

  test("skip sets setup aside without completing it, and restart re-arms it", async () => {
    const server = await basicServer();
    const skipped = await state(server.app, "/api/onboarding/skip", { method: "POST", body: "{}" });
    expect(typeof skipped.skippedAt).toBe("number");
    expect(skipped.completedAt).toBeNull();
    expect(skipped.needed).toBe(false);
    // Skipping is durable: a reload doesn't bring the takeover back.
    expect((await state(server.app)).skippedAt).toBe(skipped.skippedAt);

    const resumed = await state(server.app, "/api/onboarding/restart", { method: "POST", body: "{}" });
    expect(resumed.skippedAt).toBeNull();
    expect(resumed.completedAt).toBeNull();
    expect(resumed.needed).toBe(true);
  });

  test("Solo Pro status is served beside the basic client, unchecked until asked", async () => {
    const server = await basicServer();
    const response = await server.app.request("http://localhost/api/solo-pro");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      phase: string;
      access: { state: string; actions: Array<{ kind: string }> };
      components: Array<{ id: string; ready: string }>;
    };
    // No download key read, no host asked: access is unknown, never assumed.
    expect(body.phase).toBe("unconfirmed");
    expect(body.access.state).toBe("unchecked");
    expect(body.access.actions.some((action) => action.kind === "check_access")).toBe(true);
    // The basic client being served is not the full web app.
    expect(body.components.find((component) => component.id === "full_web_app")?.ready).not.toBe("ready");
  });

  test("Settings › Solo Pro is a basic client page, not a 404", async () => {
    const server = await basicServer();
    const response = await server.app.request("http://localhost/settings/pro", { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
  });

  test("state carries the eight setup choices with locally observed readiness", async () => {
    const server = await basicServer();
    const response = await server.app.request("http://localhost/api/onboarding/state");
    const body = await response.json() as {
      defaultHarness: string;
      harnesses?: Array<{ id: string; label: string; state: string; ready: boolean; detail: string }>;
    };
    expect(body.harnesses?.map((choice) => choice.id)).toEqual(["claude", "codex", "grok-acp", "kimi", "cursor", "opencode", "pi", "devin"]);
    for (const choice of body.harnesses ?? []) {
      expect(["ready", "configured", "installed", "missing"]).toContain(choice.state);
      expect(typeof choice.ready).toBe("boolean");
      expect(choice.label.length).toBeGreaterThan(0);
    }
    expect(body.defaultHarness).toBe("claude");
    expect((await server.app.request("http://localhost/api/onboarding/harnesses")).status).not.toBe(200);
  });

  test("an unknown harness is a 400 with the choices, never a silent switch to Claude", async () => {
    const server = await basicServer();
    const contextRoot = mkdtempSync(join(tmpdir(), "openscout-onboarding-project-"));
    testDirectories.add(contextRoot);
    const response = await server.app.request("http://localhost/api/onboarding/project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextRoot, sourceRoots: [contextRoot], defaultHarness: "flue" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; choices: string[] };
    expect(body.error).toContain("flue");
    expect(body.choices).toContain("kimi");
    // Nothing was saved: setup still shows the old default.
    expect((await state(server.app)).needed).toBe(true);
  });

  test("setup with no selected project rejects the request before writing into the service cwd", async () => {
    const server = await basicServer();
    const response = await server.app.request("http://localhost/api/onboarding/setup", { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Choose an existing project folder before running setup.");
  });

  test("a file cannot be saved as a project folder", async () => {
    const server = await basicServer();
    const home = process.env.OPENSCOUT_HOME!;
    const file = join(home, "not-a-folder.txt");
    writeFileSync(file, "test");
    const response = await server.app.request("http://localhost/api/onboarding/project", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextRoot: file, sourceRoots: [file], defaultHarness: "codex" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(file);
  });

  test("a broker-injected package cwd cannot be selected before or after saving a real project", async () => {
    const server = await basicServer({ packaged: true });
    const packaged = process.env.OPENSCOUT_SETUP_CWD!;
    const before = await (await server.app.request("http://localhost/api/onboarding/state")).json();
    expect(before.contextRoot).toBeNull();
    expect(before.suggestedContextRoot).toBeNull();
    const refused = await server.app.request("http://localhost/api/onboarding/setup", { method: "POST", body: "{}" });
    expect(refused.status).toBe(400);
    expect(setupCalls).toHaveLength(0);

    const project = join(process.env.HOME!, "dev", "alpha");
    mkdirSync(join(project, ".openscout"), { recursive: true });
    writeFileSync(join(project, ".openscout", "project.json"), JSON.stringify({ version: 1, project: { id: "alpha", name: "Alpha", root: "." } }));
    const saved = await server.app.request("http://localhost/api/onboarding/project", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextRoot: project, sourceRoots: [project], defaultHarness: "codex" }),
    });
    expect(saved.status).toBe(200);
    const after = await (await server.app.request("http://localhost/api/onboarding/state")).json();
    expect(after.contextRoot).toBe(project);
    expect(after.projectRoot).toBe(project);
    expect(after.hasProjectConfig).toBe(true);
    const setup = await server.app.request("http://localhost/api/onboarding/setup", { method: "POST", body: "{}" });
    expect(setup.status).toBe(200);
    expect(setupCalls.map((call) => call.currentDirectory)).toEqual([project, project]);
    expect(existsSync(join(packaged, ".openscout"))).toBe(false);
  });

  test("setup rejects a removed saved workspace before creating it again", async () => {
    const server = await basicServer({ packaged: true });
    const project = join(process.env.HOME!, "dev", "alpha");
    mkdirSync(project, { recursive: true });
    const saved = await server.app.request("http://localhost/api/onboarding/project", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contextRoot: project, sourceRoots: [project], defaultHarness: "codex" }),
    });
    expect(saved.status).toBe(200);
    setupCalls.length = 0;
    rmSync(project, { recursive: true });
    const refused = await server.app.request("http://localhost/api/onboarding/setup", { method: "POST", body: "{}" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("no longer available");
    expect(setupCalls).toHaveLength(0);
    expect(existsSync(project)).toBe(false);
  });
});
