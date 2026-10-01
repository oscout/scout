import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SlackCredentialReference } from "@openscout/protocol";

export type SlackWorkerCommand = { executable: string; args: string[] };
export type SlackWorkerIdentity = { teamId: string; appId: string; botId: string; botUserId: string };

/** Resolve only the companion shipped with this checkout/package, never an agent-supplied command. */
export function resolveSlackWorkerCommand(): SlackWorkerCommand {
  const built = fileURLToPath(new URL("../../slack/dist/main.js", import.meta.url));
  if (existsSync(built)) return { executable: process.execPath, args: [built] };
  const source = fileURLToPath(new URL("../../slack/src/main.ts", import.meta.url));
  if (process.versions.bun && existsSync(source)) return { executable: process.execPath, args: [source] };
  throw new Error("Slack companion is unavailable. Build or install the private Slack companion on this broker host.");
}

export function slackSecretCommand(reference: SlackCredentialReference, worker: SlackWorkerCommand, args: string[]): SlackWorkerCommand {
  const key = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
  if (!(["secret_cli", "private_file"] as string[]).includes(reference.backend) || !key.test(reference.appTokenKey) || !key.test(reference.botTokenKey)
    || /^(xapp|xoxb)-/.test(reference.appTokenKey) || /^(xapp|xoxb)-/.test(reference.botTokenKey)
    || reference.appTokenKey === reference.botTokenKey) throw new Error("Provide two distinct credential entry names, never token values.");
  if (reference.backend === "private_file") return { executable: worker.executable, args: [...worker.args, "with-private-credentials", "--app-key", reference.appTokenKey, "--bot-key", reference.botTokenKey, "--", ...args] };
  return { executable: "secret", args: ["run", "--map", `${reference.appTokenKey}=SLACK_APP_TOKEN`, "--map", `${reference.botTokenKey}=SLACK_BOT_TOKEN`, "--", worker.executable, ...worker.args, ...args] };
}

/** Bounded, silent verifier. Child stdout is a token-free identity receipt only. */
export async function verifySlackWorkerCredentials(input: {
  reference: SlackCredentialReference; teamId: string; appId: string;
}, options: { worker?: SlackWorkerCommand; timeoutMs?: number; secretExecutable?: string } = {}): Promise<SlackWorkerIdentity> {
  const command = slackSecretCommand(input.reference, options.worker ?? resolveSlackWorkerCommand(), ["verify-installation", "--team", input.teamId, "--app", input.appId]);
  return new Promise((resolve, reject) => {
    const child = spawn(options.secretExecutable ?? command.executable, command.args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, SLACK_APP_TOKEN: "", SLACK_BOT_TOKEN: "" } });
    let output = "";
    let settled = false;
    const kill = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(new Error("Slack credential verification failed. Check the local credential helper, its entries, and the app installation. No credential values were returned."));
    };
    const timer = setTimeout(fail, options.timeoutMs ?? 60_000);
    child.on("error", fail);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.length > 4096) fail();
    });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) { fail(); return; }
      try {
        const value = JSON.parse(output) as SlackWorkerIdentity;
        if (value.teamId !== input.teamId || value.appId !== input.appId || !/^B[A-Z0-9]+$/.test(value.botId) || !/^[UW][A-Z0-9]+$/.test(value.botUserId)) { fail(); return; }
        settled = true;
        clearTimeout(timer);
        // Whitelist the receipt; never spread arbitrary child output.
        resolve({ teamId: value.teamId, appId: value.appId, botId: value.botId, botUserId: value.botUserId });
      } catch { fail(); }
    });
  });
}
