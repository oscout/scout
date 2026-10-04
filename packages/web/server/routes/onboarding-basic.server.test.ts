import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

await loadWebServerUnderTest();
installWebServerTestHooks();

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

async function basicServer() {
  const home = useIsolatedOpenScoutHome();
  process.env.OPENSCOUT_HOME = `${home}/.openscout`;
  delete process.env.OPENSCOUT_OPERATOR_NAME;
  const currentDirectory = mkdtempSync(join(tmpdir(), "openscout-onboarding-cwd-"));
  testDirectories.add(currentDirectory);
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
});
