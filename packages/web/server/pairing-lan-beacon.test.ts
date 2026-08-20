import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BEACON_CLAIM_STALE_MS, createBeaconClaimFile } from "./pairing-lan-beacon.ts";

// The claim file is real user state under `~/.openscout`, and claiming refuses
// to run under a test runner without an isolated home. Point it at a throwaway
// one for this process.
const isolatedHome = mkdtempSync(join(tmpdir(), "openscout-lan-beacon-home-"));
process.env.OPENSCOUT_HOME = isolatedHome;

/**
 * A pid that cannot exist: macOS wraps pids at 99999 (`kern.maxproc` is far
 * lower still), so `process.kill(DEAD_PID, 0)` is reliably ESRCH. Used instead
 * of spawning and reaping a real process, which would trip the sync-exec fence
 * and leave a pid that could in principle be recycled mid-test.
 */
const DEAD_PID = 999_999;

const tempHomes: string[] = [];

/** A throwaway stand-in for `~/.openscout`, shared by "instances" in a test. */
function tempClaimPath(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-lan-beacon-"));
  tempHomes.push(home);
  return join(home, "run", "lan-beacon.json");
}

afterEach(() => {
  while (tempHomes.length > 0) {
    rmSync(tempHomes.pop() as string, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});

// The beacon itself shells out to `dns-sd`, so what is worth testing is the
// ownership protocol underneath it: every local instance advertises the SAME
// Bonjour fingerprint (the identity is per-Mac), mDNS renames the duplicate
// instead of rejecting it, and the phone can then resolve into whichever
// process it likes. The claim file is what makes exactly one instance speak.
describe("lan beacon claim file", () => {
  test("no claim on disk means nobody owns the beacon", () => {
    const claim = createBeaconClaimFile({ path: tempClaimPath(), pid: 100 });
    expect(claim.heldByAnotherInstance()).toBe(false);
    expect(claim.read()).toBeNull();
  });

  test("a live claim from another instance makes this one stand down", () => {
    const path = tempClaimPath();
    const now = () => 1_000_000;
    const holder = createBeaconClaimFile({ path, pid: 100, now });
    const other = createBeaconClaimFile({
      path,
      pid: 200,
      now,
      isProcessAlive: (pid) => pid === 100,
    });

    holder.take(43_120);
    expect(other.heldByAnotherInstance()).toBe(true);
    expect(other.read()).toEqual({ pid: 100, webPort: 43_120, updatedAt: 1_000_000 });
  });

  test("an instance never stands down for its own claim", () => {
    const path = tempClaimPath();
    const claim = createBeaconClaimFile({ path, pid: 100, isProcessAlive: () => true });
    claim.take(43_120);
    expect(claim.heldByAnotherInstance()).toBe(false);
  });

  test("a claim whose holder died is taken over", () => {
    const path = tempClaimPath();
    const now = () => 1_000_000;
    createBeaconClaimFile({ path, pid: 100, now }).take(43_120);

    // The holder crashed: fresh claim, but the pid is gone.
    const survivor = createBeaconClaimFile({
      path,
      pid: 200,
      now,
      isProcessAlive: () => false,
    });
    expect(survivor.heldByAnotherInstance()).toBe(false);

    survivor.take(43_121);
    expect(survivor.read()?.pid).toBe(200);
    expect(survivor.read()?.webPort).toBe(43_121);
  });

  test("a stale claim is taken over even when the pid still looks alive", () => {
    const path = tempClaimPath();
    let clock = 1_000_000;
    createBeaconClaimFile({ path, pid: 100, now: () => clock }).take(43_120);

    // Pids get recycled. A dead owner's pid can be reassigned to something
    // unrelated that looks alive forever; staleness is what breaks that tie.
    const survivor = createBeaconClaimFile({
      path,
      pid: 200,
      now: () => clock,
      isProcessAlive: () => true,
    });
    expect(survivor.heldByAnotherInstance()).toBe(true);

    clock += BEACON_CLAIM_STALE_MS;
    expect(survivor.heldByAnotherInstance()).toBe(false);
  });

  test("refreshing the claim keeps the other instance standing down", () => {
    const path = tempClaimPath();
    let clock = 1_000_000;
    const holder = createBeaconClaimFile({ path, pid: 100, now: () => clock });
    const other = createBeaconClaimFile({
      path,
      pid: 200,
      now: () => clock,
      isProcessAlive: () => true,
    });

    holder.take(43_120);
    // A live holder refreshes on every reconcile, so it never ages out.
    for (let i = 0; i < 5; i += 1) {
      clock += BEACON_CLAIM_STALE_MS - 1;
      holder.take(43_120);
      expect(other.heldByAnotherInstance()).toBe(true);
    }
  });

  test("release drops our own claim and frees the beacon", () => {
    const path = tempClaimPath();
    const now = () => 1_000_000;
    const holder = createBeaconClaimFile({ path, pid: 100, now });
    const other = createBeaconClaimFile({
      path,
      pid: 200,
      now,
      isProcessAlive: () => true,
    });

    holder.take(43_120);
    expect(other.heldByAnotherInstance()).toBe(true);

    holder.release();
    expect(holder.read()).toBeNull();
    expect(other.heldByAnotherInstance()).toBe(false);
  });

  test("release does not drop somebody else's claim", () => {
    const path = tempClaimPath();
    const now = () => 1_000_000;
    createBeaconClaimFile({ path, pid: 100, now }).take(43_120);

    // An instance standing down must not evict the instance that is advertising.
    createBeaconClaimFile({ path, pid: 200, now, isProcessAlive: () => true }).release();

    expect(createBeaconClaimFile({ path, pid: 300, now }).read()?.pid).toBe(100);
  });

  test("the claim file and its directory are not world-readable", () => {
    const path = tempClaimPath();
    createBeaconClaimFile({ path, pid: 100 }).take(43_120);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
  });

  test("a corrupt or partial claim is ignored rather than trusted", () => {
    const path = tempClaimPath();
    createBeaconClaimFile({ path, pid: 100 }).take(43_120);

    const reader = createBeaconClaimFile({ path, pid: 200, isProcessAlive: () => true });
    for (const bad of ["{ not json", "null", "[]", '{"pid":"100","updatedAt":1}', '{"pid":100}']) {
      writeFileSync(path, bad);
      expect(reader.read()).toBeNull();
      // Unreadable ownership must fail open: better a duplicate advert than a
      // Mac that never appears in "On your network" at all.
      expect(reader.heldByAnotherInstance()).toBe(false);
    }
  });

  test("the default liveness probe distinguishes a live pid from a dead one", () => {
    const path = tempClaimPath();
    const now = () => Date.now();
    // A third pid, so neither reader is looking at its own claim.
    const reader = () => createBeaconClaimFile({ path, pid: 1, now });

    // No injected probe in this test: it exercises the real `process.kill(p, 0)`.
    createBeaconClaimFile({ path, pid: process.pid, now }).take(43_120);
    expect(reader().heldByAnotherInstance()).toBe(true);

    createBeaconClaimFile({ path, pid: DEAD_PID, now }).take(43_121);
    expect(reader().heldByAnotherInstance()).toBe(false);
  });

  test("an unwritable home leaves the beacon advertising rather than throwing", () => {
    // `~/.openscout` on a read-only volume: claiming is best-effort, and the
    // fallback is the old behaviour (advertise anyway).
    const claim = createBeaconClaimFile({ path: "/proc/openscout/lan-beacon.json", pid: 100 });
    expect(() => claim.take(43_120)).not.toThrow();
    expect(() => claim.release()).not.toThrow();
    expect(claim.heldByAnotherInstance()).toBe(false);
  });

  test("claiming refuses to write into a real home under a test runner", () => {
    // The claim file is not a credential, but it is user state in the same
    // directory as one, and the same guard keeps a future test out of it.
    const saved = process.env.OPENSCOUT_HOME;
    delete process.env.OPENSCOUT_HOME;
    try {
      const claim = createBeaconClaimFile({
        path: join(homedir(), ".openscout", "run", "lan-beacon.json"),
        pid: 100,
      });
      expect(() => claim.take(43_120)).toThrow(/OPENSCOUT_HOME/);
    } finally {
      process.env.OPENSCOUT_HOME = saved;
    }
  });
});
