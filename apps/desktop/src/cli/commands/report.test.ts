import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("CLI dispatch saves a report without broker maintenance or connectivity", async () => {
  const root = await mkdtemp(join(tmpdir(), "scout-report-cli-"));
  try {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../main.ts"), "report", "Broker down", "--local-only", "--json"], {
      env: { ...process.env, OPENSCOUT_SUPPORT_DIRECTORY: join(root, "support"), OPENSCOUT_CONTROL_HOME: join(root, "control"), OPENSCOUT_BROKER_URL: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("restart");
    const receipt = JSON.parse(stdout);
    expect(receipt.status).toBe("saved");
    const report = JSON.parse(await readFile(receipt.localPath, "utf8"));
    expect(report.context.userDescription).toBe("Broker down");
    expect(report.context.reportSections.length).toBeGreaterThan(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
