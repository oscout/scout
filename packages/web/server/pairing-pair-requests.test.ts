import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createPendingPairRequestStore,
  latestPairRequestGeneration,
  type PairRequest,
  pairRequestGenerationPath,
  pairRequestStatePath,
} from "./pairing-pair-requests.ts";

// Every store below writes real files. The store refuses to write shared
// pairing state under a test runner unless OPENSCOUT_HOME points somewhere
// disposable, so point it at a throwaway home for this process: an unisolated
// test once left a live pending pair token in the operator's real
// ~/.openscout/run/pair-requests.json.
const isolatedHome = mkdtempSync(join(tmpdir(), "openscout-pair-requests-home-"));
process.env.OPENSCOUT_HOME = isolatedHome;

/** Rows the store writes are bearer credentials; nothing here may run as root. */
const runsAsRoot = process.getuid?.() === 0;

/** Has anything been published under this state path at all? */
function published(statePath: string): boolean {
  return latestPairRequestGeneration(statePath) !== null;
}

/**
 * The file the newest generation actually lives in.
 *
 * State is published as a generation at a time — a temp file hard-linked to the
 * next generation's name, which is what makes publishing a compare-and-swap —
 * so "the state file" is whichever generation is newest, not a fixed path.
 */
function currentStateFile(statePath: string): string {
  const generation = latestPairRequestGeneration(statePath);
  if (generation === null) throw new Error(`nothing published under ${statePath}`);
  return pairRequestGenerationPath(statePath, generation);
}

/** The tokens the newest published generation carries terminal markers for. */
function markerTokens(statePath: string): string[] {
  const parsed = JSON.parse(readFileSync(currentStateFile(statePath), "utf8")) as {
    fulfilled?: { token?: unknown }[];
  };
  return (parsed.fulfilled ?? [])
    .map((marker) => marker?.token)
    .filter((token): token is string => typeof token === "string");
}

/** Every state file the store is currently keeping, newest first. */
function stateFiles(statePath: string): string[] {
  const directory = dirname(statePath);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((entry) => entry.endsWith(".json"));
}

const tempHomes: string[] = [];

/** A throwaway stand-in for `~/.openscout`, shared by "instances" in a test. */
function tempConfigHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-pair-requests-"));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop() as string;
    // A degraded-persist test leaves a directory it cannot write to behind.
    try {
      chmodSync(join(home, "run"), 0o700);
    } catch {
      // No run directory, or it is already writable.
    }
    rmSync(home, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});

function fixedClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe("pending pair request store", () => {
  test("create registers a pending request with a token", () => {
    const store = createPendingPairRequestStore();
    const req = store.create({ requesterIp: "192.168.1.5", requesterLabel: "iPhone" });
    expect(req.status).toBe("pending");
    expect(req.token).toBeTruthy();
    expect(req.requesterLabel).toBe("iPhone");
    expect(store.get(req.token)?.token).toBe(req.token);
    store.dispose();
  });

  test("repeated requests from the same IP collapse onto one prompt", () => {
    const store = createPendingPairRequestStore();
    const a = store.create({ requesterIp: "192.168.1.5" });
    const b = store.create({ requesterIp: "192.168.1.5" });
    expect(b.token).toBe(a.token);
    expect(store.list()).toHaveLength(1);
    // A different IP gets its own request.
    const c = store.create({ requesterIp: "192.168.1.9" });
    expect(c.token).not.toBe(a.token);
    expect(store.list()).toHaveLength(2);
    store.dispose();
  });

  test("requests with no IP are not collapsed together", () => {
    const store = createPendingPairRequestStore();
    const a = store.create({ requesterIp: null });
    const b = store.create({ requesterIp: null });
    expect(b.token).not.toBe(a.token);
    store.dispose();
  });

  test("approve flips status; deny flips status", () => {
    const store = createPendingPairRequestStore();
    const a = store.create({ requesterIp: "10.0.0.2" });
    expect(store.decide(a.token, "approve")?.status).toBe("approved");
    const b = store.create({ requesterIp: "10.0.0.3" });
    expect(store.decide(b.token, "deny")?.status).toBe("denied");
    expect(store.decide("nope", "approve")).toBeNull();
    store.dispose();
  });

  test("requests expire after the TTL", () => {
    const clock = fixedClock();
    const store = createPendingPairRequestStore({ ttlMs: 1000, now: clock.now });
    const a = store.create({ requesterIp: "10.0.0.4" });
    clock.advance(1001);
    expect(store.get(a.token)).toBeNull();
    expect(store.list()).toHaveLength(0);
    store.dispose();
  });

  test("touch extends an actively-polled request", () => {
    const clock = fixedClock();
    const store = createPendingPairRequestStore({ ttlMs: 1000, now: clock.now });
    const a = store.create({ requesterIp: "10.0.0.5" });
    clock.advance(800);
    store.touch(a.token);
    clock.advance(800); // 1600 since create, but only 800 since touch
    expect(store.get(a.token)?.token).toBe(a.token);
    store.dispose();
  });

  test("touch does not resurrect a denied request", () => {
    const clock = fixedClock();
    const store = createPendingPairRequestStore({ ttlMs: 1000, now: clock.now });
    const a = store.create({ requesterIp: "10.0.0.6" });
    store.decide(a.token, "deny");
    clock.advance(800);
    store.touch(a.token); // no-op for denied
    clock.advance(300); // 1100 since create
    expect(store.get(a.token)).toBeNull();
    store.dispose();
  });

  test("fulfill drops a request", () => {
    const store = createPendingPairRequestStore();
    const a = store.create({ requesterIp: "10.0.0.7" });
    store.fulfill(a.token);
    expect(store.get(a.token)).toBeNull();
    store.dispose();
  });
});

