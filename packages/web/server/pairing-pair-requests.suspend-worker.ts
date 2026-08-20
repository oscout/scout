// An instance frozen in the middle of a pair-request mutation.
//
// Test fixture for `pairing-pair-requests.test.ts`. This is the case a file
// lock cannot survive and the reason the store publishes by compare-and-swap:
// an instance that loads the shared state and is then descheduled — a stopped
// process, a machine under load, a laptop that slept — comes back believing it
// still holds the state it read, and anything it writes on that belief reverts
// whatever landed while it was away. A lock makes it worse rather than better,
// because the peer has to break the lock to make progress at all and then both
// sides are inside the critical section.
//
// The freeze is a real SIGSTOP, not a sleep: the process is stopped by the
// kernel with its state loaded and its write not yet made, and only the parent
// deciding to SIGCONT it brings it back. The pause is taken from inside the
// injected clock, which the store calls after loading and before publishing, so
// where it lands is exact rather than lucky.
//
// Prints one JSON line: the generation it loaded, the generation the state
// reached once it was let go, and what it sees for the token afterwards.

import { renameSync, writeFileSync } from "node:fs";
import {
  createPendingPairRequestStore,
  latestPairRequestGeneration,
} from "./pairing-pair-requests.ts";

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  if (!found) throw new Error(`missing --${name}`);
  return found.slice(prefix.length);
}

const statePath = requiredArg("state");
const token = requiredArg("token");
const operation = requiredArg("operation") as "touch" | "approve";
const pausedSignal = requiredArg("paused");

let armed = false;
let pausedAtGeneration: number | null = null;

const now = (): number => {
  if (armed && pausedAtGeneration === null) {
    // The store has loaded the shared state and has not published yet: exactly
    // the window a staleness rule would evict us in.
    pausedAtGeneration = latestPairRequestGeneration(statePath);
    const temp = `${pausedSignal}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ pid: process.pid, pausedAtGeneration }));
    renameSync(temp, pausedSignal);
    process.kill(process.pid, "SIGSTOP");
  }
  return Date.now();
};

const store = createPendingPairRequestStore({ statePath, ttlMs: 60_000, now });

armed = true;
if (operation === "touch") {
  store.touch(token);
} else {
  store.decide(token, "approve");
}
armed = false;

const settled = store.get(token);
process.stdout.write(
  `${
    JSON.stringify({
      pausedAtGeneration,
      finalGeneration: latestPairRequestGeneration(statePath),
      status: settled?.status ?? null,
      expiresAt: settled?.expiresAt ?? null,
    })
  }\n`,
);
store.dispose();
