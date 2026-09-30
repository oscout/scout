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

test("feedback reads its note from a file and names the CLI and sender", async () => {
  const root = await mkdtemp(join(tmpdir(), "scout-feedback-cli-"));
  try {
    const note = join(root, "note.md");
    await Bun.write(note, "Composer clips the send button.\n\nSeen on iPhone 13 mini.");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../main.ts"), "feedback", "--file", note, "--local-only", "--json"], {
      env: { ...process.env, OPENSCOUT_AGENT: "openscout-bartok", OPENSCOUT_SUPPORT_DIRECTORY: join(root, "support"), OPENSCOUT_CONTROL_HOME: join(root, "control"), OPENSCOUT_BROKER_URL: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(JSON.parse(stdout).localPath, "utf8"));
    expect(report.context.userDescription).toBe("Composer clips the send button.\n\nSeen on iPhone 13 mini.");
    expect(report.context.source).toBe("Scout cli v1");
    const sender = report.context.reportSections.find((section: { id: string }) => section.id === "reporter");
    expect(sender.entries).toContainEqual({ label: "agentName", value: "openscout-bartok" });
    expect(report.logs).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("feedback reads its note from stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "scout-feedback-stdin-"));
  try {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../main.ts"), "feedback", "-", "--local-only", "--json"], {
      env: { ...process.env, OPENSCOUT_SUPPORT_DIRECTORY: join(root, "support"), OPENSCOUT_CONTROL_HOME: join(root, "control"), OPENSCOUT_BROKER_URL: "http://127.0.0.1:1" },
      stdin: new Blob(["piped note"]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    const report = JSON.parse(await readFile(JSON.parse(stdout).localPath, "utf8"));
    expect(report.context.userDescription).toBe("piped note");
  } finally { await rm(root, { recursive: true, force: true }); }
});