// The bug these cover: two OpenScout instances on one Mac share the pairing
// identity, so both advertise the same Bonjour fingerprint. The phone lands on
// whichever process mDNS hands it, the human approves on the other one, and
// with a per-process store the approval can never reach the request — the phone
// waits forever on a request that was genuinely approved somewhere it cannot
// see. Each test below drives TWO stores over ONE state file, which is exactly
// two instances over one `~/.openscout`.
describe("pending pair request store shared across instances", () => {
  test("a request created on one instance is approved on another and seen by the first", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const phoneFacing = createPendingPairRequestStore({ statePath });
    const humanFacing = createPendingPairRequestStore({ statePath });

    // The phone taps instance A.
    const req = phoneFacing.create({ requesterIp: "192.168.1.40", requesterLabel: "iPhone" });
    expect(req.status).toBe("pending");

    // The human is looking at instance B, which must see the request at all.
    const visible = humanFacing.list();
    expect(visible).toHaveLength(1);
    expect(visible[0]?.token).toBe(req.token);
    expect(visible[0]?.requesterLabel).toBe("iPhone");

    // ...and approving there must reach the instance the phone is polling.
    expect(humanFacing.decide(req.token, "approve")?.status).toBe("approved");
    expect(phoneFacing.get(req.token)?.status).toBe("approved");

    phoneFacing.dispose();
    humanFacing.dispose();
  });

  test("a denial on one instance reaches the other", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const a = createPendingPairRequestStore({ statePath });
    const b = createPendingPairRequestStore({ statePath });

    const req = a.create({ requesterIp: "192.168.1.41" });
    expect(b.decide(req.token, "deny")?.status).toBe("denied");
    expect(a.get(req.token)?.status).toBe("denied");

    a.dispose();
    b.dispose();
  });

  test("fulfilling on one instance drops the request everywhere", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const a = createPendingPairRequestStore({ statePath });
    const b = createPendingPairRequestStore({ statePath });

    const req = a.create({ requesterIp: "192.168.1.42" });
    b.decide(req.token, "approve");
    // The payload gets served by whichever instance the phone came back to.
    b.fulfill(req.token);
    expect(a.get(req.token)).toBeNull();
    expect(a.list()).toHaveLength(0);

    a.dispose();
    b.dispose();
  });

  test("concurrent instances do not clobber each other's requests", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const a = createPendingPairRequestStore({ statePath });
    const b = createPendingPairRequestStore({ statePath });

    // Each instance writes the whole file, so a write that skipped the reload
    // would silently drop the other instance's row.
    const first = a.create({ requesterIp: "192.168.1.43" });
    const second = b.create({ requesterIp: "192.168.1.44" });

    const tokensFromA = a.list().map((r) => r.token).sort();
    const tokensFromB = b.list().map((r) => r.token).sort();
    const expected = [first.token, second.token].sort();
    expect(tokensFromA).toEqual(expected);
    expect(tokensFromB).toEqual(expected);

    a.dispose();
    b.dispose();
  });

  test("the same device tapping two instances collapses onto one prompt", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const a = createPendingPairRequestStore({ statePath });
    const b = createPendingPairRequestStore({ statePath });

    // mDNS can hand the phone a different instance on a retry; the human should
    // still be prompted once, not once per server.
    const first = a.create({ requesterIp: "192.168.1.45" });
    const retry = b.create({ requesterIp: "192.168.1.45" });
    expect(retry.token).toBe(first.token);
    expect(a.list()).toHaveLength(1);

    a.dispose();
    b.dispose();
  });

  test("TTL expiry propagates across instances", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const clock = fixedClock();
    const a = createPendingPairRequestStore({ statePath, ttlMs: 1000, now: clock.now });
    const b = createPendingPairRequestStore({ statePath, ttlMs: 1000, now: clock.now });

    const req = a.create({ requesterIp: "192.168.1.46" });
    expect(b.get(req.token)?.token).toBe(req.token);

    clock.advance(1001);
    // B stops offering it...
    expect(b.list()).toHaveLength(0);
    // ...and A must not resurrect it from its own memory.
    expect(a.get(req.token)).toBeNull();
    expect(a.list()).toHaveLength(0);

    a.dispose();
    b.dispose();
  });

  test("a touch on one instance keeps the request alive for the other", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const clock = fixedClock();
    const a = createPendingPairRequestStore({ statePath, ttlMs: 1000, now: clock.now });
    const b = createPendingPairRequestStore({ statePath, ttlMs: 1000, now: clock.now });

    const req = a.create({ requesterIp: "192.168.1.47" });
    clock.advance(800);
    // The phone is polling instance A while the human dithers on B.
    a.touch(req.token);
    clock.advance(800);
    expect(b.get(req.token)?.token).toBe(req.token);

    a.dispose();
    b.dispose();
  });

  test("state survives an instance restarting", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const first = createPendingPairRequestStore({ statePath });
    const req = first.create({ requesterIp: "192.168.1.48", requesterLabel: "iPad" });
    first.dispose();

    // A fresh process reads the same home and picks the request back up.
    const restarted = createPendingPairRequestStore({ statePath });
    expect(restarted.get(req.token)?.requesterLabel).toBe("iPad");
    restarted.dispose();
  });

  test("the state file and its directory are not world-readable", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const store = createPendingPairRequestStore({ statePath });
    store.create({ requesterIp: "192.168.1.49" });

    // A token is a bearer credential for completing the pair.
    expect(statSync(currentStateFile(statePath)).mode & 0o077).toBe(0);
    expect(statSync(dirname(statePath)).mode & 0o077).toBe(0);

    store.dispose();
  });

  test("a corrupt state file does not break pairing", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const seed = createPendingPairRequestStore({ statePath });
    seed.create({ requesterIp: "192.168.1.50" });
    seed.dispose();

    writeFileSync(currentStateFile(statePath), "{ this is not json");

    const store = createPendingPairRequestStore({ statePath });
    const req = store.create({ requesterIp: "192.168.1.51" });
    expect(req.status).toBe("pending");
    expect(store.get(req.token)?.token).toBe(req.token);
    store.dispose();
  });

  test("rows that are not well-formed requests are dropped on load", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const seed = createPendingPairRequestStore({ statePath });
    const good = seed.create({ requesterIp: "192.168.1.52" });
    seed.dispose();

    // Re-read what the store wrote so the good row stays byte-accurate.
    const current = currentStateFile(statePath);
    const rows = JSON.parse(readFileSync(current, "utf8")) as { requests: unknown[] };
    const template = rows.requests[0] as Record<string, unknown>;
    rows.requests.push({ token: 42, status: "pending" });
    rows.requests.push({ ...template, token: "bad-ip", requesterIp: 9000 });
    rows.requests.push({ ...template, token: "bad-status", status: "maybe" });
    writeFileSync(current, JSON.stringify(rows));

    const store = createPendingPairRequestStore({ statePath });
    const tokens = store.list().map((r) => r.token);
    expect(tokens).toEqual([good.token]);
    store.dispose();
  });

  test("omitting statePath keeps the store purely in-memory", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const shared = createPendingPairRequestStore({ statePath });
    const isolated = createPendingPairRequestStore();

    isolated.create({ requesterIp: "192.168.1.53" });
    expect(shared.list()).toHaveLength(0);

    shared.dispose();
    isolated.dispose();
  });
});

