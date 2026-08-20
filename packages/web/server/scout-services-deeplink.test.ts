import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createSignedScoutServicesRestartUrl,
  parseScoutServicesRestartTarget,
  verifySignedScoutServicesRestartUrl,
} from "./scout-services-deeplink.ts";

const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
let tempRoot: string | null = null;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
});

function useTempSupportDirectory(): string {
  tempRoot = mkdtempSync(join(tmpdir(), "openscout-service-link-"));
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = tempRoot;
  return tempRoot;
}

describe("Scout Services deep links", () => {
  test("parses supported restart targets", () => {
    expect(parseScoutServicesRestartTarget("broker")).toBe("broker");
    expect(parseScoutServicesRestartTarget(" RELAY ")).toBe("relay");
    expect(parseScoutServicesRestartTarget("web")).toBe("web");
    expect(parseScoutServicesRestartTarget("all")).toBe("all");
    expect(parseScoutServicesRestartTarget("tailscale")).toBeNull();
  });

  test("creates short-lived signed restart URLs", () => {
    useTempSupportDirectory();
    const nowMs = 1_800_000_000_000;
    const signed = createSignedScoutServicesRestartUrl("broker", {
      nowMs,
      nonce: "test-nonce",
    });

    expect(signed.url.startsWith("scout://services/restart/broker?")).toBe(true);
    expect(verifySignedScoutServicesRestartUrl(signed.url, { nowMs })).toBe(true);
    expect(verifySignedScoutServicesRestartUrl(signed.url, { nowMs: signed.expiresAt + 1 })).toBe(false);

    const tampered = signed.url.replace("/broker?", "/web?");
    expect(verifySignedScoutServicesRestartUrl(tampered, { nowMs })).toBe(false);
  });
});
