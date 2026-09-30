import { describe, expect, test } from "bun:test";
import { createAmbientVoiceController, type AmbientVoiceDeps } from "./ambient-voice-controller.ts";

function harness(overrides: Partial<AmbientVoiceDeps> = {}) {
  let clock = 1_000_000;
  let nextSession = 1;
  const timers: Array<() => void> = [];
  const log = {
    started: [] as string[],
    cancelled: [] as string[],
    prompts: [] as string[],
    spoken: [] as string[],
    asks: [] as unknown[],
  };
  const state = { micBusy: false, hostSpeaking: false, reply: "Done." };
  const controller = createAmbientVoiceController({
    startSession: () => {
      const sessionId = `ambient-${nextSession++}`;
      log.started.push(sessionId);
      return { sessionId };
    },
    cancelSession: (id) => log.cancelled.push(id),
    micBusy: () => state.micBusy,
    hostSpeaking: () => state.hostSpeaking,
    respond: async (body) => {
      log.prompts.push(body);
      return state.reply;
    },
    speak: async (text) => {
      log.spoken.push(text);
    },
    askAgent: async (ask) => {
      log.asks.push(ask);
    },
    now: () => clock,
    setTimer: (fn) => {
      timers.push(fn);
      return { cancel: () => undefined };
    },
    ...overrides,
  });
  const say = (text: string, advanceMs = 3_000) => {
    clock += advanceMs;
    controller.listener({
      sessionId: log.started[log.started.length - 1]!,
      event: "session.segment",
      data: { text, at: clock },
    });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const runTimers = () => timers.splice(0).forEach((fn) => fn());
  return { controller, log, state, say, settle, runTimers, advance: (ms: number) => { clock += ms; } };
}

describe("always-on voice controller", () => {
  test("ordinary speech stays in the buffer; a submit sends only the excerpt and speaks the reply", async () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.say("thinking about lunch");
    h.say("the flaky test lives in the routes folder", 60_000);
    h.say("file a ticket for it. Okay Scout, send it.");
    await h.settle();

    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.prompts[0]).toContain("\"the flaky test lives in the routes folder file a ticket for it.\"");
    expect(h.log.prompts[0]).not.toContain("lunch");
    expect(h.log.spoken).toEqual(["Done."]);
    expect(h.controller.snapshot()).toMatchObject({
      status: "listening",
      lastSubmit: { reason: "pause", reply: "Done." },
    });
  });

  test("a page action goes to open pages, and only the first claim runs it", async () => {
    const h = harness();
    h.state.reply = "Taking you home.\n```scout-ui\n{\"type\":\"navigate\",\"route\":{\"view\":\"inbox\"}}\n```";
    const batches: Array<{ id: string; actions: unknown[] }> = [];
    h.controller.subscribePageActions((batch) => batches.push(batch));
    h.controller.setEnabled(true);
    h.say("take me to the homepage. Okay Scout, do it.");
    await h.settle();

    expect(batches).toHaveLength(1);
    expect(batches[0]!.actions).toEqual([{ type: "navigate", route: { view: "inbox" } }]);
    expect(h.log.spoken).toEqual(["Taking you home."]);
    expect(h.controller.claimPageActions(batches[0]!.id)).toBe(true);
    expect(h.controller.claimPageActions(batches[0]!.id)).toBe(false);
    expect(h.controller.claimPageActions("ambient-unknown")).toBe(false);
  });

  test("an agent ask in the reply is sent through the broker and not spoken", async () => {
    const h = harness();
    h.state.reply = "Asking the web agent.\n```scout-ui\n{\"type\":\"ask-agent\",\"targetLabel\":\"web\",\"body\":\"fix the flaky test\"}\n```";
    h.controller.setEnabled(true);
    h.say("tell the web agent to fix the flaky test, Scout, go");
    await h.settle();
    expect(h.log.asks).toEqual([{ targetLabel: "web", body: "fix the flaky test" }]);
    expect(h.log.spoken).toEqual(["Asking the web agent."]);
  });

  test("speech heard while the Mac is speaking is dropped", async () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.state.hostSpeaking = true;
    h.say("this is the reply being played back, Scout, go");
    await h.settle();
    expect(h.log.prompts).toHaveLength(0);
    expect(h.controller.snapshot().buffer.segmentCount).toBe(0);
  });

  test("waits for push-to-talk, restarts after the Mac drops the session, and forgets everything when turned off", () => {
    const h = harness();
    h.state.micBusy = true;
    h.controller.setEnabled(true);
    expect(h.log.started).toHaveLength(0);
    expect(h.controller.snapshot().status).toBe("waiting");

    h.state.micBusy = false;
    h.runTimers();
    expect(h.log.started).toEqual(["ambient-1"]);

    h.say("something worth keeping");
    h.controller.listener({ sessionId: "ambient-1", event: "session.cancelled", data: { reason: "superseded" } });
    expect(h.controller.snapshot().status).toBe("waiting");
    h.runTimers();
    expect(h.log.started).toEqual(["ambient-1", "ambient-2"]);

    h.controller.setEnabled(false);
    expect(h.log.cancelled).toEqual(["ambient-2"]);
    expect(h.controller.snapshot()).toMatchObject({ status: "off", buffer: { segmentCount: 0 } });
  });

  test("events from an old session are ignored", async () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.listener({ sessionId: "stale", event: "session.segment", data: { text: "Scout, go", at: 1 } });
    await h.settle();
    expect(h.log.prompts).toHaveLength(0);
  });
});