// Two stores in one process cannot show what this store is for. JavaScript is
// single-threaded, so an in-process "concurrent" test is a sequential one: a
// read-modify-write there can never interleave with another. The production
// case is two OS processes racing over one shared state — the phone polling
// instance A while the human decides on instance B — so these spawn two real
// processes and count what the race costs. Against the unserialized store they
// lose roughly half the decisions; the bar here is zero.
describe("pending pair request store under multi-process contention", () => {
  const RACE_ROUNDS = 2_000;
  const RACE_TIMEOUT_MS = 120_000;

  interface RaceResult {
    decider: { lost: number; resurrected: number; delivered: number; rounds: number };
    poller: { touched: number; extended: number; lost: number };
  }

  async function race(
    scenario: "approve" | "deny" | "expire" | "sweep" | "fulfil",
  ): Promise<RaceResult> {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const signals = join(home, "signals");
    mkdirSync(signals, { recursive: true });
    const worker = join(import.meta.dir, "pairing-pair-requests.concurrency-worker.ts");

    const spawnRole = (role: "decider" | "poller") =>
      Bun.spawn({
        cmd: [
          process.execPath,
          worker,
          `--role=${role}`,
          `--scenario=${scenario}`,
          `--rounds=${RACE_ROUNDS}`,
          `--state=${statePath}`,
          `--signals=${signals}`,
        ],
        // The workers write real files, so they get the same isolated home the
        // guard demands of this process.
        env: { ...process.env, OPENSCOUT_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });

    const decider = spawnRole("decider");
    const poller = spawnRole("poller");
    const [deciderOut, deciderErr, pollerOut, pollerErr] = await Promise.all([
      new Response(decider.stdout).text(),
      new Response(decider.stderr).text(),
      new Response(poller.stdout).text(),
      new Response(poller.stderr).text(),
    ]);
    const [deciderCode, pollerCode] = await Promise.all([decider.exited, poller.exited]);
    if (deciderCode !== 0 || pollerCode !== 0) {
      throw new Error(
        `race workers failed (decider ${deciderCode}, poller ${pollerCode}):\n${deciderErr}\n${pollerErr}`,
      );
    }
    return {
      decider: JSON.parse(deciderOut) as RaceResult["decider"],
      poller: JSON.parse(pollerOut) as RaceResult["poller"],
    };
  }

  test(
    "an approval is never reverted by a device polling the other instance",
    async () => {
      const result = await race("approve");
      expect(result.decider.rounds).toBe(RACE_ROUNDS);
      expect(result.poller.touched).toBe(RACE_ROUNDS);
      expect(result.decider.lost).toBe(0);
    },
    RACE_TIMEOUT_MS,
  );

  test(
    "a denial is never reverted by a device polling the other instance",
    async () => {
      const result = await race("deny");
      expect(result.decider.rounds).toBe(RACE_ROUNDS);
      expect(result.poller.touched).toBe(RACE_ROUNDS);
      expect(result.decider.lost).toBe(0);
    },
    RACE_TIMEOUT_MS,
  );

  test(
    "a poll never resurrects a request that expired on the other instance",
    async () => {
      const result = await race("expire");
      expect(result.decider.rounds).toBe(RACE_ROUNDS);
      expect(result.poller.touched).toBe(RACE_ROUNDS);
      expect(result.decider.resurrected).toBe(0);
    },
    RACE_TIMEOUT_MS,
  );

  // The two removals a row can suffer, racing each other through the swap: one
  // instance collecting an expiry it can see while the other extends past it,
  // and a fulfilled token that must stay buried through all of it.
  test(
    "an expiry sweep never collects an extension the polling instance already made",
    async () => {
      const result = await race("sweep");
      expect(result.decider.rounds).toBe(RACE_ROUNDS);
      expect(result.poller.touched).toBe(RACE_ROUNDS);
      // Without this the run could pass by never reaching the state it is about.
      expect(result.poller.extended).toBeGreaterThan(0);
      expect(result.poller.lost).toBe(0);
      expect(result.decider.resurrected).toBe(0);
    },
    RACE_TIMEOUT_MS,
  );

  // The delivery itself, raced. Pair mode comes up on the instance with the
  // short window, and it hands the payload over past that window — so the row
  // it can see is expired and the only thing keeping the token open is the
  // extension the other instance published a moment earlier. Handing the
  // payload over and burying the token are one decision, and this is the widest
  // the gap between them ever gets.
  test(
    "a delivered payload never leaves the token open on the instance that extended it",
    async () => {
      const result = await race("fulfil");
      expect(result.decider.rounds).toBe(RACE_ROUNDS);
      expect(result.poller.touched).toBe(RACE_ROUNDS);
      // Otherwise the run could pass by never reaching the state it is about.
      expect(result.poller.extended).toBeGreaterThan(0);
      expect(result.decider.delivered).toBeGreaterThan(0);
      expect(result.poller.lost).toBe(0);
      expect(result.decider.resurrected).toBe(0);
    },
    RACE_TIMEOUT_MS,
  );
});

// Publishing is a compare-and-swap: a temp file hard-linked to the name of the
// next generation, which the kernel refuses if anyone else got there first.
// These cover the layer itself — that it advances, collects after itself, and
// picks up state the single-file store left behind.
describe("pending pair request store generations", () => {
  test("every mutation publishes a new generation", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const store = createPendingPairRequestStore({ statePath });

    const req = store.create({ requesterIp: "192.168.1.54" });
    const created = latestPairRequestGeneration(statePath);
    store.decide(req.token, "approve");
    const decided = latestPairRequestGeneration(statePath);

    expect(created).toBe(1);
    expect(decided).toBe(2);
    // A read publishes nothing at all.
    store.get(req.token);
    store.list();
    expect(latestPairRequestGeneration(statePath)).toBe(2);

    store.dispose();
  });

  test("superseded generations are collected and no temp file is left behind", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const store = createPendingPairRequestStore({ statePath });
    const req = store.create({ requesterIp: "192.168.1.55" });
    for (let i = 0; i < 20; i += 1) store.touch(req.token);
    store.decide(req.token, "approve");
    store.fulfill(req.token);

    // Growing a file per mutation without collecting them would fill the
    // operator's home over a long-running day.
    expect(stateFiles(statePath).length).toBeLessThanOrEqual(2);
    expect(readdirSync(dirname(statePath)).filter((e) => e.endsWith(".tmp"))).toEqual([]);
    store.dispose();
  });

  test("the generation behind the newest is kept, so a peer one behind is cheap", () => {
    const statePath = pairRequestStatePath(tempConfigHome());
    const store = createPendingPairRequestStore({ statePath });
    const req = store.create({ requesterIp: "192.168.1.56" });
    store.touch(req.token);
    store.decide(req.token, "approve");

    const newest = latestPairRequestGeneration(statePath) as number;
    expect(existsSync(pairRequestGenerationPath(statePath, newest))).toBe(true);
    expect(existsSync(pairRequestGenerationPath(statePath, newest - 1))).toBe(true);
    expect(existsSync(pairRequestGenerationPath(statePath, newest - 2))).toBe(false);
    store.dispose();
  });

  test("state left by the previous single-file store is adopted as generation 0", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    // Exactly what the pre-swap store wrote, at exactly the path it wrote it
    // to: an upgrade must not drop a request a phone is already polling.
    const t = Date.now();
    const legacy = {
      token: "legacy-token",
      status: "pending",
      requesterIp: "192.168.1.57",
      requesterLabel: "iPhone",
      route: null,
      createdAt: t,
      updatedAt: t,
      expiresAt: t + 60_000,
    };
    writeFileSync(statePath, JSON.stringify({ version: 1, requests: [legacy] }));
    expect(latestPairRequestGeneration(statePath)).toBe(0);

    const store = createPendingPairRequestStore({ statePath });
    expect(store.get("legacy-token")?.requesterLabel).toBe("iPhone");
    expect(store.decide("legacy-token", "approve")?.status).toBe("approved");
    expect(latestPairRequestGeneration(statePath)).toBe(1);

    // ...and once it is two generations behind it is collected like any other.
    store.touch("legacy-token");
    store.decide("legacy-token", "approve");
    expect(existsSync(statePath)).toBe(false);
    store.dispose();
  });

  test.skipIf(runsAsRoot)("an unwritable home degrades immediately rather than stalling", () => {
    // A read-only `~/.openscout` cannot be published to at all. That has to
    // fail fast: retrying a swap that cannot be attempted would turn a degraded
    // instance into an unresponsive one.
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(statePath), 0o500);

    const store = createPendingPairRequestStore({ statePath });
    const startedAt = Date.now();
    const req = store.create({ requesterIp: "192.168.1.58" });
    const elapsed = Date.now() - startedAt;

    expect(req.status).toBe("pending");
    expect(published(statePath)).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
    store.dispose();
  });
});

