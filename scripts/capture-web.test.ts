import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureWeb, parseCaptureArgs } from "./capture-web.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-capture-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeChrome(directory: string, writesCapture: boolean): string {
  const path = join(directory, writesCapture ? "fake-chrome-success.mjs" : "fake-chrome-timeout.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const output = process.argv.find((arg) => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);
if (process.env.OPENSCOUT_CAPTURE_TEST_PID_FILE) {
  writeFileSync(process.env.OPENSCOUT_CAPTURE_TEST_PID_FILE, String(process.pid));
}
${writesCapture ? "if (output) writeFileSync(output, Buffer.from('fake-png'));" : "void output;"}
setInterval(() => {}, 1_000);
`);
  chmodSync(path, 0o755);
  return path;
}

async function waitForDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("capture-web", () => {
  test("parses a bounded capture request", () => {
    const parsed = parseCaptureArgs([
      "--url", "http://localhost:43120/ops",
      "--output", "capture.png",
      "--width", "1280",
      "--height", "720",
      "--timeout-ms", "5000",
    ]);
    expect(parsed).toMatchObject({
      url: "http://localhost:43120/ops",
      width: 1280,
      height: 720,
      timeoutMs: 5000,
    });
  });

  test("returns a screenshot and reaps a browser that stays alive", async () => {
    const directory = temporaryDirectory();
    const output = join(directory, "capture.png");
    const pidFile = join(directory, "browser.pid");
    const supportDirectory = join(directory, "support");

    const result = await captureWeb({
      url: "http://localhost:43120/",
      output,
      width: 800,
      height: 600,
      scale: 1,
      waitMs: 100,
      timeoutMs: 2_000,
      chromePath: fakeChrome(directory, true),
    }, {
      ...process.env,
      OPENSCOUT_CAPTURE_TEST_PID_FILE: pidFile,
      OPENSCOUT_SUPPORT_DIRECTORY: supportDirectory,
    });

    expect(result.bytes).toBe(8);
    expect(readFileSync(output, "utf8")).toBe("fake-png");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(await waitForDead(pid)).toBe(true);
    expect(existsSync(join(supportDirectory, "runtime", "process-leases", `web-capture-${pid}.json`))).toBe(false);
  });

  test("times out and reaps a browser that never captures", async () => {
    const directory = temporaryDirectory();
    const pidFile = join(directory, "browser.pid");

    await expect(captureWeb({
      url: "http://localhost:43120/",
      output: join(directory, "missing.png"),
      width: 800,
      height: 600,
      scale: 1,
      waitMs: 100,
      timeoutMs: 250,
      chromePath: fakeChrome(directory, false),
    }, {
      ...process.env,
      OPENSCOUT_CAPTURE_TEST_PID_FILE: pidFile,
      OPENSCOUT_SUPPORT_DIRECTORY: join(directory, "support"),
    })).rejects.toThrow("timed out after 250ms");

    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(await waitForDead(pid)).toBe(true);
  });
});
