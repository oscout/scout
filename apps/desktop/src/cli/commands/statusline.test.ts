import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../../..");
const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function createStatuslineHome(): { home: string; supportDirectory: string; statuslineDir: string } {
  const home = mkdtempSync(join(tmpdir(), "openscout-statusline-cli-"));
  const supportDirectory = join(home, "Library", "Application Support", "OpenScout");
  const statuslineDir = join(supportDirectory, "runtime", "statusline");
  testDirectories.add(home);
  mkdirSync(statuslineDir, { recursive: true });
  return { home, supportDirectory, statuslineDir };
}

async function runScoutStatusline(input: {
  home: string;
  supportDirectory: string;
  args?: string[];
}): Promise<string> {
  const payload = JSON.stringify({
    model: { display_name: "Opus" },
    workspace: { current_dir: "/tmp/project" },
    context_window: { used_percentage: 9 },
  });
  const child = Bun.spawn(
    [process.execPath, "./apps/desktop/bin/scout.ts", "statusline", "claude", ...(input.args ?? [])],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: input.home,
        OPENSCOUT_SUPPORT_DIRECTORY: input.supportDirectory,
        OPENSCOUT_STATUSLINE_DELEGATE: "",
        OPENSCOUT_STATUSLINE_RUN_DELEGATE: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(payload);
  child.stdin.end();

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(code).toBe(0);
  expect(stderr).toBe("");
  return stdout.trimEnd();
}

describe("statusline command", () => {
  test("captures Claude statusline input without running preserved delegates by default", async () => {
    const { home, supportDirectory, statuslineDir } = createStatuslineHome();
    writeFileSync(join(statuslineDir, "claude-delegate.json"), JSON.stringify({
      version: 1,
      command: "printf delegated",
      source: "manual",
      installedAt: Date.now(),
    }), "utf8");

    const output = await runScoutStatusline({ home, supportDirectory });

    expect(output).toBe("Scout | Opus | project | ctx 9%");
    expect(existsSync(join(statuslineDir, "claude-latest.json"))).toBe(true);
    expect(readFileSync(join(statuslineDir, "claude-history.jsonl"), "utf8")).toContain("\"context_window\"");
  });

  test("runs a preserved delegate only when explicitly requested", async () => {
    const { home, supportDirectory, statuslineDir } = createStatuslineHome();
    writeFileSync(join(statuslineDir, "claude-delegate.json"), JSON.stringify({
      version: 1,
      command: "printf delegated",
      source: "manual",
      installedAt: Date.now(),
    }), "utf8");

    await expect(runScoutStatusline({ home, supportDirectory, args: ["--delegate"] })).resolves.toBe("delegated");
  });
});
