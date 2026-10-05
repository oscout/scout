import { describe, expect, mock, test } from "bun:test";
import type { OnboardingState } from "../Provider.tsx";

// @ts-expect-error Runtime entrypoints avoid the local TS declaration aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Runtime entrypoints avoid the local TS declaration aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Runtime entrypoints avoid the local TS declaration aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Runtime entrypoints avoid the local TS declaration aliases.
const { renderToStaticMarkup } = await import("../../../node_modules/react-dom/server.node.js");
mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
const mutationRequests: Array<{ path: string; init?: RequestInit }> = [];
let mutationResponse: { state?: OnboardingState } = {};
let mutationError: Error | null = null;
mock.module("../../lib/api.ts", () => ({ api: async (path: string, init?: RequestInit) => {
  mutationRequests.push({ path, init });
  if (mutationError) throw mutationError;
  return mutationResponse;
} }));
let state: OnboardingState;
mock.module("../Provider.tsx", () => ({ useScout: () => ({ onboarding: state, refreshOnboarding: async () => {}, skipOnboarding: async () => {} }) }));
const { OnboardingTakeover, submitOnboardingMutation } = await import("./OnboardingTakeover.tsx");
const base: OnboardingState = {
  hasLocalConfig: true, hasOperatorName: true, hasProjectConfig: false,
  localConfigPath: "/home/arach/.openscout/config.json", projectRoot: null,
  currentDirectory: "/home/arach/node_modules/@openscout/scout", contextRoot: null, suggestedContextRoot: null,
  sourceRoots: ["/home/arach/dev"], operatorName: "Arach", operatorNameSuggestion: "Arach",
  defaultHarness: "codex", brokerReachable: true, hasReadyRuntime: false, needed: true,
};
const render = () => renderToStaticMarkup(React.createElement(OnboardingTakeover));

describe("onboarding mutation state reuse", () => {
  for (const path of ["/api/onboarding/init", "/api/user", "/api/onboarding/project"]) {
    test(`${path} applies its returned state without requesting it again`, async () => {
      mutationRequests.length = 0;
      const next = { ...base, hasProjectConfig: true, contextRoot: "/home/arach/dev/alpha" };
      mutationResponse = { state: next };
      const applied: Array<OnboardingState | undefined> = [];
      await submitOnboardingMutation(path, { name: "Arach" }, async (value) => { applied.push(value); });
      expect(mutationRequests).toHaveLength(1);
      expect(mutationRequests[0]).toMatchObject({ path, init: { method: "POST", body: '{"name":"Arach"}' } });
      expect(applied).toEqual([next]);
    });
  }

  test("older mutation responses request a normal provider refresh, and failures preserve state", async () => {
    const applied: Array<OnboardingState | undefined> = [];
    mutationResponse = {};
    await submitOnboardingMutation("/api/user", { name: "Arach" }, async (value) => { applied.push(value); });
    expect(applied).toEqual([undefined]);
    mutationError = new Error("write failed");
    try {
      await expect(submitOnboardingMutation("/api/user", { name: "Arach" }, async (value) => { applied.push(value); })).rejects.toThrow("write failed");
      expect(applied).toEqual([undefined]);
    } finally { mutationError = null; }
  });
});

describe("first-run project and selected-agent guidance", () => {
  test("a packaged launch asks for a workspace instead of selecting its runtime directory or scan suggestion", () => {
    state = base;
    const html = render();
    expect(html).toContain('aria-label="Scan folder 1"');
    expect(html).toContain('value="/home/arach/dev"');
    expect(html).toContain('id="scout-onboarding-context"');
    expect(html).toContain('placeholder="Choose an existing project folder"');
    expect(html).toContain("Choose existing folders");
    expect(html).toContain('value=""');
    expect(html).not.toContain("node_modules");
    expect(html).toContain('disabled=""');
  });

  test("a real project suggestion is shown in the workspace field", () => {
    state = { ...base, suggestedContextRoot: "/home/arach/dev/alpha" };
    expect(render()).toContain('value="/home/arach/dev/alpha"');
  });

  test("unfinished setup returns to project selection if no chosen context is available", () => {
    state = { ...base, hasProjectConfig: true };
    const html = render();
    expect(html).toContain('id="scout-onboarding-context"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Finish setup");
  });

  test("missing Codex shows its install command and guide, without presenting another agent as ready", () => {
    state = { ...base, hasProjectConfig: true, projectRoot: "/home/arach/dev/alpha", selectedHarness: {
      id: "codex", label: "Codex", state: "missing", ready: false, detail: "Codex is not installed yet.",
      installCommand: "npm install -g @openai/codex", homepage: "https://developers.openai.com/codex/cli/",
    }, harnesses: [{ id: "claude", label: "Claude Code", state: "ready", ready: true, detail: "Local setup found." }] };
    const html = render();
    expect(html).toContain("Codex is not installed yet.");
    expect(html).toContain("npm install -g @openai/codex");
    expect(html).toContain("Codex setup guide");
    expect(html).toContain("Check again");
    expect(html).toContain("Local setup found");
    expect(html).not.toContain("task completed");
  });

  test("logged-out Codex shows the login action", () => {
    state = { ...base, hasProjectConfig: true, contextRoot: "/home/arach/dev/alpha", selectedHarness: {
      id: "codex", label: "Codex", state: "installed", ready: false, detail: "Codex is installed but not authenticated yet.", loginCommand: "codex login",
    } };
    const html = render();
    expect(html).toContain("Sign in to this agent in Terminal");
    expect(html).toContain("codex login");
    expect(html).toContain("Check again");
  });

  test("a locally unverified agent has an honest escape path", () => {
    state = { ...base, hasProjectConfig: true, contextRoot: "/home/arach/dev/alpha", defaultHarness: "cursor", selectedHarness: {
      id: "cursor", label: "Cursor", state: "configured", ready: false, detail: "Cursor is installed. Sign-in isn't checked here.",
    } };
    const html = render();
    expect(html).toContain("Sign-in needs to be confirmed by the agent itself");
    expect(html).toContain("Set up later");
    expect(html).toContain("choose another agent");
    expect(html).not.toContain("Sign in to this agent in Terminal");
  });
});
