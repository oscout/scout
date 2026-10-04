import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChannelMemberSessionAuthority, CHANNEL_MEMBER_SESSION_TTL_MS as TTL,
  CHANNEL_MEMBER_ACTIVITY_WRITE_MS as THROTTLE, CHANNEL_BROWSER_ABSOLUTE_MS,
  CHANNEL_BROWSER_IDLE_MS, CHANNEL_BROWSER_ACTIVITY_WRITE_MS, channelMemberCookie,
} from "./channel-member-session.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const start = 1_800_000_000_000;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scout-member-renewal-")); homes.push(directory);
  const options = { signingSecret: "isolated-renewal-test", leaseDirectory: join(directory, "leases") };
  const authority = createChannelMemberSessionAuthority(options);
  const minted = authority.mint({ actorId: "apia-test", displayName: "Test", channelId: "room", participation: "api", nowMs: start });
  return { ...minted, authority, options, restart: () => createChannelMemberSessionAuthority(options),
    record: () => join(options.leaseDirectory, readdirSync(options.leaseDirectory)[0]!) };
}

test("API successful use slides 12h, validation alone does not", () => {
  const h = fixture();
  expect(h.authority.validate(h.token, start + 60_000)?.expiresAt).toBe(start + TTL);
  expect(h.authority.recordSuccessfulUse(h.token, start + 60_000)?.expiresAt).toBe(start + 60_000 + TTL);
  expect(h.authority.validate(h.token, start + TTL)?.expiresAt).toBe(start + 60_000 + TTL);
});
test("activity is throttled to one durable write per 60 seconds, including after restart", () => {
  const h = fixture();
  h.authority.recordSuccessfulUse(h.token, start + 1);
  const bytes = readFileSync(h.record(), "utf8"), inode = statSync(h.record()).ino;
  expect(h.authority.recordSuccessfulUse(h.token, start + THROTTLE)?.expiresAt).toBe(start + 1 + TTL);
  expect(h.restart().recordSuccessfulUse(h.token, start + THROTTLE)?.expiresAt).toBe(start + 1 + TTL);
  expect(readFileSync(h.record(), "utf8")).toBe(bytes);
  expect(statSync(h.record()).ino).toBe(inode); // Atomic replacement would change it.
  expect(h.restart().recordSuccessfulUse(h.token, start + THROTTLE + 1)?.expiresAt).toBe(start + THROTTLE + 1 + TTL);
});
test("renewal survives restart beyond the signed token's initial expiry", () => {
  const h = fixture();
  h.authority.recordSuccessfulUse(h.token, start + TTL - 1);
  const after = h.restart();
  expect(after.validate(h.token, start + TTL + 1)?.expiresAt).toBe(start + 2 * TTL - 1);
  expect(after.recordSuccessfulUse(h.token, start + TTL + THROTTLE)?.expiresAt).toBe(start + 2 * TTL + THROTTLE);
});
test("API lifetime has no added absolute cap", () => {
  const h = fixture();
  for (let day = 0; day < 20; day++) {
    const now = start + day * (TTL - THROTTLE);
    expect(h.restart().recordSuccessfulUse(h.token, now)?.expiresAt).toBe(now + TTL);
  }
});
test("revoked API credential never slides, including after restart", () => {
  const h = fixture();
  h.authority.recordSuccessfulUse(h.token, start + 1);
  h.authority.revoke(h.token);
  const bytes = readFileSync(h.record(), "utf8");
  expect(h.authority.recordSuccessfulUse(h.token, start + THROTTLE)).toBeNull();
  expect(h.restart().recordSuccessfulUse(h.token, start + THROTTLE)).toBeNull();
  expect(readFileSync(h.record(), "utf8")).toBe(bytes);
});
test("expired initial and renewed leases never resurrect at the exact boundary", () => {
  const h = fixture();
  expect(h.restart().recordSuccessfulUse(h.token, start + TTL)).toBeNull();
  const renewed = fixture();
  renewed.authority.recordSuccessfulUse(renewed.token, start + 1);
  expect(renewed.restart().validate(renewed.token, start + TTL + 1)).toBeNull();
  expect(renewed.restart().recordSuccessfulUse(renewed.token, start + TTL + 1)).toBeNull();
});
test("ledger is private, contains no bearer secret and corrupt data fails closed", () => {
  const h = fixture(); h.authority.recordSuccessfulUse(h.token, start);
  expect(statSync(h.options.leaseDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(h.record()).mode & 0o777).toBe(0o600);
  expect(readFileSync(h.record(), "utf8")).not.toContain(h.token);
  writeFileSync(h.record(), "{}");
  expect(h.restart().validate(h.token, start + 1)).toBeNull();
});
test("renewed scope stays signed; changed host secret still invalidates the token", () => {
  const h = fixture(); h.authority.recordSuccessfulUse(h.token, start);
  expect(createChannelMemberSessionAuthority({ ...h.options, signingSecret: "rotated" }).validate(h.token, start + 1)).toBeNull();
  const parts = h.token.split(".");
  const grant = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
  grant.channelIds.push("another-room");
  expect(h.restart().validate(`${Buffer.from(JSON.stringify(grant)).toString("base64url")}.${parts[1]}`, start + 1)).toBeNull();
});
test("browser sessions track idle activity but retain hosted's seven-day absolute cap", () => {
  const h = fixture();
  const browser = h.authority.mint({ actorId: "person-test", displayName: "Test", channelId: "room", nowMs: start });
  expect(browser.grant.expiresAt).toBe(start + CHANNEL_BROWSER_ABSOLUTE_MS);
  expect(channelMemberCookie(browser.token, false)).toContain(`Max-Age=${CHANNEL_BROWSER_ABSOLUTE_MS / 1000}`);
  h.authority.recordSuccessfulUse(browser.token, start);
  const lease = () => JSON.parse(readFileSync(h.record(), "utf8"));
  h.authority.recordSuccessfulUse(browser.token, start + CHANNEL_BROWSER_ACTIVITY_WRITE_MS - 1);
  expect(lease().lastSeenAt).toBe(start);
  h.authority.recordSuccessfulUse(browser.token, start + CHANNEL_BROWSER_ACTIVITY_WRITE_MS);
  expect(lease().lastSeenAt).toBe(start + CHANNEL_BROWSER_ACTIVITY_WRITE_MS);
  expect(h.restart().validate(browser.token, start + CHANNEL_BROWSER_IDLE_MS)).not.toBeNull();
  for (let halfDay = 1; halfDay < 14; halfDay++) {
    expect(h.authority.recordSuccessfulUse(browser.token, start + halfDay * CHANNEL_BROWSER_IDLE_MS / 2)?.expiresAt).toBe(start + CHANNEL_BROWSER_ABSOLUTE_MS);
  }
  expect(h.restart().recordSuccessfulUse(browser.token, start + CHANNEL_BROWSER_ABSOLUTE_MS)).toBeNull();
});
test("idle-expired browser sessions never resurrect", () => {
  const h = fixture();
  const browser = h.authority.mint({ actorId: "person-test", displayName: "Test", channelId: "room", nowMs: start });
  h.authority.recordSuccessfulUse(browser.token, start);
  expect(h.restart().recordSuccessfulUse(browser.token, start + CHANNEL_BROWSER_IDLE_MS)).toBeNull();
});


test("legacy browser cookies keep their signed cap rather than gaining an API lease", () => {
  const h = fixture();
  const payload = Buffer.from(JSON.stringify({ actorId: "person-old", displayName: "Old", channelIds: ["room"], expiresAt: start + TTL, nonce: "legacy" })).toString("base64url");
  const key = createHmac("sha256", h.options.signingSecret).update("openscout:channel-member-session:v1").digest();
  const token = `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  expect(h.authority.recordSuccessfulUse(token, start + THROTTLE)?.expiresAt).toBe(start + TTL);
  expect(h.restart().recordSuccessfulUse(token, start + TTL)).toBeNull();
});
