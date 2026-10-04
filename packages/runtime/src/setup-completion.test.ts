import { expect, test } from "bun:test";
import { assessSetupCompletion } from "./setup-completion.js";
const input = (ready = true) => ({ broker: { health: { ok: true } }, catalog: { entries: [{ harness: "codex", readinessReport: { state: ready ? "ready" : "installed", ready, configured: ready, installed: true, loginCommand: "codex login" } }] } });
const local = { platform: "darwin", interactive: true, appUsable: false, ssh: false, webPort: 43120 };
test("ready app/browser/platform destinations", () => {
  expect(assessSetupCompletion(input(), local).nextStep).toBe("scout server open");
  expect(assessSetupCompletion(input(), { ...local, appUsable: true }).nextStep).toBe("scout menu");
  const linux = assessSetupCompletion(input(), { ...local, platform: "linux", appUsable: true });
  expect(linux.nextStep).toBe("scout server open");
  expect(linux.alsoAvailable.join(" ")).not.toContain("Mac app");
});
test("unhealthy and partial failure are failure, with recovery", () => {
  expect(assessSetupCompletion({ ...input(), broker: { health: { ok: false } } }, local).outcome).toBe("failed");
  expect(assessSetupCompletion({ ...input(), failures: ["error"] }, local).nextStep).toBe("scout setup");
  expect(assessSetupCompletion({ ...input(), broker: { health: { ok: false }, serviceAdapter: "headless-foreground" } }, local).nextStep).toBe("openscout-runtime broker");
});
test("headless foreground handoff is its own outcome: not ready, not failed", () => {
  const headlessDown = { health: { ok: false }, serviceAdapter: "headless-foreground" };
  const brokerHandoff = { command: "openscout-runtime broker" };
  // Even with a ready harness, a broker the operator hasn't started isn't "ready".
  const handoff = assessSetupCompletion({ ...input(), broker: headlessDown, brokerHandoff }, local);
  expect(handoff.outcome).toBe("handoff");
  expect(handoff.headline).toBe("Scout is set up. Start the broker to finish.");
  expect(handoff.nextStep).toBe("openscout-runtime broker");
  expect(handoff.alsoAvailable.join(" ")).not.toContain("scout doctor");

  // The handoff only excuses the broker being down; real failures still fail.
  expect(assessSetupCompletion({ ...input(), broker: headlessDown, brokerHandoff, failures: ["skill install failed"] }, local).outcome).toBe("failed");
  expect(assessSetupCompletion({ ...input(), broker: headlessDown, brokerHandoff, brokerWarning: "spawn failed" }, local).outcome).toBe("failed");
  expect(assessSetupCompletion({ ...input(), broker: headlessDown, brokerHandoff, localEdge: { status: "error" } }, local).outcome).toBe("failed");
  // Without a handoff (e.g. a reachable but unhealthy headless broker), down is a failure.
  expect(assessSetupCompletion({ ...input(), broker: headlessDown }, local).outcome).toBe("failed");
  // A broker that appeared but is unhealthy must not be excused by a stale handoff.
  expect(assessSetupCompletion({ ...input(), broker: { ...headlessDown, reachable: true }, brokerHandoff }, local).outcome).toBe("failed");
  // A handoff recorded while the broker is actually healthy changes nothing.
  expect(assessSetupCompletion({ ...input(), brokerHandoff }, local).outcome).toBe("ready");
});
test("no authenticated harness uses observed login, unknown never ready", () => {
  expect(assessSetupCompletion(input(false), local).nextStep).toBe("codex login");
  const unknown = { ...input(), catalog: { entries: [{ readinessReport: { ready: true, state: "unknown" } }] } };
  expect(assessSetupCompletion(unknown, local).outcome).toBe("running");
  expect(assessSetupCompletion(unknown, local).nextStep).toBe("scout runtimes");
  const configured = input(false);
  configured.catalog.entries[0]!.readinessReport.configured = true;
  expect(assessSetupCompletion(configured, local).nextStep).toBe("scout runtimes");
});
test("SSH, non-TTY and JSON presentation never recommends GUI as primary", () => {
  for (const surface of [{ ...local, ssh: true }, { ...local, interactive: false }]) {
    const result = assessSetupCompletion(input(), surface);
    expect(result.nextStep).toBe("scout whoami");
    expect(result.browserGuidance).toContain("scout server start");
  }
  expect(assessSetupCompletion(input(), { ...local, ssh: true }).browserGuidance).toContain("ssh -N -L 43120:127.0.0.1:43120");
});

test("app detection requires an executable embedded menu, not just a bundle", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hasUsableScoutApp } = await import("./setup-completion.js");
  const home = mkdtempSync(join(tmpdir(), "scout-app-test-"));
  try {
    const binary = join(home, "Applications/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "fixture");
    // Non-macOS must never recommend the native path even with a usable fixture.
    expect(hasUsableScoutApp("linux", home)).toBe(false);
    chmodSync(binary, 0o755);
    expect(hasUsableScoutApp("darwin", home)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("attempted local-edge failure fails; optional unavailable/not-needed edge does not", () => {
  const failed = assessSetupCompletion({ ...input(), localEdge: { status: "error" } }, local);
  expect(failed.outcome).toBe("failed");
  expect(failed.headline).toBe("Scout setup failed.");
  expect(failed.nextStep).toBe("scout setup");
  for (const status of ["missing", "skipped", "ready", "installed"]) {
    expect(assessSetupCompletion({ ...input(), localEdge: { status } }, local).outcome).toBe("ready");
    expect(assessSetupCompletion({ ...input(false), localEdge: { status } }, local).outcome).toBe("running");
  }
});
