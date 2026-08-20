import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvedPairingConfig } from "./config.ts";

const originalHome = process.env.HOME;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

test("pairing config can take the hosted mobile relay from environment", () => {
  expect(resolvedPairingConfig({
    OPENSCOUT_PAIRING_RELAY_URL: " wss://mesh.oscout.net/v1/relay ",
  }).relay).toBe("wss://mesh.oscout.net/v1/relay");
});

test("pairing config uses an explicit pairing port environment override", () => {
  expect(resolvedPairingConfig({
    OPENSCOUT_PAIRING_PORT: "45630",
  }).port).toBe(45630);
});

test("pairing config uses the local Scout pairing port before the legacy file", () => {
  const home = join(tmpdir(), `openscout-pairing-config-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const openScoutHome = join(home, ".openscout");
  const pairingHome = join(home, ".scout", "pairing");
  testDirectories.add(home);
  mkdirSync(openScoutHome, { recursive: true });
  mkdirSync(pairingHome, { recursive: true });
  writeFileSync(join(openScoutHome, "config.json"), JSON.stringify({
    version: 1,
    ports: { pairing: 45631 },
  }), "utf8");
  writeFileSync(join(pairingHome, "config.json"), JSON.stringify({
    port: 45632,
  }), "utf8");
  process.env.HOME = home;
  process.env.OPENSCOUT_HOME = openScoutHome;

  expect(resolvedPairingConfig({}).port).toBe(45631);
});