// The case that a lock cannot survive, and the reason this publishes by
// compare-and-swap instead.
//
// An instance loads the shared state and is then descheduled — SIGSTOP here,
// but a machine under load, a slept laptop or a paused container are the same
// thing. A lock has to be breakable or a crash wedges pairing on this Mac
// forever, and no staleness rule can tell a dead holder from a stopped one: the
// peer breaks the lock, publishes its approval, and the sleeper wakes up still
// believing it holds the lock and republishes the pending row over it. Codex
// reproduced exactly that, 1/1 with SIGSTOP and 3/3 with a controlled delay.
//
// Under a swap the sleeper's `link` simply fails, and it re-applies its poll on
// top of the approval it had not seen. The assertions below are on the
// mechanism, not just the outcome: the woken instance is required to have
// published a LATER generation than the decision it slept through, because a
// test where it never got to write anything would prove nothing.
describe("pending pair request store with a suspended instance", () => {
  interface SuspendedRun {
    /** What the suspended instance reported once it was let go. */
    worker: {
      pausedAtGeneration: number | null;
      finalGeneration: number | null;
      status: string | null;
      expiresAt: number | null;
    };
    /** The newest generation at the moment the peer was done working. */
    generationAfterPeer: number | null;
    statePath: string;
  }

  /**
   * Freeze one instance mid-mutation, run `peer` against the same state while
   * it is stopped, then let it go and report what each side ended up with.
   */
  async function suspend(
    operation: "touch" | "approve",
    peer: (
      store: ReturnType<typeof createPendingPairRequestStore>,
      token: string,
    ) => void | Promise<void>,
  ): Promise<SuspendedRun> {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const pausedSignal = join(home, "paused.json");
    const peerStore = createPendingPairRequestStore({ statePath, ttlMs: 60_000 });
    const token = peerStore.create({ requesterIp: "192.168.1.70", requesterLabel: "iPhone" }).token;

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "pairing-pair-requests.suspend-worker.ts"),
        `--state=${statePath}`,
        `--token=${token}`,
        `--operation=${operation}`,
        `--paused=${pausedSignal}`,
      ],
      env: { ...process.env, OPENSCOUT_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const deadline = Date.now() + 30_000;
      while (!existsSync(pausedSignal)) {
        if (Date.now() > deadline) throw new Error("the worker never suspended itself");
        await Bun.sleep(2);
      }
      // Genuinely stopped by the kernel rather than merely slow: "T" is what a
      // lock's staleness rule would be looking at while calling it dead.
      const state = await new Response(
        Bun.spawn({ cmd: ["ps", "-o", "state=", "-p", String(child.pid)], stdout: "pipe" }).stdout,
      ).text();
      expect(state.trim().startsWith("T")).toBe(true);

      await peer(peerStore, token);
      const generationAfterPeer = latestPairRequestGeneration(statePath);
      // Let the clock move before waking it. A poll only publishes when it
      // actually extends the window, and `Date.now()` has millisecond
      // resolution: resumed inside the same millisecond the peer decided in,
      // the sleeper would find nothing to write and the test would be asserting
      // that a write it never attempted did no harm.
      await Bun.sleep(20);

      process.kill(child.pid, "SIGCONT");
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if ((await child.exited) !== 0) throw new Error(`suspend worker failed:\n${err}`);
      peerStore.dispose();
      return { worker: JSON.parse(out) as SuspendedRun["worker"], generationAfterPeer, statePath };
    } finally {
      try {
        process.kill(child.pid, "SIGCONT");
        child.kill();
      } catch {
        // Already gone.
      }
    }
  }

  /** What a fresh instance reads back, i.e. what the phone would be told. */
  function readBack(statePath: string, token: string): string | null {
    const observer = createPendingPairRequestStore({ statePath, ttlMs: 60_000 });
    const status = observer.get(token)?.status ?? null;
    observer.dispose();
    return status;
  }

  test(
    "a poll that slept through an approval re-applies itself on top of it",
    async () => {
      let token = "";
      const run = await suspend("touch", (store, requestToken) => {
        token = requestToken;
        expect(store.decide(requestToken, "approve")?.status).toBe("approved");
      });

      // It really did load the pre-approval state...
      expect(run.worker.pausedAtGeneration).toBe(1);
      // ...the human's approval really did land while it was stopped...
      expect(run.generationAfterPeer).toBe(2);
      // ...and it really did write afterwards, on top of the approval instead
      // of over it. That last assertion is the one the lock failed: a test
      // where the woken instance never got to write would prove nothing.
      expect(run.worker.finalGeneration).toBe(3);
      expect(run.worker.status).toBe("approved");
      expect(readBack(run.statePath, token)).toBe("approved");
    },
    30_000,
  );

  test(
    "a suspension longer than any lock timeout still loses nothing",
    async () => {
      // Past the 10s the old contention timeout gave up at, after which both
      // stores went ahead unserialized and the approval was lost 1/1. There is
      // no timeout to reach any more: a writer that cannot win the swap has not
      // written anything, so it loads what it lost to and applies itself again.
      const decided = new Map<string, "approved" | "denied">();
      const run = await suspend("touch", async (store, token) => {
        expect(store.decide(token, "approve")?.status).toBe("approved");
        decided.set(token, "approved");
        const heldUntil = Date.now() + 12_000;
        while (Date.now() < heldUntil) {
          const other = store.create({ requesterIp: `192.168.2.${(decided.size % 40) + 1}` });
          const decision = decided.size % 2 === 0 ? "approve" : "deny";
          expect(store.decide(other.token, decision)?.token).toBe(other.token);
          decided.set(other.token, decision === "approve" ? "approved" : "denied");
          await Bun.sleep(150);
        }
      });

      expect(run.worker.pausedAtGeneration).toBe(1);
      expect(decided.size).toBeGreaterThan(30);
      expect(run.generationAfterPeer).toBeGreaterThan(30);
      expect(run.worker.finalGeneration).toBeGreaterThan(run.generationAfterPeer as number);
      expect(run.worker.status).toBe("approved");

      // Not only the row the sleeper was holding: every decision taken during
      // the twelve seconds it was stopped survived its stale republish.
      const observer = createPendingPairRequestStore({ statePath: run.statePath, ttlMs: 60_000 });
      const reverted = [...decided].filter(
        ([token, status]) => observer.get(token)?.status !== status,
      );
      observer.dispose();
      expect(reverted).toEqual([]);
    },
    60_000,
  );

  test(
    "an approval made while suspended is re-applied over the polls it missed",
    async () => {
      // The other direction: the human's instance is the one that stops, so the
      // decision is the write that arrives late. It must not be dropped either.
      let token = "";
      const run = await suspend("approve", async (store, requestToken) => {
        token = requestToken;
        for (let i = 0; i < 5; i += 1) {
          store.touch(requestToken);
          await Bun.sleep(20);
        }
        expect(store.get(requestToken)?.status).toBe("pending");
      });

      expect(run.worker.pausedAtGeneration).toBe(1);
      expect(run.worker.finalGeneration).toBeGreaterThan(run.generationAfterPeer as number);
      expect(run.worker.status).toBe("approved");
      expect(readBack(run.statePath, token)).toBe("approved");
    },
    30_000,
  );
});

