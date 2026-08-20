import { describe, expect, test } from "bun:test";
import { acceptedSendLabel, reconcileAuthoritativeMessages } from "./chat-runtime.ts";
import {
  CHAT_ATTACHMENT_FETCH_METHOD,
  HostedVoiceSource,
  createNativeAttachmentFetcher,
  resolveVoicePlaybackSource,
  type HostedVoiceSourceDependencies,
} from "./voice-note-source.ts";

const attachment = {
  id: "att-persisted",
  mediaType: "audio/mp4",
  url: "http://127.0.0.1:43132/attachments/att-persisted",
};

function hostedSource() {
  const source = resolveVoicePlaybackSource(attachment);
  if (source.kind !== "hosted") throw new Error("expected hosted source");
  return source;
}

function testDependencies(
  fetchAttachment: HostedVoiceSourceDependencies["fetchAttachment"],
  events: string[] = [],
): HostedVoiceSourceDependencies {
  return {
    fetchAttachment,
    createObjectURL(bytes, mediaType) {
      events.push(`create:${mediaType}:${new TextDecoder().decode(bytes)}`);
      return `blob:test-${events.length}`;
    },
    revokeObjectURL(url) {
      events.push(`revoke:${url}`);
    },
  };
}

describe("chat voice attachment delivery", () => {
  test("accepted sends retain an honest broker receipt", () => {
    expect(acceptedSendLabel({ ok: true, messageId: "msg-1" })).toBe("Posted");
    expect(acceptedSendLabel({ ok: true, flightId: "flt-1" })).toBe("Dispatching");
    expect(acceptedSendLabel({ ok: true, delivery: { state: "recoverable" } })).toBe("Needs attention");
  });

  test("refresh replaces an accepted optimistic voice note with its persisted attachment", () => {
    const optimistic = {
      id: "ios-chat-1",
      clientMessageId: "ios-chat-1",
      optimistic: true,
      attachments: [{ ...attachment }],
    };
    const persisted = {
      id: "msg-1",
      clientMessageId: "ios-chat-1",
      attachments: [{ ...attachment }],
    };
    const unrelatedPending = {
      id: "ios-chat-2",
      clientMessageId: "ios-chat-2",
      optimistic: true,
      attachments: [],
    };

    expect(reconcileAuthoritativeMessages([optimistic, unrelatedPending], [persisted])).toEqual([
      persisted,
      unrelatedPending,
    ]);
    expect(resolveVoicePlaybackSource(persisted.attachments[0]!)).toEqual({
      kind: "hosted",
      id: "att-persisted",
      mediaType: "audio/mp4",
    });
  });

  test("persisted playback never follows the Mac loopback URL or preloads bytes", async () => {
    let fetchCount = 0;
    const source = hostedSource();
    const loader = new HostedVoiceSource(source, testDependencies(async (id) => {
      fetchCount += 1;
      return { id, data: btoa("voice") };
    }));

    expect(source).not.toHaveProperty("url");
    expect(fetchCount).toBe(0);
    await loader.load();
    expect(fetchCount).toBe(1);
  });

  test("the native fetch uses the opaque attachment id", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const fetchAttachment = createNativeAttachmentFetcher(async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { id: params.id, data: btoa("voice") } as T;
    });

    await fetchAttachment("att-persisted");
    expect(calls).toEqual([{
      method: CHAT_ATTACHMENT_FETCH_METHOD,
      params: { id: "att-persisted" },
    }]);
  });

  test("a failed fetch can be retried without retaining a broken source", async () => {
    let attempt = 0;
    const loader = new HostedVoiceSource(hostedSource(), testDependencies(async (id) => {
      attempt += 1;
      if (attempt === 1) throw new Error("bridge offline");
      return { id, data: btoa("retry worked") };
    }));

    await expect(loader.load()).rejects.toThrow("bridge offline");
    expect(loader.objectURL).toBeNull();
    await expect(loader.load()).resolves.toMatch(/^blob:test-/);
    expect(attempt).toBe(2);
  });

  test("reset and disposal revoke blob URLs exactly once", async () => {
    const events: string[] = [];
    const loader = new HostedVoiceSource(hostedSource(), testDependencies(
      async (id) => ({ id, data: btoa("voice") }),
      events,
    ));

    const first = await loader.load();
    loader.reset();
    loader.dispose();
    loader.dispose();
    expect(events.filter((event) => event === `revoke:${first}`)).toHaveLength(1);
  });

  test("unmount invalidates an in-flight fetch and revokes its late blob", async () => {
    const events: string[] = [];
    let finish: ((value: { id: string; data: string }) => void) | undefined;
    const loader = new HostedVoiceSource(hostedSource(), testDependencies(
      (id) => new Promise((resolve) => { finish = (value) => resolve({ ...value, id }); }),
      events,
    ));

    const loading = loader.load();
    loader.dispose();
    finish?.({ id: "ignored", data: btoa("late") });
    await expect(loading).rejects.toThrow("cancelled");
    expect(events.some((event) => event.startsWith("revoke:blob:"))).toBe(true);
  });
});
