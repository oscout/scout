import { describe, expect, test } from "bun:test";

import {
  browseLanServices,
  browseLanServicesForPlatform,
  lanMdnsBrowseEnabled,
  lanScanEnabled,
  lookupOuiVendor,
  normalizeServiceAdvert,
  parseArpTable,
  parseDnsSdZoneDump,
  type LanMdnsAdvertisement,
  type LanMdnsResponder,
} from "./lan-scan.js";

describe("parseArpTable", () => {
  test("parses the BSD spelling, padding the octets it drops", () => {
    const neighbors = parseArpTable([
      "? (192.168.1.1) at 3c:22:fb:1:2:3 on en0 ifscope [ethernet]",
      "? (192.168.1.23) at a4:83:e7:aa:bb:cc on en0 ifscope [ethernet]",
    ].join("\n"));

    expect(neighbors).toEqual([
      { address: "192.168.1.1", macAddress: "3c:22:fb:01:02:03", interfaceName: "en0", vendor: "Apple" },
      { address: "192.168.1.23", macAddress: "a4:83:e7:aa:bb:cc", interfaceName: "en0", vendor: "Apple" },
    ]);
  });

  test("parses the Linux spelling", () => {
    const neighbors = parseArpTable("? (10.0.0.5) at b8:27:eb:11:22:33 [ether] on eth0");
    expect(neighbors).toEqual([
      { address: "10.0.0.5", macAddress: "b8:27:eb:11:22:33", interfaceName: "eth0", vendor: "Raspberry Pi" },
    ]);
  });

  test("drops rows that identify nothing", () => {
    const neighbors = parseArpTable([
      "? (192.168.1.99) at (incomplete) on en0",
      "? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]",
      "totally unrelated output",
    ].join("\n"));
    expect(neighbors).toEqual([]);
  });

  test("dedupes repeated rows for the same pair", () => {
    const neighbors = parseArpTable([
      "? (192.168.1.23) at a4:83:e7:aa:bb:cc on en0 ifscope [ethernet]",
      "? (192.168.1.23) at a4:83:e7:aa:bb:cc on en1 ifscope [ethernet]",
    ].join("\n"));
    expect(neighbors).toHaveLength(1);
  });

  test("keeps one MAC reachable at two addresses as two rows", () => {
    // Dual-stack or a second VLAN — both are real routes to the same machine,
    // and the grouping layer is what folds them together.
    const neighbors = parseArpTable([
      "? (192.168.1.23) at a4:83:e7:aa:bb:cc on en0 ifscope [ethernet]",
      "? (192.168.2.23) at a4:83:e7:aa:bb:cc on en0 ifscope [ethernet]",
    ].join("\n"));
    expect(neighbors.map((neighbor) => neighbor.address)).toEqual(["192.168.1.23", "192.168.2.23"]);
  });
});

describe("lookupOuiVendor", () => {
  test("labels known prefixes and admits ignorance otherwise", () => {
    expect(lookupOuiVendor("3C:22:FB:01:02:03")).toBe("Apple");
    expect(lookupOuiVendor("52:54:00:12:34:56")).toBe("QEMU/KVM");
    expect(lookupOuiVendor("aa:bb:cc:dd:ee:ff")).toBeNull();
    expect(lookupOuiVendor("nonsense")).toBeNull();
  });
});

describe("normalizeServiceAdvert", () => {
  test("coerces TXT values and drops link-local addresses", () => {
    const advert = normalizeServiceAdvert("_openscout._tcp", {
      name: "mini",
      host: "mini.local",
      port: 43117,
      addresses: ["192.168.1.23", "fe80::1", "192.168.1.23"],
      txt: { v: 1, kid: "abc", tls: true, raw: new Uint8Array([104, 105]) },
    });

    expect(advert.addresses).toEqual(["192.168.1.23"]);
    expect(advert.txt).toEqual({ v: "1", kid: "abc", tls: "true", raw: "hi" });
    expect(advert.port).toBe(43117);
  });
});

function stubResponder(
  answers: Record<string, LanMdnsAdvertisement[]>,
  onDestroy: () => void,
): LanMdnsResponder {
  return {
    find(options, onup) {
      const key = `_${options.type}._${options.protocol}`;
      for (const advertisement of answers[key] ?? []) onup?.(advertisement);
      return { stop() {} };
    },
    destroy(callback) {
      onDestroy();
      callback?.();
    },
  };
}