// The floor for a degraded instance is the per-process store this replaced: it
// kept a request it could not share. Dropping it is worse than not having the
// shared file at all, because the phone gets 410 and stops polling.
describe("pending pair request store with an unwritable home", () => {
  /** What the next instance to read the file is told — i.e. what the phone gets. */
  function freshRead(statePath: string, token: string, now: () => number): PairRequest | null {
    const observer = createPendingPairRequestStore({ statePath, now });
    const seen = observer.get(token);
    observer.dispose();
    return seen;
  }

  test.skipIf(runsAsRoot)(
    "keeps serving a request it could not publish when another instance publishes",
    () => {
      const home = tempConfigHome();
      const statePath = pairRequestStatePath(home);
      const runDirectory = dirname(statePath);
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

      const degraded = createPendingPairRequestStore({ statePath });
      chmodSync(runDirectory, 0o500); // ~/.openscout on a read-only volume
      const stranded = degraded.create({ requesterIp: "192.168.1.58", requesterLabel: "iPhone" });

      // It really did fail to publish — otherwise this test proves nothing.
      expect(published(statePath)).toBe(false);
      expect(degraded.get(stranded.token)?.token).toBe(stranded.token);

      chmodSync(runDirectory, 0o700);
      const writable = createPendingPairRequestStore({ statePath });
      const unrelated = writable.create({ requesterIp: "192.168.1.59" });
      expect(published(statePath)).toBe(true);

      // The other instance's publication must not evict the token this instance
      // is the only holder of.
      expect(degraded.get(stranded.token)?.token).toBe(stranded.token);
      expect(degraded.list().map((r) => r.token).sort())
        .toEqual([stranded.token, unrelated.token].sort());

      degraded.dispose();
      writable.dispose();
    },
  );

  test.skipIf(runsAsRoot)("republishes a stranded request once the home is writable", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

    const degraded = createPendingPairRequestStore({ statePath });
    chmodSync(runDirectory, 0o500);
    const stranded = degraded.create({ requesterIp: "192.168.1.60" });
    chmodSync(runDirectory, 0o700);

    // The device is still polling, which is the next mutation this instance
    // makes — and the retry rides along on it.
    degraded.touch(stranded.token);

    const other = createPendingPairRequestStore({ statePath });
    expect(other.get(stranded.token)?.token).toBe(stranded.token);

    degraded.dispose();
    other.dispose();
  });

  test.skipIf(runsAsRoot)("an approval on the shared file beats an unpublished poll", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

    const writable = createPendingPairRequestStore({ statePath });
    const req = writable.create({ requesterIp: "192.168.1.61" });

    const degraded = createPendingPairRequestStore({ statePath });
    expect(degraded.get(req.token)?.status).toBe("pending");
    chmodSync(runDirectory, 0o500);
    degraded.touch(req.token); // held only in this instance's memory

    chmodSync(runDirectory, 0o700);
    writable.decide(req.token, "approve");

    // Merging back an unpublished row must not undo a decision that reached the
    // shared file; only a poll went missing, and a poll carries no decision.
    expect(degraded.get(req.token)?.status).toBe("approved");

    degraded.dispose();
    writable.dispose();
  });

  test.skipIf(runsAsRoot)("an unpublished approval survives another instance's poll", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

    const writable = createPendingPairRequestStore({ statePath });
    const req = writable.create({ requesterIp: "192.168.1.65" });

    const degraded = createPendingPairRequestStore({ statePath });
    expect(degraded.get(req.token)?.status).toBe("pending");
    chmodSync(runDirectory, 0o500);
    // The human approved on the instance whose home happens to be read-only.
    expect(degraded.decide(req.token, "approve")?.status).toBe("approved");

    chmodSync(runDirectory, 0o700);
    writable.touch(req.token); // the phone is still polling the other instance

    // The other way round from the test above: a poll republishing the row must
    // not silently revert an answer this instance could not publish. The
    // per-process store kept it, so this one has to as well.
    expect(degraded.get(req.token)?.status).toBe("approved");

    degraded.dispose();
    writable.dispose();
  });

  // Keeping what could not be published is the floor; keeping it forever is a
  // hole. A row that reached the shared file and was then deleted there is not
  // a row only this instance has, and merging it back republishes a token whose
  // payload has already been handed over.
  test.skipIf(runsAsRoot)(
    "does not resurrect a row another instance fulfilled while it could not publish",
    () => {
      const home = tempConfigHome();
      const statePath = pairRequestStatePath(home);
      const runDirectory = dirname(statePath);
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      const clock = fixedClock();

      const writable = createPendingPairRequestStore({ statePath, now: clock.now });
      const req = writable.create({ requesterIp: "192.168.1.66" });
      expect(latestPairRequestGeneration(statePath)).toBe(1);

      // The phone is polling THIS instance, so it has read the row out of the
      // shared file. That is what makes it different from a row nobody else has.
      const degraded = createPendingPairRequestStore({ statePath, now: clock.now });
      expect(degraded.get(req.token)?.token).toBe(req.token);

      chmodSync(runDirectory, 0o500); // ~/.openscout goes read-only mid-pair
      clock.advance(1_000);
      degraded.touch(req.token); // a poll that gets no further than memory
      expect(latestPairRequestGeneration(statePath)).toBe(1);

      // Writes come back, and the OTHER instance delivers the payload.
      chmodSync(runDirectory, 0o700);
      writable.fulfill(req.token);
      expect(latestPairRequestGeneration(statePath)).toBe(2);
      expect(freshRead(statePath, req.token, clock.now)).toBeNull();

      // The phone polls once more. Its stranded row is not one the shared state
      // has never seen — it is one a peer deleted at a later generation.
      clock.advance(1_000);
      degraded.touch(req.token);
      expect(degraded.get(req.token)).toBeNull();
      expect(degraded.list()).toEqual([]);
      // Nothing was written at all: there is no outstanding row left to owe.
      expect(latestPairRequestGeneration(statePath)).toBe(2);
      expect(freshRead(statePath, req.token, clock.now)).toBeNull();

      degraded.dispose();
      writable.dispose();
    },
  );

  test.skipIf(runsAsRoot)(
    "keeps a row stranded in the same window as one a peer fulfilled",
    () => {
      const home = tempConfigHome();
      const statePath = pairRequestStatePath(home);
      const runDirectory = dirname(statePath);
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      const clock = fixedClock();

      const writable = createPendingPairRequestStore({ statePath, now: clock.now });
      const shared = writable.create({ requesterIp: "192.168.1.67" });

      const degraded = createPendingPairRequestStore({ statePath, now: clock.now });
      expect(degraded.get(shared.token)?.token).toBe(shared.token);

      // One unwritable window, two rows: a poll of the row the file already
      // holds, and a second device that taps this instance and gets registered
      // somewhere nobody else can see.
      chmodSync(runDirectory, 0o500);
      clock.advance(1_000);
      degraded.touch(shared.token);
      const stranded = degraded.create({ requesterIp: "192.168.1.68" });
      expect(latestPairRequestGeneration(statePath)).toBe(1);

      chmodSync(runDirectory, 0o700);
      writable.fulfill(shared.token);
      expect(latestPairRequestGeneration(statePath)).toBe(2);

      // The merge has to answer both at once, out of the same degraded window:
      // drop the row a peer deleted, keep the row only this instance has held.
      clock.advance(1_000);
      degraded.touch(stranded.token);
      expect(degraded.get(shared.token)).toBeNull();
      expect(degraded.get(stranded.token)?.token).toBe(stranded.token);

      // And the retained row reaches the file on that same write, without
      // carrying the fulfilled one back with it.
      expect(latestPairRequestGeneration(statePath)).toBe(3);
      expect(freshRead(statePath, stranded.token, clock.now)?.token).toBe(stranded.token);
      expect(freshRead(statePath, shared.token, clock.now)).toBeNull();

      degraded.dispose();
      writable.dispose();
    },
  );

  // The other half of the same ambiguity. A row leaving the shared state is
  // terminal when the payload was handed over and garbage collection when a
  // sweep ran on knowledge older than an extension it could not see — and the
  // sweeper is by construction the instance that cannot see it. Reading the
  // second as the first answers a device with 410 for a token that is still
  // good, which is the failure this whole file exists to prevent.
  test.skipIf(runsAsRoot)("keeps a touch extension a peer's expiry sweep could not see", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const clock = fixedClock();
    const ttlMs = 1_000;

    const writable = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    const req = writable.create({ requesterIp: "192.168.1.70" });
    expect(latestPairRequestGeneration(statePath)).toBe(1);

    // The phone is polling THIS instance, which read the row out of the shared
    // file — so the row has been seen there, and its later absence is something
    // that has to be explained rather than assumed.
    const degraded = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    expect(degraded.get(req.token)?.token).toBe(req.token);

    // A read-only window in which the device keeps polling. The extension is
    // legal and it is the truth; it just cannot be published.
    chmodSync(runDirectory, 0o500);
    clock.advance(900);
    degraded.touch(req.token);
    const extendedTo = clock.now() + ttlMs;
    expect(degraded.get(req.token)?.expiresAt).toBe(extendedTo);
    expect(latestPairRequestGeneration(statePath)).toBe(1);

    // Past the expiry the OTHER instance can see, which knows nothing of the
    // extension, so its next write collects the row.
    chmodSync(runDirectory, 0o700);
    clock.advance(200);
    expect(clock.now()).toBeGreaterThan(req.expiresAt);
    writable.create({ requesterIp: "192.168.1.71" });
    expect(latestPairRequestGeneration(statePath)).toBe(2);
    expect(freshRead(statePath, req.token, clock.now)).toBeNull();

    // Absence at a later generation — but nobody handed this token's payload
    // over. It was collected on knowledge older than the extension, and the
    // extension is the newer fact, so the row survives with it intact.
    expect(degraded.get(req.token)?.expiresAt).toBe(extendedTo);
    // ...and goes back into the shared file on the next poll, so the phone
    // still gets its payload from whichever instance mDNS hands it.
    degraded.touch(req.token);
    expect(freshRead(statePath, req.token, clock.now)?.token).toBe(req.token);

    degraded.dispose();
    writable.dispose();
  });

  test.skipIf(runsAsRoot)("keeps an approval a peer's expiry sweep could not see", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const clock = fixedClock();
    const ttlMs = 1_000;

    const writable = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    const req = writable.create({ requesterIp: "192.168.1.72" });

    const degraded = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    expect(degraded.get(req.token)?.token).toBe(req.token);

    // The human answers on the instance whose home has gone read-only, which
    // gives the request a fresh window to be polled and fulfilled in.
    chmodSync(runDirectory, 0o500);
    clock.advance(900);
    expect(degraded.decide(req.token, "approve")?.status).toBe("approved");
    const extendedTo = clock.now() + ttlMs;
    expect(latestPairRequestGeneration(statePath)).toBe(1);

    chmodSync(runDirectory, 0o700);
    clock.advance(200);
    writable.create({ requesterIp: "192.168.1.73" });
    expect(latestPairRequestGeneration(statePath)).toBe(2);
    expect(freshRead(statePath, req.token, clock.now)).toBeNull();

    // Losing this one loses a human's answer to a sweep that never saw it.
    const kept = degraded.get(req.token);
    expect(kept?.status).toBe("approved");
    expect(kept?.expiresAt).toBe(extendedTo);

    degraded.touch(req.token);
    expect(freshRead(statePath, req.token, clock.now)?.status).toBe("approved");

    degraded.dispose();
    writable.dispose();
  });

  // The terminal marker is a write like any other, so it has to survive a home
  // that will not take it — otherwise the instance that delivered the payload
  // is the one instance that forgets it did.
  test.skipIf(runsAsRoot)("keeps a fulfil it could not publish buried", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const clock = fixedClock();
    const ttlMs = 10_000;

    const writable = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    const req = writable.create({ requesterIp: "192.168.1.85" });

    const degraded = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    expect(degraded.get(req.token)?.token).toBe(req.token);

    // Pair mode is up on THIS instance, so it is the one that hands the payload
    // over — and its home has gone read-only, so nobody else can see that yet.
    chmodSync(runDirectory, 0o500);
    degraded.fulfill(req.token);
    expect(degraded.get(req.token)).toBeNull();
    expect(latestPairRequestGeneration(statePath)).toBe(1);

    // The device polls the other instance, which knows nothing about the
    // delivery and republishes the row it is still holding.
    chmodSync(runDirectory, 0o700);
    clock.advance(1_000);
    writable.touch(req.token);
    expect(latestPairRequestGeneration(statePath)).toBe(2);
    expect(freshRead(statePath, req.token, clock.now)?.token).toBe(req.token);

    // The stacked terminal outcome outlives that and lands when it can.
    clock.advance(1_000);
    expect(degraded.list()).toEqual([]);
    expect(degraded.get(req.token)).toBeNull();
    degraded.touch(req.token);
    expect(latestPairRequestGeneration(statePath)).toBe(3);
    expect(freshRead(statePath, req.token, clock.now)).toBeNull();

    degraded.dispose();
    writable.dispose();
  });

  test.skipIf(runsAsRoot)(
    "collects a terminal marker once the row it buries could not come back",
    () => {
      const home = tempConfigHome();
      const statePath = pairRequestStatePath(home);
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      const clock = fixedClock();
      const ttlMs = 1_000;

      const store = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
      const req = store.create({ requesterIp: "192.168.1.83" });
      store.fulfill(req.token);
      // It travels in the same swapped file the rows do, so a peer reading that
      // file knows the difference between this and a sweep.
      const marked = JSON.parse(readFileSync(currentStateFile(statePath), "utf8")) as {
        fulfilled: { token: string }[];
      };
      expect(marked.fulfilled.map((m) => m.token)).toEqual([req.token]);

      // Past the row's expiry plus the longest extension a single stranded
      // touch could have granted it, no copy anywhere can still be live, so the
      // marker has nothing left to suppress and stops being carried.
      clock.advance(2 * ttlMs + 1);
      store.create({ requesterIp: "192.168.1.84" });
      const collected = JSON.parse(readFileSync(currentStateFile(statePath), "utf8")) as {
        fulfilled: unknown[];
      };
      expect(collected.fulfilled).toEqual([]);

      store.dispose();
    },
  );

  // Handing the payload over and burying the token are ONE decision, and the
  // window between them is where they used to come apart. The shared copy of a
  // row can reach its expiry while a degraded peer holds a legal extension of
  // it that never got published; the commit a fulfil runs in prunes that
  // expired copy before the fulfil looks the row up, so what got published was
  // a deletion with an empty ledger — which is precisely what a sweep looks
  // like. The peer keeps its extension, republishes the row as pending, and a
  // token whose payload has already gone out is live again.
  test.skipIf(runsAsRoot)("never hands a payload over without burying the token", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const clock = fixedClock();
    const ttlMs = 1_000;

    const writable = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    const req = writable.create({ requesterIp: "192.168.1.90" });
    expect(latestPairRequestGeneration(statePath)).toBe(1);

    // The phone is polling the other instance, whose home goes read-only
    // mid-pair. Its extension is legal and it is the truth; it just cannot be
    // published, so the copy in the file still carries the original expiry.
    const degraded = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    expect(degraded.get(req.token)?.token).toBe(req.token);
    chmodSync(runDirectory, 0o500);
    clock.advance(900);
    degraded.touch(req.token);
    const extendedTo = clock.now() + ttlMs;
    expect(degraded.get(req.token)?.expiresAt).toBe(extendedTo);
    expect(latestPairRequestGeneration(statePath)).toBe(1);

    // Writes come back, and pair mode comes up on the instance that cannot see
    // the extension — so the only copy of the row it has is one its own commit
    // is about to prune.
    chmodSync(runDirectory, 0o700);
    clock.advance(200);
    expect(clock.now()).toBeGreaterThan(req.expiresAt);
    const delivered = writable.fulfill(req.token);

    // Whichever way that went, the two halves have to agree: a fulfil that
    // reports a delivery has published the marker that buries the token, and
    // one that reports none has said nothing about the token at all.
    expect(delivered === null).toBe(!markerTokens(statePath).includes(req.token));

    // And the peer holding the extension has to agree with the same decision. A
    // delivered token never comes back; a refused one is still the phone's to
    // retry against the instance that can actually see it.
    clock.advance(100);
    degraded.touch(req.token);
    expect(freshRead(statePath, req.token, clock.now) === null).toBe(delivered !== null);

    // The other side of the same ordering: a row that IS live when the payload
    // goes out is buried even though the very same commit is pruning somebody
    // else's expired row on the way past.
    const stale = writable.create({ requesterIp: "192.168.1.91" });
    clock.advance(ttlMs + 1);
    const fresh = writable.create({ requesterIp: "192.168.1.92" });
    expect(writable.fulfill(fresh.token)?.token).toBe(fresh.token);
    expect(markerTokens(statePath)).toContain(fresh.token);
    // The pruned row went for the other reason, and nothing may claim otherwise.
    expect(markerTokens(statePath)).not.toContain(stale.token);

    degraded.dispose();
    writable.dispose();
  });

  // A marker exists to outlive every copy of the row it buries, and the horizon
  // it is minted with is only a bound on the copies it can see. An instance
  // that delivered a payload while its home was unwritable holds the only
  // record of it, so the peers still holding the row keep extending it — and
  // they can push it past that horizon. Collecting the marker there hands the
  // next reload a live row and no reason to disbelieve it.
  test.skipIf(runsAsRoot)("keeps an unpublished marker while peers keep extending the row", () => {
    const home = tempConfigHome();
    const statePath = pairRequestStatePath(home);
    const runDirectory = dirname(statePath);
    mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const clock = fixedClock();
    const ttlMs = 1_000;

    const writable = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    const req = writable.create({ requesterIp: "192.168.1.93" });

    const degraded = createPendingPairRequestStore({ statePath, ttlMs, now: clock.now });
    expect(degraded.get(req.token)?.token).toBe(req.token);

    // Pair mode is up on THIS instance, so it is the one that hands the payload
    // over — and its home has just gone read-only, so the marker saying so
    // exists nowhere but in this process.
    chmodSync(runDirectory, 0o500);
    degraded.fulfill(req.token);
    expect(degraded.get(req.token)).toBeNull();
    expect(latestPairRequestGeneration(statePath)).toBe(1);
    const mintedHorizon = req.expiresAt + ttlMs;

    // The peer knows nothing of the delivery, and the device is still polling
    // it, so the row is extended again and again — every extension legal, and
    // every one of them pushing the row's life past the horizon the marker was
    // minted with.
    chmodSync(runDirectory, 0o700);
    for (let poll = 0; poll < 4; poll += 1) {
      clock.advance(900);
      writable.touch(req.token);
      // The instance that delivered the payload must go on saying so at every
      // point in that sequence, not just up to the horizon.
      expect(degraded.get(req.token)).toBeNull();
    }
    expect(clock.now()).toBeGreaterThan(mintedHorizon);
    expect(freshRead(statePath, req.token, clock.now)?.token).toBe(req.token);

    // Then the marker lands on the next write this instance makes, and the
    // spent row dies everywhere — including for a store that has never held it.
    degraded.touch(req.token);
    expect(markerTokens(statePath)).toContain(req.token);
    expect(freshRead(statePath, req.token, clock.now)).toBeNull();
    expect(writable.get(req.token)).toBeNull();

    degraded.dispose();
    writable.dispose();
  });

  // Generation numbers restart. A cleared run directory takes the chain back to
  // one, and "a later generation than the one I saw this row in" means nothing
  // across that boundary — the state we knew is not gone, it is unreachable.
  test.skipIf(runsAsRoot)(
    "does not read a restarted chain's first generation as a peer's deletion",
    () => {
      const home = tempConfigHome();
      const statePath = pairRequestStatePath(home);
      const runDirectory = dirname(statePath);
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      const clock = fixedClock();

      const writable = createPendingPairRequestStore({ statePath, now: clock.now });
      const req = writable.create({ requesterIp: "192.168.1.74" });
      expect(latestPairRequestGeneration(statePath)).toBe(1);

      const degraded = createPendingPairRequestStore({ statePath, now: clock.now });
      expect(degraded.get(req.token)?.token).toBe(req.token);
      writable.dispose();

      chmodSync(runDirectory, 0o500);
      clock.advance(1_000);
      degraded.touch(req.token); // a poll that gets no further than memory
      chmodSync(runDirectory, 0o700);

      // ~/.openscout/run is cleared — a reset, a restore, somebody tidying —
      // and an unrelated instance starts the chain again. Its generation 1 has
      // the number the row was last seen at and a different file behind it.
      rmSync(runDirectory, { recursive: true, force: true });
      const restarted = createPendingPairRequestStore({ statePath, now: clock.now });
      const unrelated = restarted.create({ requesterIp: "192.168.1.75" });
      expect(latestPairRequestGeneration(statePath)).toBe(1);

      // Nothing in a chain that has never held this row says anybody deleted it.
      expect(degraded.get(req.token)?.token).toBe(req.token);
      // And it republishes into the chain that replaced the one it came from.
      degraded.touch(req.token);
      expect(freshRead(statePath, req.token, clock.now)?.token).toBe(req.token);
      expect(freshRead(statePath, unrelated.token, clock.now)?.token).toBe(unrelated.token);

      degraded.dispose();
      restarted.dispose();
    },
  );

  test.skipIf(runsAsRoot)(
    "does not read a restarted chain that outgrew the old one as a peer's deletion",
    () => {
      const home = tempConfigHome();
      const statePath = pairRequestStatePath(home);
      const runDirectory = dirname(statePath);
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      const clock = fixedClock();

      const writable = createPendingPairRequestStore({ statePath, now: clock.now });
      const req = writable.create({ requesterIp: "192.168.1.76" });
      writable.create({ requesterIp: "192.168.1.77" });
      writable.create({ requesterIp: "192.168.1.78" });
      expect(latestPairRequestGeneration(statePath)).toBe(3);

      const degraded = createPendingPairRequestStore({ statePath, now: clock.now });
      expect(degraded.get(req.token)?.token).toBe(req.token);
      writable.dispose();

      chmodSync(runDirectory, 0o500);
      clock.advance(1_000);
      degraded.touch(req.token);
      chmodSync(runDirectory, 0o700);

      // Same clearing, but this time the new chain climbs past the number the
      // row was last seen at, which used to read as a peer moving on without it.
      rmSync(runDirectory, { recursive: true, force: true });
      const restarted = createPendingPairRequestStore({ statePath, now: clock.now });
      for (const ip of ["192.168.1.79", "192.168.1.80", "192.168.1.81", "192.168.1.82"]) {
        restarted.create({ requesterIp: ip });
      }
      expect(latestPairRequestGeneration(statePath)).toBe(4);

      expect(degraded.get(req.token)?.token).toBe(req.token);
      degraded.touch(req.token);
      expect(freshRead(statePath, req.token, clock.now)?.token).toBe(req.token);

      degraded.dispose();
      restarted.dispose();
    },
  );
});

