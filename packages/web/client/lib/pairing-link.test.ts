import { describe, expect, test } from "bun:test";

import { pairingDeepLink, pairingDeepLinks, pairingWebLink } from "../../shared/pairing-link.js";

describe("pairingDeepLink", () => {
  test("uses the iOS Scout URL scheme for pairing payloads", () => {
    const qrValue = JSON.stringify({
      v: 1,
      relay: "ws://mac.tailnet.ts.net:43131",
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    });

    expect(pairingDeepLink(qrValue)).toBe(`scout://pair?payload=${encodeURIComponent(qrValue)}`);
  });

  test("does not create an empty pairing link", () => {
    expect(pairingDeepLink("   ")).toBeNull();
    expect(pairingDeepLink(null)).toBeNull();
  });

  test("creates LAN-first and Tailscale-first links from one payload", () => {
    const qrValue = JSON.stringify({
      v: 1,
      relay: "ws://192.168.18.14:43131",
      fallbackRelays: ["ws://mac.tailnet.ts.net:43131"],
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    });

    const links = pairingDeepLinks(qrValue);
    const lanPayload = {
      v: 1,
      relay: "ws://192.168.18.14:43131",
      fallbackRelays: ["ws://mac.tailnet.ts.net:43131"],
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    };
    const tailnetPayload = {
      v: 1,
      relay: "ws://mac.tailnet.ts.net:43131",
      fallbackRelays: ["ws://192.168.18.14:43131"],
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    };

    expect(links.default).toBe(`scout://pair?payload=${encodeURIComponent(qrValue)}`);
    expect(links.lan).toBe(`scout://pair?payload=${encodeURIComponent(JSON.stringify(lanPayload))}`);
    expect(links.tailnet).toBe(`scout://pair?payload=${encodeURIComponent(JSON.stringify(tailnetPayload))}`);
  });

  test("recognizes Tailscale CGNAT relay URLs", () => {
    const qrValue = JSON.stringify({
      v: 1,
      relay: "ws://100.123.16.74:43131",
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    });

    expect(pairingDeepLinks(qrValue).tailnet).toBe(`scout://pair?payload=${encodeURIComponent(qrValue)}`);
  });
});

describe("pairingWebLink", () => {
  test("puts the payload on the openscout.app pairing link the QR encodes", () => {
    const qrValue = JSON.stringify({
      v: 1,
      relay: "ws://mac.tailnet.ts.net:43131",
      room: "room-1",
      publicKey: "a".repeat(64),
      expiresAt: 1_780_958_228_426,
    });

    const link = pairingWebLink(qrValue);
    expect(link).toBe(`https://openscout.app/pair#payload=${encodeURIComponent(qrValue)}`);
    expect(new URLSearchParams(new URL(link!).hash.slice(1)).get("payload")).toBe(qrValue);
  });

  test("does not create an empty pairing link", () => {
    expect(pairingWebLink("  ")).toBeNull();
    expect(pairingWebLink(undefined)).toBeNull();
  });
});
