import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOpenScoutWebApplicationServerIdentity } from "./app-server-origin.ts";

function writeTailscaleFixture(body: unknown): { directory: string; filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "openscout-web-origin-"));
  const filePath = join(directory, "tailscale-status.json");
  writeFileSync(filePath, JSON.stringify(body, null, 2), "utf8");
  return { directory, filePath };
}

describe("resolveOpenScoutWebApplicationServerIdentity", () => {
  test("uses scout.local as the portal and a node host as the advertised host", () => {
    expect(
      resolveOpenScoutWebApplicationServerIdentity({}, "Hudson-Mini.local", { webLocalName: "m1.scout.local" }),
    ).toEqual({
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      publicOrigin: undefined,
      trustedHosts: ["m1.scout.local", "scout.local", "dev.scout.local", "hudson-mini.local"],
      trustedOrigins: [],
    });
  });

  test("trusts the public origin host and explicit trusted hosts", () => {
    expect(
      resolveOpenScoutWebApplicationServerIdentity(
        {
          OPENSCOUT_WEB_PUBLIC_ORIGIN: "https://scout.local",
          OPENSCOUT_WEB_TRUSTED_HOSTS: "scout.backup.local, 192.168.1.20",
          OPENSCOUT_WEB_TRUSTED_ORIGINS: "http://scout.backup.local:43120",
        },
        "hudson-mini",
        { webLocalName: "m1.scout.local" },
      ),
    ).toEqual({
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      publicOrigin: "https://scout.local",
      trustedHosts: [
        "m1.scout.local",
        "scout.local",
        "dev.scout.local",
        "hudson-mini.local",
        "scout.backup.local",
        "192.168.1.20",
      ],
      trustedOrigins: [
        "https://scout.local",
        "http://scout.backup.local:43120",
      ],
    });
  });

  test("uses configured web local name without changing the machine name", () => {
    expect(
      resolveOpenScoutWebApplicationServerIdentity(
        {},
        "Workstation-Mini.local",
        { webLocalName: "m1.scout.local" },
      ),
    ).toEqual({
      advertisedHost: "m1.scout.local",
      portalHost: "scout.local",
      publicOrigin: undefined,
      trustedHosts: ["m1.scout.local", "scout.local", "dev.scout.local", "workstation-mini.local"],
      trustedOrigins: [],
    });
  });

  test("uses environment web local name", () => {
    expect(
      resolveOpenScoutWebApplicationServerIdentity(
        { OPENSCOUT_WEB_LOCAL_NAME: "m1" },
        "Workstation-Mini.local",
      ).advertisedHost,
    ).toBe("m1.scout.local");
  });

  test("defaults node host from the machine hostname under scout.local", () => {
    expect(
      resolveOpenScoutWebApplicationServerIdentity(
        {},
        "Workstation-Mini.local",
        {},
      ),
    ).toMatchObject({
      advertisedHost: "workstation-mini.scout.local",
      portalHost: "scout.local",
      trustedHosts: ["workstation-mini.scout.local", "scout.local", "dev.scout.local", "workstation-mini.local"],
    });
  });

  test("trusts running Tailscale self hosts", () => {
    const { directory, filePath } = writeTailscaleFixture({
      BackendState: "Running",
      Self: {
        ID: "self-node",
        HostName: "m1",
        DNSName: "m1.tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.10"],
        Online: true,
        OS: "macOS",
      },
      CurrentTailnet: {
        Name: "example.tailnet",
        MagicDNSSuffix: "tailnet.ts.net",
      },
    });

    try {
      expect(
        resolveOpenScoutWebApplicationServerIdentity(
          { OPENSCOUT_TAILSCALE_STATUS_JSON: filePath },
          "M1.local",
          {},
        ),
      ).toMatchObject({
        trustedHosts: [
          "m1.scout.local",
          "scout.local",
          "dev.scout.local",
          "m1.local",
          "m1.tailnet.ts.net",
          "100.64.0.10",
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
