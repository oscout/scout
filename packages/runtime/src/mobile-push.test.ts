import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  broadcastApnsAlertToActiveMobileDevices,
  closeMobilePushDb,
  listActiveMobilePushRegistrations,
  listMobilePushRegistrations,
  syncMobilePushRegistration,
} from "./mobile-push.ts";
import { SQLiteControlPlaneStore } from "./sqlite-store.ts";

const tempRoots = new Set<string>();
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalFetch = globalThis.fetch;
const originalRelayUrl = process.env.OPENSCOUT_PUSH_RELAY_URL;
const originalRelaySession = process.env.OPENSCOUT_PUSH_RELAY_SESSION;
const originalRelayMeshId = process.env.OPENSCOUT_PUSH_RELAY_MESH_ID;

afterEach(() => {
  closeMobilePushDb();
  globalThis.fetch = originalFetch;
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  for (const [key, value] of [
    ["OPENSCOUT_PUSH_RELAY_URL", originalRelayUrl],
    ["OPENSCOUT_PUSH_RELAY_SESSION", originalRelaySession],
    ["OPENSCOUT_PUSH_RELAY_MESH_ID", originalRelayMeshId],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createControlPlaneRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-mobile-push-"));
  tempRoots.add(root);
  process.env.OPENSCOUT_CONTROL_HOME = root;
  const store = new SQLiteControlPlaneStore(join(root, "control-plane.sqlite"));
  store.close();
  return root;
}

describe("mobile push registrations", () => {
  test("upserts and updates the active registration for a device/environment", () => {
    createControlPlaneRoot();

    const first = syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "AA BB CC 11",
      appVersion: "0.2.5",
      buildNumber: "12",
    });
    expect(first.registered).toBe(true);

    let rows = listMobilePushRegistrations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pushToken).toBe("aabbcc11");
    expect(rows[0]?.appVersion).toBe("0.2.5");

    const second = syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "ddeeff22",
      appVersion: "0.2.6",
      buildNumber: "13",
    });
    expect(second.registered).toBe(true);

    rows = listMobilePushRegistrations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pushToken).toBe("ddeeff22");
    expect(rows[0]?.appVersion).toBe("0.2.6");
    expect(listActiveMobilePushRegistrations()).toHaveLength(1);
  });

  test("removes a registration when notification authorization is revoked", () => {
    createControlPlaneRoot();

    syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "deadbeef",
    });
    expect(listActiveMobilePushRegistrations()).toHaveLength(1);

    const result = syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "denied",
      pushToken: null,
    });

    expect(result.removed).toBe(true);
    expect(listMobilePushRegistrations()).toHaveLength(0);
    expect(listActiveMobilePushRegistrations()).toHaveLength(0);
  });

  test("reassigns an existing token to the latest device registration", () => {
    createControlPlaneRoot();

    syncMobilePushRegistration({
      deviceId: "device-1",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "cafebabe",
    });

    const result = syncMobilePushRegistration({
      deviceId: "device-2",
      platform: "ios",
      appBundleId: "app.openscout.scout",
      apnsEnvironment: "development",
      authorizationStatus: "authorized",
      pushToken: "cafebabe",
    });

    expect(result.registered).toBe(true);

    const rows = listMobilePushRegistrations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe("device-2");
    expect(rows[0]?.pushToken).toBe("cafebabe");
  });
});

describe("mobile push relay", () => {
  test("preserves quiet operator-signal correlation without forwarding content", async () => {
    process.env.OPENSCOUT_PUSH_RELAY_URL = "https://push.example.test";
    process.env.OPENSCOUT_PUSH_RELAY_SESSION = "osn_session_test";
    process.env.OPENSCOUT_PUSH_RELAY_MESH_ID = "mesh-1";
    let requestUrl = "";
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        attemptedCount: 1,
        deliveredCount: 1,
        failedCount: 0,
        failures: [],
      });
    }) as typeof fetch;

    const result = await broadcastApnsAlertToActiveMobileDevices({
      title: "Agent update",
      body: "This content must not leave the broker.",
      sound: null,
      urgency: "silent",
      payload: {
        destination: "inbox",
        kind: "operator_signal",
        signalKind: "notify",
        messageId: "msg-1",
        conversationId: "dm.agent.operator",
        requesterId: "human-readable-agent-name",
      },
    });

    expect(result.deliveredCount).toBe(1);
    expect(requestUrl).toBe("https://push.example.test/v1/push");
    expect(requestBody).toEqual({
      meshId: "mesh-1",
      itemId: "msg-1",
      kind: "operator_signal",
      urgency: "silent",
      payload: {
        destination: "inbox",
        kind: "operator_signal",
        signalKind: "notify",
        messageId: "msg-1",
        conversationId: "dm.agent.operator",
        itemId: "msg-1",
      },
    });
    expect(JSON.stringify(requestBody)).not.toContain("This content");
    expect(JSON.stringify(requestBody)).not.toContain("human-readable-agent-name");
  });
});
