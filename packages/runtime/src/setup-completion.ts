import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveWebPort } from "./local-config.js";

export type SetupCompletion = {
  outcome: "ready" | "running" | "failed";
  headline: string;
  nextStep: string;
  alsoAvailable: string[];
  webUrl: string;
  browserGuidance: string | null;
};

/** Presence alone is not enough: menu needs the shipped executable helper. */
export function hasUsableScoutApp(platform = process.platform, home = homedir()): boolean {
  if (platform !== "darwin") return false;
  return ["Scout.app", "OpenScout.app"].some((name) =>
    ["/Applications", join(home, "Applications")].some((root) => {
      try {
        accessSync(join(root, name, "Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu"), constants.X_OK);
        return true;
      } catch { return false; }
    }),
  );
}

export function assessSetupCompletion(input: {
  broker: { health: { ok: boolean }; serviceAdapter?: string };
  brokerWarning?: string | null;
  catalog: { entries: Array<{ harness?: string; readinessReport: { ready?: boolean; state?: string; installed?: boolean; configured?: boolean; loginCommand?: string | null } }> };
  defaultHarness?: string;
  failures?: string[];
  localEdge?: { status: string };
}, surface: {
  platform?: string;
  appUsable?: boolean;
  interactive?: boolean;
  ssh?: boolean;
  webPort?: number;
} = {}): SetupCompletion {
  const platform = surface.platform ?? process.platform;
  const port = surface.webPort ?? resolveWebPort();
  const remote = surface.ssh ?? Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  const interactive = surface.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const app = platform === "darwin" && (surface.appUsable ?? hasUsableScoutApp(platform));
  const failed = !input.broker.health.ok || Boolean(input.brokerWarning) || Boolean(input.failures?.length) || input.localEdge?.status === "error";
  // Only an explicit positive observation is task readiness; installed/unknown is not.
  const ready = input.catalog.entries.some((entry) => entry.readinessReport.ready === true && entry.readinessReport.state === "ready");
  const candidates = [...input.catalog.entries].sort((a, b) => Number(b.harness === input.defaultHarness) - Number(a.harness === input.defaultHarness));
  const login = candidates.find((entry) => entry.readinessReport.installed && entry.readinessReport.configured === false && !entry.readinessReport.ready && entry.readinessReport.loginCommand)?.readinessReport.loginCommand;
  const outcome = failed ? "failed" : ready ? "ready" : "running";
  return {
    outcome,
    headline: failed ? "Scout setup failed." : ready ? "Scout is ready." : "Scout is running. No agent is ready yet.",
    nextStep: failed
      ? (!input.broker.health.ok && input.broker.serviceAdapter === "headless-foreground" ? "openscout-runtime broker" : "scout setup")
      : !ready ? login ?? "scout runtimes" : remote || !interactive ? "scout whoami" : app ? "scout menu" : "scout server open",
    alsoAvailable: [
      "scout server open — browser (local desktop)",
      ...(platform === "darwin" ? [app ? "scout menu — Mac app" : "scout install — optional Mac app installation"] : []),
      "scout pair — phone pairing",
      "scout --help — terminal and coding-agent tools",
      ...(failed ? ["scout doctor — optional troubleshooting"] : []),
    ],
    webUrl: `http://127.0.0.1:${port}`,
    browserGuidance: remote
      ? `Run scout server start on this host; from your computer: ssh -N -L ${port}:127.0.0.1:${port} <ssh-host>, then open http://127.0.0.1:${port}.`
      : !interactive ? `Run scout server start, then open http://127.0.0.1:${port} on this host. Setup does not open a GUI.` : null,
  };
}
