import { describe, expect, it } from "bun:test";
import {
  authorizedMobileTerminalSessionName,
  InvalidMobileTerminalSessionError,
  mobileTerminalSessionName,
  provisionedMobileTerminalSessionName,
  validatedMobileTerminalSessionName,
} from "./mobile-terminal-session.ts";

const publicKey = "ecdsa-sha2-nistp256 AAAATEST scout-ios";

describe("mobileTerminalSessionName", () => {
  it("keeps one stable, readable workspace per app installation", () => {
    expect(mobileTerminalSessionName(publicKey, "ipad")).toBe("scout-ipad-2d4d3f12");
    expect(mobileTerminalSessionName(`  ${publicKey}\n`, "ipad")).toBe("scout-ipad-2d4d3f12");
  });

  it("separates simulator and physical-device namespaces", () => {
    expect(mobileTerminalSessionName(publicKey, "ipad-sim")).toBe("scout-ipad-sim-2d4d3f12");
    expect(mobileTerminalSessionName(publicKey, "ipad-sim"))
      .not.toBe(mobileTerminalSessionName(publicKey, "ipad"));
  });

  it("falls back to a safe generic class", () => {
    expect(mobileTerminalSessionName(publicKey, "iPad Pro; rm -rf")).toBe("scout-ios-2d4d3f12");
  });

  it("keeps legacy clients on the workspace they actually attach", () => {
    expect(provisionedMobileTerminalSessionName(publicKey, undefined)).toBe("scout");
    expect(provisionedMobileTerminalSessionName(publicKey, "iphone"))
      .toBe("scout-iphone-2d4d3f12");
  });

  it("rejects session names outside the generated namespace", () => {
    expect(validatedMobileTerminalSessionName("scout-ipad-2d4d3f12")).toBe("scout-ipad-2d4d3f12");
    expect(validatedMobileTerminalSessionName(undefined)).toBe("scout");
    expect(() => validatedMobileTerminalSessionName("scout; touch /tmp/nope")).toThrow();
  });

  it("binds status reads to the paired device's provisioned workspace", () => {
    expect(authorizedMobileTerminalSessionName(
      "scout-ipad-2d4d3f12",
      "scout-ipad-2d4d3f12",
    )).toBe("scout-ipad-2d4d3f12");
    expect(authorizedMobileTerminalSessionName(undefined, undefined)).toBe("scout");
    expect(() => authorizedMobileTerminalSessionName(
      "scout-iphone-2d4d3f12",
      "scout-ipad-2d4d3f12",
    )).toThrow(InvalidMobileTerminalSessionError);
  });
});
