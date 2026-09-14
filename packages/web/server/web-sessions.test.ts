import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { createScoutWebSessionStore, SCOUT_WEB_SESSION_STORE_MAX_BYTES } from "./web-sessions.ts";

const testDirectories = new Set<string>();

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-web-sessions-"));
  testDirectories.add(directory);
  return join(directory, "web-sessions.json");
}

afterEach(() => {
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

describe("createScoutWebSessionStore", () => {
  test("mints tokens that validate and rejects unknown tokens", () => {
    const store = createScoutWebSessionStore({ path: null });
    const token = store.mint({ label: "front-door" });

    expect(token.startsWith("sws_")).toBe(true);
    expect(store.validate(token)).toBe(true);
    expect(store.validate("sws_unknown")).toBe(false);
    expect(store.validate("not-a-session")).toBe(false);
  });

  test("sessions expire", () => {
    let clock = 1_000;
    const store = createScoutWebSessionStore({ path: null, ttlMs: 500, now: () => clock });
    const token = store.mint();

    expect(store.validate(token)).toBe(true);
    clock += 501;
    expect(store.validate(token)).toBe(false);
  });

  test("revoked sessions stop validating", () => {
    const store = createScoutWebSessionStore({ path: null });
    const token = store.mint();
    store.revoke(token);

    expect(store.validate(token)).toBe(false);
  });

  test("persists hashed sessions across store instances", () => {
    const path = storePath();
    const first = createScoutWebSessionStore({ path });
    const token = first.mint({ label: "login" });

    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain(token);
    expect(persisted).toContain("login");

    const second = createScoutWebSessionStore({ path });
    expect(second.validate(token)).toBe(true);

    second.revoke(token);
    const third = createScoutWebSessionStore({ path });
    expect(third.validate(token)).toBe(false);
  });

  test("tolerates a corrupt store file", () => {
    const path = storePath();
    writeFileSync(path, "{not json", "utf8");

    const store = createScoutWebSessionStore({ path });
    const token = store.mint();
    expect(store.validate(token)).toBe(true);
  });

  test("caps stored sessions by evicting the oldest", () => {
    let clock = 0;
    const store = createScoutWebSessionStore({
      path: null,
      maxSessions: 2,
      now: () => ++clock,
    });

    const first = store.mint();
    const second = store.mint();
    const third = store.mint();

    expect(store.size()).toBe(2);
    expect(store.validate(first)).toBe(false);
    expect(store.validate(second)).toBe(true);
    expect(store.validate(third)).toBe(true);
  });
  test("failed revoke is reported and cannot pretend to succeed before restart", () => {
    const path = storePath();
    const store = createScoutWebSessionStore({ path });
    const token = store.mint();
    const persisted = readFileSync(path, "utf8");
    mkdirSync(`${path}.tmp`);
    expect(() => store.revoke(token)).toThrow();
    expect(store.validate(token)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(persisted);
    expect(createScoutWebSessionStore({ path }).validate(token)).toBe(true);
    rmSync(`${path}.tmp`, { recursive: true });
    store.revoke(token);
    expect(store.validate(token)).toBe(false);
    expect(createScoutWebSessionStore({ path }).validate(token)).toBe(false);
  });

  test("failed mint does not publish a session or evict a persisted session", () => {
    const path = storePath();
    const store = createScoutWebSessionStore({ path, maxSessions: 1 });
    const token = store.mint();
    const persisted = readFileSync(path, "utf8");
    mkdirSync(`${path}.tmp`);
    expect(() => store.mint()).toThrow();
    expect(store.size()).toBe(1);
    expect(store.validate(token)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(persisted);
    expect(createScoutWebSessionStore({ path }).validate(token)).toBe(true);
  });

  test("startup enforces expiry and capacity before any mint or size call", () => {
    const path = storePath();
    const records = ["sws_expired", "sws_old", "sws_new"].map((token, index) => ({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdAt: index, expiresAt: index === 0 ? 50 : 200,
    }));
    writeFileSync(path, JSON.stringify({ version: 1, sessions: records }));
    const store = createScoutWebSessionStore({ path, maxSessions: 1, now: () => 100 });
    expect(store.validate("sws_expired")).toBe(false);
    expect(store.validate("sws_old")).toBe(false);
    expect(store.validate("sws_new")).toBe(true);
  });

  test("oversized files and unsupported versions grant no sessions", () => {
    const path = storePath();
    const token = "sws_fixture";
    const record = { tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: 1, expiresAt: 200 };
    writeFileSync(path, JSON.stringify({ version: 1, sessions: [record], padding: " ".repeat(SCOUT_WEB_SESSION_STORE_MAX_BYTES) }));
    expect(createScoutWebSessionStore({ path, now: () => 100 }).validate(token)).toBe(false);
    writeFileSync(path, JSON.stringify({ version: 2, sessions: [record] }));
    expect(createScoutWebSessionStore({ path, now: () => 100 }).validate(token)).toBe(false);
  });

  test("invalid persisted records cannot grant sessions or defeat eviction order", () => {
    const path = storePath();
    const token = "sws_fixture";
    const record = { tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: 1, expiresAt: 200 };
    for (const invalid of [
      { ...record, createdAt: "old" }, { ...record, expiresAt: 0 },
      { ...record, label: "x".repeat(257) }, { ...record, tokenHash: "not-a-hash" },
    ]) {
      writeFileSync(path, JSON.stringify({ version: 1, sessions: [invalid] }));
      expect(createScoutWebSessionStore({ path, now: () => 100 }).validate(token)).toBe(false);
    }
  });

});
