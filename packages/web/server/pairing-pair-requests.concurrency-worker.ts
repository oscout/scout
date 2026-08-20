// One half of a two-process race over a single shared pair-request file.
//
// Test fixture for `pairing-pair-requests.test.ts`, which spawns this twice —
// once as `decider`, once as `poller` — against one state file. Two stores in
// one process cannot reproduce the bug this store exists to prevent: JavaScript
// is single-threaded, so a read-modify-write can never interleave with another
// one and a "concurrent" test in-process is really a sequential test. The
// production case is two OS processes, and only two OS processes contend for
// the generation that makes them safe.
//
// The shape of the race is the real one: the phone polls (touch) the instance
// mDNS handed it while the human decides (approve/deny) on the other, or an
// expired row is being collected on one instance while the other is polling it.
// Both sides rendezvous on a wall-clock instant carried in the `go` signal so
// they act as close to simultaneously as two processes can.
//
// The `sweep` scenario is the same collision one step further on: the poller's
// window is long and the sweeper's is short, so the sweeper reaches an expiry
// the poller has already extended past. Whichever way the two publications
// order, the answer has to be the same one — an extension that took must
// survive the sweep, and a token whose payload was handed over must not come
// back through it.
//
// The `fulfil` scenario races the delivery itself. The instance pair mode came
// up on has the short window, and it hands the payload over PAST that window —
// so the only thing keeping the row alive is the extension the other instance
// made a moment earlier. Handing a payload over and burying the token are one
// decision, and this is where they are furthest apart: the row this side can
// see is expired and the one in the file is not. Either the store delivers and
// the token is dead on both instances from that moment, or it delivers nothing
// at all. What must never happen is a payload going out while the instance
// holding the extension goes on serving the token.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPendingPairRequestStore } from "./pairing-pair-requests.ts";

type Role = "decider" | "poller";
type Scenario = "approve" | "deny" | "expire" | "sweep" | "fulfil";

interface GoSignal {
  round: number;
  token: string;
  /** Wall-clock instant both sides act on. */
  actAt: number;
}

interface DoneSignal {
  round: number;
}

/** What the decider did with the token, for the side that has to live with it. */
interface ActedSignal extends DoneSignal {
  delivered: boolean;
}

/** Long enough for the peer to notice the signal, short enough to stay cheap. */
const RENDEZVOUS_MS = 1;
const SIGNAL_TIMEOUT_MS = 30_000;
/** The sweeping instance's window: rows are live at the rendezvous, then not. */
const SWEEP_TTL_MS = 3;
/** How long after the rendezvous the sweeper writes, i.e. past its own window. */
const SWEEP_DELAY_MS = 6;

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  if (!found) throw new Error(`missing --${name}`);
  return found.slice(prefix.length);
}

function publish(path: string, value: GoSignal | DoneSignal | ActedSignal): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

function readSignal<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Absent, or caught mid-rename on a filesystem without atomic rename
    // semantics. Either way: spin again.
    return null;
  }
}

