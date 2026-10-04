import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInstalledWebFullClient } from "@openscout/runtime/web-full-client";

import { createScoutCommandContext } from "../context.ts";
import {
  distKeyPath,
  fileDistKeyStore,
  keychainDistKeyStore,
  runWebCommand,
  type DistKeyStore,
  type ScoutWebCommandDeps,
} from "./web.ts";

const KEY = "osdist_0123456789abcdef";
const VERSION = "9.8.7";

let root: string;
let support: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scout-web-cmd-"));
  support = join(root, "support");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function packClient(version: string, profileVersion = version): Uint8Array<ArrayBuffer> {
  const client = join(root, `client-${version}-${profileVersion}`);
  mkdirSync(join(client, "assets"), { recursive: true });
  writeFileSync(join(client, "index.html"), "<title>Scout</title>");
  writeFileSync(join(client, "assets", "app.js"), "Mission Control");
  writeFileSync(join(client, "scout-web-profile.json"), JSON.stringify({ profile: "full", version: profileVersion }));
  const tarball = join(root, `${version}-${profileVersion}.tar.gz`);
  expect(spawnSync("tar", ["-czf", tarball, "-C", client, "."]).status).toBe(0);
  return new Uint8Array(readFileSync(tarball));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function harness(options: {
  tarball?: Uint8Array<ArrayBuffer>;
  digest?: string;
  env?: NodeJS.ProcessEnv;
  status?: number;
  restarted?: string[];
  keyStores?: DistKeyStore[];
  stdin?: string;
} = {}) {
  const lines: string[] = [];
  const requests: Array<{ url: string; auth: string | null }> = [];
  const context = createScoutCommandContext({
    cwd: root,
    env: options.env ?? {},
    stdout: (line) => lines.push(line),
    stderr: () => undefined,
    isTty: false,
  });
  const deps: ScoutWebCommandDeps = {
    supportDirectory: support,
    version: VERSION,
    // Never the real Keychain from a test.
    keyStores: options.keyStores ?? [fileDistKeyStore(support)],
    readStdin: async () => options.stdin ?? "",
    restartWeb: async () => {
      options.restarted?.push("restart");
      return "http://127.0.0.1:43120";
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (options.status) return Response.json({ error: "nope" }, { status: options.status });
      if (url.endsWith("/v1/dist/whoami")) return Response.json({ login: "arach", label: "mini" });
      if (!options.tarball) return Response.json({ error: "not_published", version: VERSION }, { status: 404 });
      return new Response(options.tarball, {
        headers: { "x-openscout-sha256": options.digest ?? sha256(options.tarball) },
      });
    },
  };
  return { context, deps, lines, requests };
}

describe("scout web", () => {
  test("login checks the key with the host and saves it privately", async () => {
    const { context, deps, lines, requests } = harness();
    await runWebCommand(context, ["login", "--key", KEY], deps);
    expect(requests[0]).toEqual({ url: "https://console.openscout.app/v1/dist/whoami", auth: `Bearer ${KEY}` });
    expect(readFileSync(distKeyPath(support), "utf8").trim()).toBe(KEY);
    expect(statSync(distKeyPath(support)).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toContain('Signed in as arach (key "mini")');

    await expect(runWebCommand(context, ["login", "--key", "osmcp_wrong"], deps)).rejects.toThrow("download key");
  });

  test("a rejected key is not saved", async () => {
    const { context, deps } = harness({ status: 401 });
    await expect(runWebCommand(context, ["login", "--key", KEY], deps)).rejects.toThrow("not accepted");
    expect(existsSync(distKeyPath(support))).toBe(false);
  });

  test("install downloads, verifies and installs the full client for this version, then restarts web", async () => {
    const restarted: string[] = [];
    const tarball = packClient(VERSION);
    const { context, deps, lines, requests } = harness({ tarball, env: { SCOUT_DIST_KEY: KEY }, restarted });
    await runWebCommand(context, ["install"], deps);

    expect(requests[0]!.url).toBe(`https://console.openscout.app/v1/dist/web-full/${VERSION}`);
    const installed = resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support });
    expect(installed).toBe(join(support, "web", "full", VERSION));
    expect(readFileSync(join(installed!, "index.html"), "utf8")).toContain("Scout");
    expect(restarted).toEqual(["restart"]);
    expect(lines.join("\n")).toContain(`Installed the full web app ${VERSION}`);

    // Nothing left behind from the install.
    expect(spawnSync("ls", ["-A", join(support, "web", "full")]).stdout.toString().trim()).toBe(VERSION);

    // Other versions are never served by this server, even if present.
    expect(resolveInstalledWebFullClient("9.8.6", { env: {}, supportDirectory: support })).toBeNull();
    expect(resolveInstalledWebFullClient(VERSION, { env: { OPENSCOUT_WEB_CLIENT_PROFILE: "basic" }, supportDirectory: support })).toBeNull();

    const again = harness({ tarball, env: { SCOUT_DIST_KEY: KEY } });
    await runWebCommand(again.context, ["install"], again.deps);
    expect(again.requests).toHaveLength(0);
    expect(again.lines.join("\n")).toContain("already installed");
  });

  test("a checksum mismatch or a client for another version is never installed", async () => {
    const tarball = packClient(VERSION);
    const tampered = harness({ tarball, digest: "0".repeat(64), env: { SCOUT_DIST_KEY: KEY } });
    await expect(runWebCommand(tampered.context, ["install"], tampered.deps)).rejects.toThrow("Checksum mismatch");

    const wrong = harness({ tarball: packClient(VERSION, "1.0.0"), env: { SCOUT_DIST_KEY: KEY } });
    await expect(runWebCommand(wrong.context, ["install"], wrong.deps)).rejects.toThrow("isn't the full web app");

    expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).toBeNull();
    expect(spawnSync("ls", ["-A", join(support, "web", "full")]).stdout.toString().trim()).toBe("");
  });

  test("install explains a missing key and an unpublished version", async () => {
    const none = harness();
    await expect(runWebCommand(none.context, ["install"], none.deps)).rejects.toThrow("No download key");

    const unpublished = harness({ env: { SCOUT_DIST_KEY: KEY } });
    await expect(runWebCommand(unpublished.context, ["install"], unpublished.deps)).rejects.toThrow(`isn't published for Scout ${VERSION}`);
  });

  test("status reports what is served; uninstall goes back to basic", async () => {
    const tarball = packClient(VERSION);
    const run = harness({ tarball, env: { SCOUT_DIST_KEY: KEY } });
    await runWebCommand(run.context, ["status"], run.deps);
    expect(run.lines.join("\n")).toContain("serves     the basic web app");

    await runWebCommand(run.context, ["install", "--no-restart"], run.deps);
    run.lines.length = 0;
    await runWebCommand(run.context, ["status"], run.deps);
    expect(run.lines.join("\n")).toContain("serves     the full web app");

    await runWebCommand(run.context, ["uninstall"], run.deps);
    expect(resolveInstalledWebFullClient(VERSION, { env: {}, supportDirectory: support })).toBeNull();
  });

  test("login without --key reads a piped key", async () => {
    const { context, deps } = harness({ stdin: `${KEY}\n` });
    await runWebCommand(context, ["login"], deps);
    expect(readFileSync(distKeyPath(support), "utf8").trim()).toBe(KEY);
  });

  test("an encrypted store wins, and the plain file is cleared once it takes the key", async () => {
    const vault = new Map<string, string>();
    const encrypted: DistKeyStore = {
      where: "test vault",
      encrypted: true,
      read: async () => vault.get("key") ?? null,
      write: async (key) => (vault.set("key", key), true),
      remove: async () => vault.delete("key"),
    };
    const file = fileDistKeyStore(support);
    await file.write("osdist_stale");

    const run = harness({ keyStores: [encrypted, file] });
    await runWebCommand(run.context, ["login", "--key", KEY], run.deps);
    expect(vault.get("key")).toBe(KEY);
    expect(existsSync(distKeyPath(support))).toBe(false);
    expect(run.lines.join("\n")).toContain("Key saved in test vault");

    run.lines.length = 0;
    await runWebCommand(run.context, ["status"], run.deps);
    expect(run.lines.join("\n")).toContain("key        test vault");

    await runWebCommand(run.context, ["logout"], run.deps);
    expect(vault.size).toBe(0);
  });

  test("the Keychain store passes the key on stdin, never in argv", async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const store = keychainDistKeyStore(async (command, args, input) => {
      calls.push({ command, args, input });
      return { status: 0, stdout: "" };
    });
    expect(await store.write(KEY)).toBe(true);
    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.args.join(" ")).not.toContain(KEY);
    expect(calls[0]!.input).toContain(KEY);
    expect(await store.write('osdist_"; rm -rf ~')).toBe(false);
  });

  test("logout clears every store, and a store that fails to save falls through to the next", async () => {
    const removed: string[] = [];
    const failing: DistKeyStore = {
      where: "stuck vault",
      encrypted: true,
      read: async () => null,
      write: async () => false,
      remove: async () => (removed.push("stuck vault"), false),
    };
    const run = harness({ keyStores: [failing, fileDistKeyStore(support)] });
    await runWebCommand(run.context, ["login", "--key", KEY], run.deps);
    expect(run.lines.join("\n")).toContain(`Key saved in ${distKeyPath(support)}`);
    expect(removed).toEqual(["stuck vault"]);

    run.lines.length = 0;
    await runWebCommand(run.context, ["logout"], run.deps);
    expect(removed).toEqual(["stuck vault", "stuck vault"]);
    expect(existsSync(distKeyPath(support))).toBe(false);
    expect(run.lines.join("\n")).toContain("Download key removed.");
  });
});
