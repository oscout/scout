// A pair-request write attempted in a fresh process, for the isolation guard.
//
// Test fixture for `pairing-pair-requests.test.ts`. The guard's second
// condition is "not inside the REAL ~/.openscout", and `os.homedir()` reads
// $HOME once at startup under Bun — a test cannot repoint it in place. So the
// only way to exercise that condition against a *synthetic* home, rather than
// the operator's actual one, is to run the write in a child started with HOME
// pointing at a temp directory. Which is also the honest shape of the bug: the
// leak this guard exists to stop happened in a test-runner process, not in a
// contrived in-process call.
//
// Prints one JSON line: whether the write was refused, and why.

import { createPendingPairRequestStore } from "./pairing-pair-requests.ts";

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  if (!found) throw new Error(`missing --${name}`);
  return found.slice(prefix.length);
}

const store = createPendingPairRequestStore({ statePath: requiredArg("state") });
let refused: string | null = null;
try {
  store.create({ requesterIp: "192.168.1.99", requesterLabel: "iPhone" });
} catch (error) {
  refused = error instanceof Error ? error.message : String(error);
}
store.dispose();
process.stdout.write(`${JSON.stringify({ refused })}\n`);