function awaitSignal<T extends { round: number }>(path: string, round: number): T {
  const deadline = Date.now() + SIGNAL_TIMEOUT_MS;
  for (;;) {
    const signal = readSignal<T>(path);
    if (signal && signal.round === round) return signal;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for round ${round} signal at ${path}`);
    }
  }
}

function spinUntil(instant: number): void {
  while (Date.now() < instant) {
    // Deliberately a busy spin: a sleep would round up past the rendezvous and
    // hand the race to whichever process woke first.
  }
}

const role = requiredArg("role") as Role;
const scenario = requiredArg("scenario") as Scenario;
const rounds = Number(requiredArg("rounds"));
const statePath = requiredArg("state");
const signalDir = requiredArg("signals");
const goPath = join(signalDir, "go.json");
const donePath = join(signalDir, "done.json");
const sweptPath = join(signalDir, "swept.json");

// The expire scenario needs rows that are already expired by the rendezvous.
// The sweep and fulfil scenarios need the two instances to disagree about the
// window, so the collecting (or delivering) side runs a short one and the
// polling side a long one — which is the disagreement a device actively polling
// one instance creates anyway, made reliable. Every other scenario needs rows
// that outlive the round.
const ttlMs = scenario === "expire"
  ? 1
  : (scenario === "sweep" || scenario === "fulfil") && role === "decider"
    ? SWEEP_TTL_MS
    : 60_000;
const store = createPendingPairRequestStore({ statePath, ttlMs });

if (role === "decider") {
  let lost = 0;
  let resurrected = 0;
  /** Fulfils that actually handed a payload over, in the `fulfil` scenario. */
  let delivered = 0;
  /** Last round's fulfilled token, which this round's churn must not revive. */
  let buried: string | null = null;
  for (let round = 0; round < rounds; round += 1) {
    if (buried !== null && store.get(buried) !== null) resurrected += 1;
    const request = store.create({
      requesterIp: `10.0.0.${round % 250 + 1}`,
      requesterLabel: "iPhone",
    });
    const actAt = Date.now() + RENDEZVOUS_MS + (scenario === "expire" ? 1 : 0);
    publish(goPath, { round, token: request.token, actAt } satisfies GoSignal);

    spinUntil(actAt);
    if (scenario === "expire") {
      // The instance the human is looking at refreshing its list, which is what
      // used to collect expired rows out of the shared file.
      store.list();
    } else if (scenario === "sweep") {
      store.list();
      // Past this instance's own window, so its next write really does collect
      // the row — on knowledge that predates whatever the poller just did.
      spinUntil(actAt + SWEEP_DELAY_MS);
      store.create({ requesterIp: "10.1.0.1", requesterLabel: "sweeper" });
      publish(sweptPath, { round } satisfies DoneSignal);
    } else if (scenario === "fulfil") {
      // Past this instance's own window too, so the copy of the row it holds is
      // expired and the only reason the token is still open is the extension
      // the poller just published. The delivery is decided on that.
      spinUntil(actAt + SWEEP_DELAY_MS);
      const handedOver = store.fulfill(request.token);
      if (handedOver !== null) {
        delivered += 1;
        // Nothing may bring a token back once its payload has gone out, and the
        // instance that sent it is the first place that must agree.
        if (store.get(request.token) !== null) resurrected += 1;
        buried = request.token;
      }
      publish(sweptPath, { round, delivered: handedOver !== null } satisfies ActedSignal);
    } else {
      store.decide(request.token, scenario === "approve" ? "approve" : "deny");
    }

    awaitSignal<DoneSignal>(donePath, round);

    if (scenario === "fulfil") {
      // Delivered or refused, it was settled at the rendezvous; there is
      // nothing left for this round to do to the token.
      continue;
    }

    const settled = store.get(request.token);
    if (scenario === "expire") {
      // A poll must never bring an expired request back to life.
      if (settled !== null) resurrected += 1;
    } else if (scenario === "sweep") {
      // Whether the extension survived is the poller's to judge: it is the side
      // that knows whether its touch landed.
    } else if (settled?.status !== (scenario === "approve" ? "approved" : "denied")) {
      // The decision was made and then silently reverted by the poll.
      lost += 1;
    }

    store.fulfill(request.token);
    if (scenario === "sweep") {
      buried = request.token;
      if (store.get(request.token) !== null) resurrected += 1;
    }
  }
  process.stdout.write(
    `${JSON.stringify({ role, scenario, rounds, lost, resurrected, delivered })}\n`,
  );
} else {
  let touched = 0;
  let extended = 0;
  let lost = 0;
  for (let round = 0; round < rounds; round += 1) {
    const go = awaitSignal<GoSignal>(goPath, round);
    spinUntil(go.actAt);
    store.touch(go.token);
    touched += 1;
    if (scenario === "fulfil") {
      // An extension that took is the contested state: the row is alive here on
      // a window the other instance cannot see the end of, and it is about to
      // hand the payload over from exactly that.
      if (store.get(go.token) !== null) extended += 1;
      const acted = awaitSignal<ActedSignal>(sweptPath, round);
      // A payload went out. This instance is the one holding the extension, so
      // it is the one a lost marker would have serving a spent token.
      if (acted.delivered && store.get(go.token) !== null) lost += 1;
    } else if (scenario === "sweep") {
      // Only an extension that actually took is one there is anything to
      // defend: if the row had already gone by the time we got there, the touch
      // was a no-op and the sweeper was simply first, which is correct.
      if (store.get(go.token) !== null) {
        extended += 1;
        awaitSignal<DoneSignal>(sweptPath, round);
        // The other instance has now collected on an expiry it could see. Ours
        // is newer knowledge, so the row has to still be here.
        if (store.get(go.token) === null) lost += 1;
      }
    }
    publish(donePath, { round } satisfies DoneSignal);
  }
  process.stdout.write(
    `${JSON.stringify({ role, scenario, rounds, touched, extended, lost })}\n`,
  );
}

store.dispose();
