import { describe, expect, test } from "bun:test";

import { pairingWebLink, renderQRCode } from "./qr.ts";

const payload = {
  v: 1,
  relay: "ws://192.168.18.14:43131",
  fallbackRelays: ["ws://mac.tailnet.ts.net:43131"],
  room: "room-1",
  publicKey: "a".repeat(64),
  expiresAt: 1_780_958_228_426,
};

describe("pairing QR", () => {
  test("encodes the openscout.app pairing link with the payload intact", () => {
    const link = new URL(pairingWebLink(payload));
    expect(`${link.origin}${link.pathname}`).toBe("https://openscout.app/pair");
    expect(link.search).toBe("");
    expect(JSON.parse(new URLSearchParams(link.hash.slice(1)).get("payload")!)).toEqual(payload);
  });

  test("renders a terminal QR", () => {
    expect(renderQRCode(payload).length).toBeGreaterThan(0);
  });
});