// A pair-request row is a bearer credential: whoever reads one can complete the
// pair. The guard exists because a web-server test once wrote a live pending
// token into the runner's real ~/.openscout/run/pair-requests.json.
describe("pending pair request store test isolation", () => {
  const realHomeStatePath = pairRequestStatePath(join(homedir(), ".openscout"));

  test("refuses to write shared state without an isolated OPENSCOUT_HOME", () => {
    const saved = process.env.OPENSCOUT_HOME;
    delete process.env.OPENSCOUT_HOME;
    try {
      const store = createPendingPairRequestStore({ statePath: realHomeStatePath });
      expect(() => store.create({ requesterIp: "192.168.1.62" })).toThrow(/OPENSCOUT_HOME/);
      store.dispose();
    } finally {
      process.env.OPENSCOUT_HOME = saved;
    }
  });

  test("an isolated OPENSCOUT_HOME does not license writing to the real one", () => {
    // Set, but pointing somewhere else: the destination is checked too, so a
    // hard-coded real-home path cannot ride in on someone else's isolation.
    expect(process.env.OPENSCOUT_HOME).toBe(isolatedHome);
    const store = createPendingPairRequestStore({ statePath: realHomeStatePath });
    expect(() => store.create({ requesterIp: "192.168.1.63" })).toThrow(/inside the real/);
    store.dispose();
  });

  test("reading is unaffected — only writes are refused", () => {
    // The guard must not turn a real home into an exception on the read path,
    // or a server whose home is fine would fail for the wrong reason.
    const store = createPendingPairRequestStore({ statePath: realHomeStatePath });
    expect(() => store.get("nope")).not.toThrow();
    expect(() => store.list()).not.toThrow();
    store.dispose();
  });

  // A lexical containment check answers "does this string start with the
  // isolated home", which is not the question. The question is where the bytes
  // land, and a symlink beneath the isolated home answers it differently: a
  // `run` directory pointing at `~/.openscout/run` reads as isolated and writes
  // a live bearer token into the operator's actual home. Each case below runs
  // in a child process started with HOME pointing at a temp directory, because
  // `homedir()` is read once at startup and the real home is precisely what
  // must not be involved in proving this.
  describe("a symlink out of the isolated home", () => {
    interface Bypass {
      /** What the child reported, if the write was refused. */
      refused: string | null;
      /** Anything that landed in the stand-in for the real home. */
      landed: string[];
    }

    async function attemptBypass(targetExists: boolean): Promise<Bypass> {
      const root = mkdtempSync(join(tmpdir(), "openscout-pair-guard-"));
      tempHomes.push(root);
      const fakeRealHome = join(root, "home");
      const fakeRealRun = join(fakeRealHome, ".openscout", "run");
      // The dangling case matters on its own: resolving only the part of the
      // path that already exists would see straight past a link whose target
      // has not been created yet, and the writer creates it on the way past.
      mkdirSync(targetExists ? fakeRealRun : join(fakeRealHome, ".openscout"), {
        recursive: true,
      });
      const isolated = join(root, "isolated");
      mkdirSync(isolated, { recursive: true });
      symlinkSync(fakeRealRun, join(isolated, "run"));

      const child = Bun.spawn({
        cmd: [
          process.execPath,
          join(import.meta.dir, "pairing-pair-requests.isolation-worker.ts"),
          `--state=${join(isolated, "run", "pair-requests.json")}`,
        ],
        env: { ...process.env, HOME: fakeRealHome, OPENSCOUT_HOME: isolated, NODE_ENV: "test" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if ((await child.exited) !== 0) throw new Error(`isolation worker failed:\n${err}`);
      return {
        refused: (JSON.parse(out) as { refused: string | null }).refused,
        landed: existsSync(fakeRealRun) ? readdirSync(fakeRealRun) : [],
      };
    }

    test("is refused, and writes nothing to the home it resolves into", async () => {
      const result = await attemptBypass(true);
      expect(result.refused).toMatch(/inside the real/);
      expect(result.landed).toEqual([]);
    });

    test("is refused even when the link target does not exist yet", async () => {
      const result = await attemptBypass(false);
      expect(result.refused).toMatch(/inside the real/);
      expect(result.landed).toEqual([]);
    });
  });
});