describe("parseDnsSdZoneDump", () => {
  // Verbatim from `dns-sd -Z _airplay._tcp local` on macOS 26.
  const dump = `Browsing for _airplay._tcp.local
DATE: ---Wed 09 Sep 2026---
18:24:48.641  ...STARTING...

; To direct clients to browse a different domain, substitute that domain in place of '@'
lb._dns-sd._udp                                 PTR     @

_airplay._tcp                                   PTR     Arts\\032Mini._airplay._tcp
Arts\\032Mini._airplay._tcp                      SRV     0 0 7000 arts-mini-2.local. ; Replace with unicast FQDN of target host
Arts\\032Mini._airplay._tcp                      TXT     "model=Mac16,10" "deviceid=96:D4:4B:F4:98:B0" "flags=0x204"

_airplay._tcp                                   PTR     air._airplay._tcp
air._airplay._tcp                               SRV     0 0 7000 air.local. ; Replace with unicast FQDN of target host
air._airplay._tcp                               TXT     "model=Mac14,2"
`;

  test("reads instance, host and port out of the SRV records", () => {
    const adverts = parseDnsSdZoneDump(dump, "_airplay._tcp");

    expect(adverts).toHaveLength(2);
    expect(adverts[0]).toMatchObject({
      serviceType: "_airplay._tcp",
      // `\032` is dns-sd's escape for a space.
      instanceName: "Arts Mini",
      host: "arts-mini-2.local",
      port: 7000,
    });
    expect(adverts[0]!.txt).toMatchObject({ model: "Mac16,10", flags: "0x204" });
    expect(adverts[1]).toMatchObject({ instanceName: "air", host: "air.local" });
  });

  test("ignores PTR rows and the human preamble", () => {
    expect(parseDnsSdZoneDump(dump, "_airplay._tcp").map((a) => a.instanceName))
      .not.toContain("lb._dns-sd._udp");
  });

  test("a browse that answered nothing is empty, not an error", () => {
    expect(parseDnsSdZoneDump("Browsing for _ssh._tcp.local\n", "_ssh._tcp")).toEqual([]);
  });
});

describe("browseLanServicesForPlatform", () => {
  test("uses the injected responder even on darwin, so tests never shell out", async () => {
    let used = false;
    const responder = {
      find: () => {
        used = true;
        return { stop() {} };
      },
      destroy: (callback?: () => void) => callback?.(),
    };

    await browseLanServicesForPlatform("darwin", {
      browseMs: 1,
      serviceTypes: ["_ssh._tcp"],
      responderFactory: () => responder,
    });

    expect(used).toBe(true);
  });
});

describe("browseLanServices", () => {
  test("collects one advert per instance and always destroys the responder", async () => {
    let destroyed = 0;
    const services = await browseLanServices({
      serviceTypes: ["_openscout._tcp", "_ssh._tcp"],
      browseMs: 1,
      responderFactory: () => stubResponder({
        "_openscout._tcp": [{ name: "mini", host: "mini.local", port: 43117, addresses: ["192.168.1.23"] }],
        "_ssh._tcp": [{ name: "studio", host: "studio.local", port: 22, addresses: ["192.168.1.40"] }],
      }, () => { destroyed += 1; }),
    });

    expect(services.map((service) => service.instanceName)).toEqual(["mini", "studio"]);
    expect(destroyed).toBe(1);
  });

  test("keeps the answer that resolved more addresses", async () => {
    const services = await browseLanServices({
      serviceTypes: ["_openscout._tcp"],
      browseMs: 1,
      responderFactory: () => stubResponder({
        "_openscout._tcp": [
          { name: "mini", host: "mini.local", addresses: [] },
          { name: "mini", host: "mini.local", addresses: ["192.168.1.23", "100.101.102.103"] },
        ],
      }, () => {}),
    });

    expect(services).toHaveLength(1);
    expect(services[0]!.addresses).toEqual(["192.168.1.23", "100.101.102.103"]);
  });

  test("ignores a service type it cannot parse", async () => {
    const services = await browseLanServices({
      serviceTypes: ["not-a-service-type"],
      browseMs: 1,
      responderFactory: () => stubResponder({}, () => {}),
    });
    expect(services).toEqual([]);
  });

  test("an aborted scan still returns what it had and tears down", async () => {
    let destroyed = 0;
    const controller = new AbortController();
    const pending = browseLanServices({
      serviceTypes: ["_openscout._tcp"],
      browseMs: 60_000,
      signal: controller.signal,
      responderFactory: () => stubResponder({
        "_openscout._tcp": [{ name: "mini", addresses: ["192.168.1.23"] }],
      }, () => { destroyed += 1; }),
    });

    controller.abort();
    expect((await pending).map((service) => service.instanceName)).toEqual(["mini"]);
    expect(destroyed).toBe(1);
  });
});

describe("toggles", () => {
  test("read their env switches", () => {
    expect(lanScanEnabled({})).toBe(true);
    expect(lanScanEnabled({ OPENSCOUT_LAN_SCAN_ENABLED: "0" })).toBe(false);
    expect(lanScanEnabled({ OPENSCOUT_LAN_SCAN_ENABLED: "off" })).toBe(false);
    expect(lanMdnsBrowseEnabled({ OPENSCOUT_MDNS_ENABLED: "false" })).toBe(false);
    expect(lanMdnsBrowseEnabled({})).toBe(true);
  });
});
