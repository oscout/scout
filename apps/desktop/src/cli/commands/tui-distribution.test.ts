import { spawnSync as realSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { parseSha256Manifest, releaseArchiveName, releaseManifestName, releaseTargetFor } from "../release-binary.ts";
import {
  SCOUT_APP_TUI_RELATIVE_PATH,
  resolveScoutTuiLaunch,
  runTuiCommand,
  scoutTuiCacheRoot,
  type TuiCommandDependencies,
} from "./tui.ts";

const VERSION = "9.8.7";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeExecutable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** A real tar.gz holding an executable `scout-tui`, as the release workflow packs it. */
function buildArchive(): Buffer {
  const dir = tempDir("openscout-tui-archive-");
  writeExecutable(join(dir, "src", "scout-tui"));
  const out = join(dir, "scout-tui.tar.gz");
  const tar = realSpawnSync("tar", ["-czf", out, "-C", join(dir, "src"), "scout-tui"]);
  if (tar.status !== 0) throw new Error("tar failed");
  return readFileSync(out);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Route = Buffer | string | "hang" | number;

/** Serves release assets by file name. "hang" sends one chunk and then stalls; a number is an HTTP status. */
function fakeRelease(routes: Record<string, Route>, hits: string[] = []): TuiCommandDependencies["fetchImpl"] {
  return async (url) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    hits.push(name);
    const route = routes[name];
    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "number") return new Response("nope", { status: route });
    if (route === "hang") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      }), { status: 200, headers: { "content-length": "1000000" } });
    }
    const body = typeof route === "string" ? Buffer.from(route) : route;
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } });
  };
}

function harness(overrides: Partial<TuiCommandDependencies> = {}) {
  const supportDirectory = tempDir("openscout-tui-support-");
  const calls: Array<{ command: string; args: string[] }> = [];
  const errors: string[] = [];
  const out: string[] = [];
  const context = createScoutCommandContext({
    env: { PATH: "", HOME: tempDir("openscout-tui-home-") },
    cwd: tempDir("openscout-tui-cwd-"),
    stderr: (line) => errors.push(line),
    stdout: (line: string) => out.push(line),
  });
  const deps: TuiCommandDependencies = {
    supportDirectory,
    version: VERSION,
    platform: "linux",
    arch: "x64",
    checkout: null,
    appBundles: [],
    retryDelayMs: 1,
    spawnSync: ((command: string, args?: readonly string[]) => {
      calls.push({ command, args: [...(args ?? [])] });
      return { status: 0, signal: null, error: undefined, pid: 0, output: [], stdout: "", stderr: "" };
    }) as unknown as typeof import("node:child_process").spawnSync,
    exit: () => {
      throw new Error("should not exit on success");
    },
    ...overrides,
  };
  return { context, deps, calls, errors, out, supportDirectory };
}

