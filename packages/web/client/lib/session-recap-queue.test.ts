import { describe, expect, test } from "bun:test";

import { setScoutLiveVoiceActive } from "./scout-audio-owners.ts";
import type { RecapTarget } from "./session-recap-identity.ts";
import {
  getRecapQueueSnapshot,
  startSessionRecaps,
  stopSessionRecaps,
} from "./session-recap-queue.ts";
import type { ScoutSpeechCatalog, ScoutSpeechHandle } from "./scout-voice.ts";

const catalog: ScoutSpeechCatalog = {
  defaultModelId: "system",
  models: [{ id: "system", name: "System", provider: "system", available: true }],
  voices: [
    { id: "v1", name: "One", provider: "system", modelId: "system", available: true, isDefault: true },
  ],
  source: "fallback",
};

function target(id: string): RecapTarget {
  return {
    sessionRef: id,
    harness: "claude",
    voiceKey: id,
    displayLabel: id,
    identityVerified: true,
    sourceExact: `claude · ${id.slice(0, 8)}`,
    observedAt: 1_000,
    reportedState: "working",
    nodeId: "mini",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("session recap queue", () => {
  test("plays recaps sequentially and stop cancels generation and remaining items", async () => {
    const first = deferred<void>();
    const order: string[] = [];
    const started = deferred<void>();
    const run = startSessionRecaps([target("one"), target("two")], {
      catalog,
      modelId: "system",
      requireConsent: false,
      fetchRecap: async (item) => ({
        sessionRef: item.sessionRef,
        harness: item.harness,
        observedAt: 1,
        summary: `update ${item.sessionRef}`,
        status: "ready",
      }),
      speak: (text) => {
        order.push(text);
        if (order.length === 1) started.resolve();
        return {
          promise: first.promise.then(() => ({
            contentType: "audio/wav",
            audioBase64: "",
            modelId: "system",
            voiceId: "v1",
            audioBytes: 0,
          })),
          stop: () => first.resolve(),
        } satisfies ScoutSpeechHandle;
      },
    });
    await started.promise;
    expect(getRecapQueueSnapshot().running).toBe(true);
    expect(getRecapQueueSnapshot().speaker).toBe("one");
    stopSessionRecaps();
    await run;
    expect(getRecapQueueSnapshot().running).toBe(false);
    expect(getRecapQueueSnapshot().items.some((item) => item.target.sessionRef === "two" && item.status === "skipped")).toBe(true);
    expect(order).toHaveLength(1);
  });

  test("reinvoking while running stops instead of overlapping", async () => {
    const hold = deferred<void>();
    const run = startSessionRecaps([target("one")], {
      catalog,
      modelId: "system",
      requireConsent: false,
      fetchRecap: async () => {
        await hold.promise;
        return { sessionRef: "one", harness: "claude", observedAt: 1, summary: "hi", status: "ready" };
      },
      speak: () => ({ promise: hold.promise.then(() => ({
        contentType: "audio/wav", audioBase64: "", modelId: "system", voiceId: "v1", audioBytes: 0,
      })), stop: () => hold.resolve() }),
    });
    await Promise.resolve();
    expect(getRecapQueueSnapshot().running).toBe(true);
    await startSessionRecaps([target("one")], { catalog, modelId: "system", requireConsent: false });
    expect(getRecapQueueSnapshot().running).toBe(false);
    hold.resolve();
    await run;
  });

  test("refuses when live voice owns audio", async () => {
    setScoutLiveVoiceActive(true);
    await startSessionRecaps([target("one")], { catalog, modelId: "system", requireConsent: false });
    expect(getRecapQueueSnapshot().notice).toBe("Live voice is active.");
    expect(getRecapQueueSnapshot().running).toBe(false);
    setScoutLiveVoiceActive(false);
  });

  test("a provider failure does not strand the queue", async () => {
    await startSessionRecaps([target("one"), target("two")], {
      catalog,
      modelId: "system",
      requireConsent: false,
      fetchRecap: async (item) => {
        if (item.sessionRef === "one") throw new Error("provider down");
        return { sessionRef: item.sessionRef, harness: "claude", observedAt: 1, summary: "ok", status: "ready" };
      },
      speak: () => ({
        promise: Promise.resolve({
          contentType: "audio/wav", audioBase64: "", modelId: "system", voiceId: "v1", audioBytes: 0,
        }),
        stop: () => undefined,
      }),
    });
    const items = getRecapQueueSnapshot().items;
    expect(items[0]?.status).toBe("failed");
    expect(items[1]?.status).toBe("done");
    expect(getRecapQueueSnapshot().running).toBe(false);
  });
});

test("stop cancels pending catalog setup and reinvoking cannot start a second queue", async () => {
  stopSessionRecaps();
  const pending = deferred<ScoutSpeechCatalog>();
  let fetched = 0;
  const run = startSessionRecaps([target("pending")], {
    fetchCatalog: () => pending.promise,
    requireConsent: false,
    fetchRecap: async () => { fetched++; throw new Error("must not run"); },
  });
  expect(getRecapQueueSnapshot().running).toBe(true);
  await startSessionRecaps([target("second")], { catalog, requireConsent: false });
  expect(getRecapQueueSnapshot().running).toBe(false);
  pending.resolve(catalog);
  await run;
  expect(fetched).toBe(0);
  expect(getRecapQueueSnapshot().running).toBe(false);
});

test("catalog failure is displayed and releases queue ownership", async () => {
  await startSessionRecaps([target("broken")], {
    fetchCatalog: async () => { throw new Error("catalog offline"); },
  });
  expect(getRecapQueueSnapshot().running).toBe(false);
  expect(getRecapQueueSnapshot().notice).toBe("catalog offline");
});
