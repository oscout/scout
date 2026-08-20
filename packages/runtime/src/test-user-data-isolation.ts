import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point every OpenScout user-data path at a throwaway directory for the
 * lifetime of the test process. Call once at the top of any test file whose
 * code paths persist user state — writeOpenScoutSettings and writeLocalConfig
 * refuse to run under NODE_ENV=test without these env overrides (see
 * assertTestIsolatedUserData in support-paths.ts).
 *
 * Tests that need per-test isolation (a fresh fake home per test) should keep
 * managing the env themselves, like prepareHome in onboarding.test.ts.
 */
export function isolateOpenScoutUserDataForTests(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-test-userdata-"));
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  return home;
}