describe("scout tui resolution order", () => {
  test("SCOUT_TUI_BIN → checkout → PATH → Scout.app → cache → cargo → download", () => {
    const root = tempDir("openscout-tui-order-");
    const env: NodeJS.ProcessEnv = { PATH: join(root, "path-bin") };
    const checkout = join(root, "checkout");
    const app = join(root, "Scout.app");
    const supportDirectory = join(root, "support");
    const input = { env, cwd: root, platform: "darwin" as const, version: VERSION, supportDirectory, checkout, appBundles: [app] };

    writeExecutable(join(checkout, "scripts/cargo.sh"));
    const cached = writeExecutable(join(scoutTuiCacheRoot(supportDirectory), VERSION, "scout-tui"));
    writeFileSync(join(scoutTuiCacheRoot(supportDirectory), VERSION, "receipt.json"), "{}");
    const bundled = writeExecutable(join(app, SCOUT_APP_TUI_RELATIVE_PATH));
    const onPath = writeExecutable(join(root, "path-bin", "scout-tui"));
    const built = writeExecutable(join(checkout, "target/release/scout-tui"));
    const override = writeExecutable(join(root, "custom", "scout-tui"));

    expect(resolveScoutTuiLaunch({ ...input, env: { ...env, SCOUT_TUI_BIN: override } })).toMatchObject({ command: override, source: "env" });
    expect(resolveScoutTuiLaunch(input)).toMatchObject({ command: built, source: "checkout" });
    chmodSync(built, 0o644);
    expect(resolveScoutTuiLaunch(input)).toMatchObject({ command: onPath, source: "path" });
    chmodSync(onPath, 0o644);
    expect(resolveScoutTuiLaunch(input)).toMatchObject({ command: bundled, source: "app" });
    // The bundle is a macOS-only source.
    expect(resolveScoutTuiLaunch({ ...input, platform: "linux" })).toMatchObject({ command: cached, source: "cache" });
    chmodSync(bundled, 0o644);
    expect(resolveScoutTuiLaunch(input)).toMatchObject({ command: cached, source: "cache" });
    // A cached copy of another version doesn't count.
    expect(resolveScoutTuiLaunch({ ...input, version: "1.0.0" })).toMatchObject({ kind: "cargo", cwd: checkout });
    expect(resolveScoutTuiLaunch({ ...input, version: "1.0.0", checkout: null })).toEqual({ kind: "download", version: "1.0.0" });
  });

  test("maps platforms to release targets", () => {
    expect(releaseTargetFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(releaseTargetFor("darwin", "x64")).toBe("darwin-x64");
    expect(releaseTargetFor("linux", "x64")).toBe("linux-x64");
    expect(releaseTargetFor("linux", "arm64")).toBe("linux-arm64");
    expect(releaseTargetFor("win32", "x64")).toBeNull();
    expect(releaseTargetFor("linux", "ia32")).toBeNull();
  });

  test("parses sha256sum manifests", () => {
    const hash = "a".repeat(64);
    expect(parseSha256Manifest(`${hash}  scout-tui-1.0.0-linux-x64.tar.gz\n${"B".repeat(64)} *other.tar.gz\njunk\n`)).toEqual(new Map([
      ["scout-tui-1.0.0-linux-x64.tar.gz", hash],
      ["other.tar.gz", "b".repeat(64)],
    ]));
  });
});

describe("scout tui first-run download", () => {
  const archiveName = releaseArchiveName("scout-tui", VERSION, "linux-x64");
  const manifestName = releaseManifestName("scout-tui", VERSION);

  test("downloads, verifies, caches, then runs; the next run is a cache hit", async () => {
    const archive = buildArchive();
    const hits: string[] = [];
    const { context, deps, calls, errors, supportDirectory } = harness({
      fetchImpl: fakeRelease({ [manifestName]: `${sha256(archive)}  ${archiveName}\n`, [archiveName]: archive }, hits),
    });
    await runTuiCommand(context, ["--take", "mesh"], deps);

    const cachedPath = join(scoutTuiCacheRoot(supportDirectory), VERSION, "scout-tui");
    expect(calls).toEqual([{ command: cachedPath, args: ["--take", "mesh"] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Downloading scout-tui 9\.8\.7 for linux-x64 \(0\.0 MB\)…$/);
    const receipt = JSON.parse(readFileSync(join(scoutTuiCacheRoot(supportDirectory), VERSION, "receipt.json"), "utf8"));
    expect(receipt).toMatchObject({ version: VERSION, target: "linux-x64", sha256: sha256(archive) });
    expect(hits).toEqual([manifestName, archiveName]);

    hits.length = 0;
    calls.length = 0;
    await runTuiCommand(context, [], { ...deps, fetchImpl: async () => { throw new Error("no network on a cache hit"); } });
    expect(calls).toEqual([{ command: cachedPath, args: [] }]);
    expect(hits).toEqual([]);
  });

  test("a checksum mismatch refuses to install or run", async () => {
    const archive = buildArchive();
    const { context, deps, calls, supportDirectory } = harness({
      fetchImpl: fakeRelease({ [manifestName]: `${"0".repeat(64)}  ${archiveName}\n`, [archiveName]: archive }),
    });
    await expect(runTuiCommand(context, [], deps)).rejects.toThrow(/checksum mismatch.*not installing or running it/);
    expect(calls).toEqual([]);
    expect(existsSync(join(scoutTuiCacheRoot(supportDirectory), VERSION))).toBe(false);
  });

  test("a stalled download aborts after retrying", async () => {
    const hits: string[] = [];
    const { context, deps, calls } = harness({
      stallTimeoutMs: 50,
      fetchImpl: fakeRelease({ [manifestName]: `${"0".repeat(64)}  ${archiveName}\n`, [archiveName]: "hang" }, hits),
    });
    await expect(runTuiCommand(context, [], deps)).rejects.toThrow(/Couldn't download scout-tui: stalled: no data/);
    expect(calls).toEqual([]);
    expect(hits.filter((name) => name === archiveName)).toHaveLength(3);
  });

  test("retries transient failures", async () => {
    const archive = buildArchive();
    let failures = 1;
    const release = fakeRelease({ [manifestName]: `${sha256(archive)}  ${archiveName}\n`, [archiveName]: archive });
    const { context, deps, calls } = harness({
      fetchImpl: async (url, init) => {
        if (url.endsWith(".tar.gz") && failures-- > 0) return new Response("busy", { status: 503 });
        return release!(url, init);
      },
    });
    await runTuiCommand(context, [], deps);
    expect(calls).toHaveLength(1);
  });

  test("a release without this version says it isn't published yet", async () => {
    const { context, deps } = harness({ fetchImpl: fakeRelease({}) });
    await expect(runTuiCommand(context, [], deps)).rejects.toThrow(/scout-tui 9\.8\.7 isn't published for linux-x64 yet/);
  });

  test("an unsupported platform gets a readable message and no request", async () => {
    const hits: string[] = [];
    const { context, deps, calls } = harness({ platform: "win32", arch: "x64", fetchImpl: fakeRelease({}, hits) });
    await expect(runTuiCommand(context, [], deps)).rejects.toThrow(/no prebuilt binary for win32-x64[\s\S]*SCOUT_TUI_BIN/);
    expect(hits).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("scout tui install / status / uninstall", () => {
  test("install downloads on purpose, status reports it, uninstall removes it", async () => {
    const archive = buildArchive();
    const archiveName = releaseArchiveName("scout-tui", VERSION, "linux-x64");
    const { context, deps, calls, out, supportDirectory } = harness({
      fetchImpl: fakeRelease({ [releaseManifestName("scout-tui", VERSION)]: `${sha256(archive)}  ${archiveName}\n`, [archiveName]: archive }),
    });
    await runTuiCommand(context, ["install"], deps);
    expect(calls).toEqual([]);
    expect(out.join("\n")).toContain("Installed scout-tui 9.8.7");

    await runTuiCommand(context, ["install"], deps);
    expect(out.join("\n")).toContain("already installed");

    await runTuiCommand(context, ["status"], deps);
    expect(out.join("\n")).toContain(`${join(scoutTuiCacheRoot(supportDirectory), VERSION, "scout-tui")} (downloaded)`);

    await runTuiCommand(context, ["uninstall"], deps);
    expect(out.join("\n")).toContain("Removed downloaded scout-tui copies.");
    expect(existsSync(scoutTuiCacheRoot(supportDirectory))).toBe(false);
  });
});
