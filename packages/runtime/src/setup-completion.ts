import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveWebPort } from "./local-config.js";

export type SetupCompletion = {
  /**
   * `handoff`: setup finished its part, and the broker is the operator's to
   * start (headless foreground adapter). Not ready, not failed, not running.
   */
  outcome: "ready" | "running" | "handoff" | "failed";
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
  broker: { health: { ok: boolean }; reachable?: boolean; serviceAdapter?: string };
  brokerWarning?: string | null;
  brokerHandoff?: { command: string } | null;
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
  // An intended broker handoff only excuses the broker being down; any other
  // warning or install failure still fails setup.
  const handoff = !input.broker.health.ok && input.broker.reachable !== true ? input.brokerHandoff ?? null : null;
  const failed = (!input.broker.health.ok && !handoff) || Boolean(input.brokerWarning) || Boolean(input.failures?.length) || input.localEdge?.status === "error";
  // A ready alternative cannot complete setup for the agent the user chose.
  // Older callers without a default retain their any-agent interpretation.
  const candidates = input.defaultHarness
    ? input.catalog.entries.filter((entry) => entry.harness === input.defaultHarness)
    : input.catalog.entries;
  const ready = candidates.some((entry) => entry.readinessReport.ready === true && entry.readinessReport.state === "ready");
  const login = candidates.find((entry) => entry.readinessReport.installed && entry.readinessReport.configured === false && !entry.readinessReport.ready && entry.readinessReport.loginCommand)?.readinessReport.loginCommand;
  const outcome = failed ? "failed" : handoff ? "handoff" : ready ? "ready" : "running";
  return {
    outcome,
    headline: failed
      ? "Scout setup failed."
      : handoff
        ? "Scout is set up. Start the broker to finish."
        : ready ? "Scout is ready." : input.defaultHarness
          ? "Scout is running. Your chosen coding agent still needs setup."
          : "Scout is running. No agent is ready yet.",
    nextStep: failed
      ? (!input.broker.health.ok && input.broker.serviceAdapter === "headless-foreground" ? "openscout-runtime broker" : "scout setup")
      : handoff ? handoff.command
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
