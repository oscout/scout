// Imported first by the web server test harness, so these env overrides land
// before any server module (pairing.ts in particular) reads them.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before anything captures the ambient environment. The server builds a shared
// pair-request store keyed on `~/.openscout`, and a pairing test here once
// persisted a live bearer token into the runner's REAL home. The store now
// refuses to write without this set, so it is set for the whole file rather
// than per test — every restore below restores to this, not to the operator's
// home. Keep the control-plane writer in the same isolated tree as well; a
// clean CI runner has no ambient control-plane directory for SQLite to open.
export const isolatedTestHome = mkdtempSync(join(tmpdir(), "openscout-web-server-test-home-"));
process.env.OPENSCOUT_HOME = join(isolatedTestHome, ".openscout");
process.env.OPENSCOUT_CONTROL_HOME = join(isolatedTestHome, ".openscout", "control-plane");
// Roster queries also read the relay-agent registry from application support.
// Keep archived agents from the operator's real registry out of test fixtures.
process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(isolatedTestHome, "support");
mkdirSync(process.env.OPENSCOUT_CONTROL_HOME, { recursive: true });
