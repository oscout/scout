import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { slackSecretCommand, verifySlackWorkerCredentials } from "./slack-worker-process.js";
const reference = { backend: "secret_cli" as const, appTokenKey: "LATTICES_APP", botTokenKey: "LATTICES_BOT" };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function wrapper(output: string, hang = false) {
  const dir = mkdtempSync(join(tmpdir(), "scout-slack-verifier-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "secret-test");
  // A trusted fixture replaces the secret wrapper; never invokes a real vault.
  writeFileSync(file, `#!/bin/sh\n${hang ? "sleep 30" : `printf '%s' '${output.replaceAll("'", "'\\''")}'`}\n`, { mode: 0o700 });
  return file;
}
test("credential wrapper carries names and a fixed child command, never token values", () => {
  const command = slackSecretCommand(reference, { executable: "/node", args: ["/slack/main.js"] }, ["verify-installation"]);
  expect(command.args).toEqual(["run", "--map", "LATTICES_APP=SLACK_APP_TOKEN", "--map", "LATTICES_BOT=SLACK_BOT_TOKEN", "--", "/node", "/slack/main.js", "verify-installation"]);
  expect(() => slackSecretCommand({ ...reference, appTokenKey: "xapp-secret" }, { executable: "/node", args: [] }, [])).toThrow("never token");
});
test("whitelists successful identity output and drops arbitrary extra values", async () => {
  const receipt = await verifySlackWorkerCredentials({ reference, teamId: "T123", appId: "A123" }, {
    worker: { executable: "/unused", args: [] }, secretExecutable: wrapper(JSON.stringify({ teamId: "T123", appId: "A123", botId: "B123", botUserId: "U123", unexpected: "SECRET_SENTINEL" })),
  });
  expect(receipt).toEqual({ teamId: "T123", appId: "A123", botId: "B123", botUserId: "U123" });
});
test("rejects malformed output and terminates a stuck verifier without leaking it", async () => {
  for (const secretExecutable of [wrapper("SECRET_SENTINEL"), wrapper("", true)]) {
    await expect(verifySlackWorkerCredentials({ reference, teamId: "T123", appId: "A123" }, { worker: { executable: "/unused", args: [] }, secretExecutable, timeoutMs: 100 })).rejects.toThrow("No credential values were returned");
  }
});

test("private file backend invokes only the companion with entry names", () => {
  expect(slackSecretCommand({ ...reference, backend: "private_file" }, { executable: "/node", args: ["/slack/main.js"] }, ["project-worker"]))
    .toEqual({ executable: "/node", args: ["/slack/main.js", "with-private-credentials", "--app-key", "LATTICES_APP", "--bot-key", "LATTICES_BOT", "--", "project-worker"] });
});
