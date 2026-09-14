import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runRemoteCandidateInstall, REMOTE_STAGE_SCRIPT } from "./machine-update-remote.ts";
import { checkUpdateActivity } from "../../../../packages/cli/src/update-helper.ts";

function candidate() {
  const root = mkdtempSync(join(tmpdir(), "scout-update-test-"));
  const dmg = join(root, "an ' odd $ DMG.dmg");
  const receipt = join(root, "receipt.json");
  const helper = join(root, "helper.mjs");
  const bytes = Buffer.from("fixture DMG bytes");
  writeFileSync(dmg, bytes); writeFileSync(helper, "// fixture helper");
  writeFileSync(receipt, JSON.stringify({ schema: "openscout-native-candidate-v1", version: "0.2.101", source: { repository: "arach/openscout", commit: "a".repeat(40) }, verification: { release: true, team: "2U83JFPW66" }, artifact: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }));
  return { root, candidate: receipt, dmg, helperPath: helper };
}

describe("remote native update gates", () => {
  test("remote staging verifies bytes, invokes the helper and removes only its own successful stage", () => {
    const root = mkdtempSync(join(tmpdir(), "scout-stage-test-"));
    try {
      mkdirSync(join(root, ".bun/bin"), { recursive: true });
      writeFileSync(join(root, ".bun/bin/bun"), `#!/usr/bin/python3\nimport sys,json,pathlib\nassert pathlib.Path(sys.argv[1]).read_text()=='helper fixture'\nassert json.loads(sys.argv[2])==['air']\nassert pathlib.Path(sys.argv[4]).read_bytes()==b'DMG fixture'\nprint(json.dumps({'schema':'openscout.remote-native-update.v1','nodeId':'air','wholeSuiteVerified':False}))\n`, { mode: 0o755 });
      const files = Object.fromEntries(Object.entries({ 'update-helper.mjs': 'helper fixture', 'receipt.json': '{}', 'OpenScout.dmg': 'DMG fixture' }).map(([name, value]) => [name, { data: Buffer.from(value).toString('base64'), sha256: createHash('sha256').update(value).digest('hex') }]));
      const run = spawnSync('python3', ['-c', REMOTE_STAGE_SCRIPT], { env: { ...process.env, HOME: root }, input: JSON.stringify({ files, expectedNodeIds: ['air'] }), encoding: 'utf8', timeout: 10000 });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).nodeId).toBe('air');
      expect(readdirSync(join(root, '.openscout/updates'))).toEqual([]);
      files['OpenScout.dmg']!.sha256 = '0'.repeat(64);
      const bad = spawnSync('python3', ['-c', REMOTE_STAGE_SCRIPT], { env: { ...process.env, HOME: root }, input: JSON.stringify({ files, expectedNodeIds: ['air'] }), encoding: 'utf8', timeout: 10000 });
      expect(bad.status).toBe(1);
      expect(JSON.parse(bad.stdout).error).toContain('checksum mismatch');
      expect(readdirSync(join(root, '.openscout/updates'))).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("fails closed on unknown, mismatched and busy Scout nodes", () => {
    const health = { nodeId: "air", ok: true, reachable: true };
    expect(() => checkUpdateActivity(null, ["air"], health)).toThrow("activity");
    expect(() => checkUpdateActivity({ flights: {} }, ["air"], { ...health, nodeId: "mini" })).toThrow("identity");
    expect(() => checkUpdateActivity({ flights: {} }, ["air"], { ...health, reachable: false })).toThrow("identity");
    expect(() => checkUpdateActivity({}, ["air"], health)).toThrow("activity");
    expect(() => checkUpdateActivity({ flights: { a: { id: "a", state: "running" } } }, ["air"], health)).toThrow("active flights");
    expect(() => checkUpdateActivity({ flights: { a: { id: "a", state: "unknown" } } }, ["air"], health)).toThrow("active flights");
    // Actual registry snapshots have no nodeId; health supplies it separately.
    expect(checkUpdateActivity({ flights: { a: { state: "completed" } } }, ["air"], health)).toBe("air");
  });

  test("transfers exact verified files as stdin, with no local path in remote shell command", async () => {
    const files = candidate();
    try {
      let called = false;
      const result = await runRemoteCandidateInstall({ ...files, target: { destination: "arach@air", port: 2222, raw: "ssh://arach@air:2222" }, expectedNodeIds: ["air"], exec: async (input) => {
        called = true;
        expect(input.argv.slice(0, 9)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-p", "2222"]);
        expect(input.argv).toContain("--"); expect(input.argv.join(" ")).not.toContain(files.dmg);
        const payload = JSON.parse(input.stdin!);
        expect(Buffer.from(payload.files['OpenScout.dmg'].data, 'base64').toString()).toBe("fixture DMG bytes");
        expect(payload.expectedNodeIds).toEqual(["air"]);
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ schema: "openscout.remote-native-update.v1", nodeId: "air", wholeSuiteVerified: false, native: [{ action: "install", installed: "0.2.101", status: "updated" }] }) };
      } });
      expect(called).toBe(true); expect((result as any).wholeSuiteVerified).toBe(false);
    } finally { rmSync(files.root, { recursive: true, force: true }); }
  });

  test("never transfers corrupted candidates or unbound machine identities", async () => {
    const files = candidate(); let calls = 0;
    const exec = async () => { calls++; return { exitCode: 0, stderr: "", stdout: "{}" }; };
    try {
      const base = { ...files, target: { destination: "air", raw: "ssh://air" }, exec };
      await expect(runRemoteCandidateInstall({ ...base, expectedNodeIds: [] })).rejects.toThrow("identity");
      writeFileSync(files.dmg, "corrupted");
      await expect(runRemoteCandidateInstall({ ...base, expectedNodeIds: ["air"] })).rejects.toThrow();
      expect(calls).toBe(0);
    } finally { rmSync(files.root, { recursive: true, force: true }); }
  });

  test("does not accept a missing, failed or wrong-node completion receipt", async () => {
    const files = candidate();
    try {
      for (const response of [
        ...[true, undefined].map((wholeSuiteVerified) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ schema: "openscout.remote-native-update.v1", nodeId: "air", wholeSuiteVerified }) })),
        { exitCode: 0, stderr: "", stdout: JSON.stringify({ schema: "openscout.remote-native-update.v1", nodeId: "air", wholeSuiteVerified: false, native: [{ action: "install", installed: "0.2.98", status: "updated" }] }) },
        { exitCode: 1, stdout: "partial install; re-probe", stderr: "" }, { exitCode: 0, stdout: "not json", stderr: "" }, { exitCode: 0, stdout: JSON.stringify({ schema: "openscout.remote-native-update.v1", nodeId: "wrong" }), stderr: "" } ]) {
        await expect(runRemoteCandidateInstall({ ...files, target: { destination: "air", raw: "ssh://air" }, expectedNodeIds: ["air"], exec: async () => response })).rejects.toThrow();
      }
    } finally { rmSync(files.root, { recursive: true, force: true }); }
  });
});
