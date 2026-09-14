import { describe, expect, it } from "bun:test";
import {
  besideAdd,
  besideFromRoute,
  besideRemove,
  besideRoute,
  besideToggle,
  deckCard,
  deckConversations,
  deckFocus,
  deckNodes,
  deckPasses,
  deckTitle,
  deckToken,
  type DeckCard,
} from "./comms-deck.ts";
import type { FlowActor, FlowPass } from "../../lib/comms-flow.ts";
import type { FlowTask } from "./comms-flow-map.ts";

const actor = (id: string): FlowActor =>
  ({ id, ids: [id], name: id, short: id, kind: "agent", harness: null }) as unknown as FlowActor;

let seq = 0;
function pass(from: string, to: string[], body = "hello", conversationId = "chn-1"): FlowPass {
  seq += 1;
  return {
    id: `pass-${seq}`,
    message: { id: `msg-${seq}`, conversationId, actorId: from, body, createdAt: seq * 1000 },
    from: actor(from),
    to: to.map(actor),
    audience: to.map(actor),
    at: seq * 1000,
    count: 1,
    kind: "message",
    route: "relayTargetIds",
    inbound: false,
    gap: 0,
    index: seq,
    askId: null,
    opensId: null,
    replyTo: null,
  } as unknown as FlowPass;
}

const task = (id: string, waiter: string, worker: string, passes: FlowPass[]): FlowTask =>
  ({
    id,
    title: "Fix the flaky retry",
    waiter: actor(waiter),
    worker: actor(worker),
    at: 0,
    ms: 1000,
    abandoned: false,
    passes,
  }) as unknown as FlowTask;

describe("a card is a reference, so a token names the same thing on reload", () => {
  const cards: DeckCard[] = [
    { kind: "conversation", conversationId: "chn-7f5" },
    { kind: "task", askId: "flt-abc" },
    { kind: "pair", from: "blink", to: "quill" },
    { kind: "actor", actorId: "blink" },
    { kind: "message", passId: "pass-9" },
  ];

  it("round-trips every kind", () => {
    for (const card of cards) expect(deckCard(deckToken(card))).toEqual(card);
  });

  it("refuses a token that names nothing rather than inventing a card", () => {
    expect(deckCard("c:")).toBeNull();
    expect(deckCard("x:abc")).toBeNull();
    expect(deckCard("p:blink")).toBeNull();
    expect(deckCard("p:~quill")).toBeNull();
  });
});

describe("beside is what you kept, in the order you kept it", () => {
  it("reads conversations out of the route and writes them back the same", () => {
    const ids = besideFromRoute("c:chn-a,c:chn-b");
    expect(ids).toEqual(["chn-a", "chn-b"]);
    expect(besideRoute(ids)).toBe("c:chn-a,c:chn-b");
  });

  it("a duplicate in the URL is one column, not two", () => {
    expect(besideFromRoute("c:chn-a,c:chn-a")).toEqual(["chn-a"]);
  });

  it("reads past a link from before the stage existed", () => {
    // The column being browsed was marked with `~`; slices of a drawing were
    // columns too. Neither is a thing that can be kept beside any more.
    expect(besideFromRoute("c:chn-a,~c:chn-b,t:flt-1,a:blink")).toEqual(["chn-a", "chn-b"]);
  });

  it("nothing is nothing", () => {
    expect(besideFromRoute(null)).toEqual([]);
    expect(besideFromRoute("")).toEqual([]);
    expect(besideRoute([])).toBe("");
  });

  it("keeping something already kept changes nothing, so a repeat press does not churn", () => {
    const held = ["chn-a"];
    expect(besideAdd(held, "chn-a")).toBe(held);
    expect(besideAdd(held, "chn-b")).toEqual(["chn-a", "chn-b"]);
  });

  it("closing leaves the rest in place", () => {
    expect(besideRemove(["chn-a", "chn-b", "chn-c"], "chn-b")).toEqual(["chn-a", "chn-c"]);
    const held = ["chn-a"];
    expect(besideRemove(held, "chn-z")).toBe(held);
  });

  it("toggle is keep or close, whichever the list is not yet", () => {
    expect(besideToggle(["chn-a"], "chn-b")).toEqual(["chn-a", "chn-b"]);
    expect(besideToggle(["chn-a", "chn-b"], "chn-a")).toEqual(["chn-b"]);
  });
});

describe("what a card is made of", () => {
  const a = pass("blink", ["quill"], "do the thing");
  const b = pass("quill", ["blink"], "done");
  const c = pass("blink", ["darwin"], "and this");
  const passes = [a, b, c];
  const tasks = [task("flt-a", "blink", "quill", [a, b])];

  it("a task is the passes the flight carried", () => {
    expect(deckPasses({ kind: "task", askId: "flt-a" }, passes, tasks).map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("a task that is not in this window is empty rather than wrong", () => {
    expect(deckPasses({ kind: "task", askId: "flt-gone" }, passes, tasks)).toEqual([]);
  });

  it("an exchange is one ordered pair, not both directions", () => {
    expect(deckPasses({ kind: "pair", from: "blink", to: "quill" }, passes, tasks).map((p) => p.id)).toEqual([a.id]);
    expect(deckPasses({ kind: "pair", from: "quill", to: "blink" }, passes, tasks).map((p) => p.id)).toEqual([b.id]);
  });

  it("a participant is everything they sent or were addressed in", () => {
    expect(deckPasses({ kind: "actor", actorId: "blink" }, passes, tasks).map((p) => p.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });

  it("a message is itself", () => {
    expect(deckPasses({ kind: "message", passId: b.id }, passes, tasks).map((p) => p.id)).toEqual([b.id]);
  });

  it("a conversation is served live, so this window holds none of it", () => {
    expect(deckPasses({ kind: "conversation", conversationId: "chn-1" }, passes, tasks)).toEqual([]);
  });
});

describe("what the drawing should light for a selection", () => {
  const a = pass("blink", ["quill"]);
  const tasks = [task("flt-a", "blink", "quill", [a])];

  it("a task lights both ends of it", () => {
    expect(deckNodes({ kind: "task", askId: "flt-a" }, tasks).sort()).toEqual(["blink", "quill"]);
    expect([...(deckFocus({ kind: "task", askId: "flt-a" }, tasks) ?? [])].sort()).toEqual(["blink", "quill"]);
  });

  it("nothing selected is not the same as dimming everything", () => {
    expect(deckFocus(null, tasks)).toBeNull();
    expect(deckFocus({ kind: "message", passId: "pass-1" }, tasks)).toBeNull();
  });
});

describe("where a selection leads: the conversations it happened in", () => {
  const a = pass("blink", ["quill"], "first", "chn-old");
  const b = pass("quill", ["blink"], "second", "chn-new");
  const c = pass("blink", ["quill"], "third", "chn-old");
  const passes = [a, b, c];
  const tasks: FlowTask[] = [];

  it("lists each conversation once, most recent first", () => {
    expect(deckConversations({ kind: "actor", actorId: "blink" }, passes, tasks)).toEqual(["chn-old", "chn-new"]);
    expect(deckConversations({ kind: "pair", from: "quill", to: "blink" }, passes, tasks)).toEqual(["chn-new"]);
  });

  it("a selection that is not in this window leads nowhere", () => {
    expect(deckConversations({ kind: "task", askId: "flt-gone" }, passes, tasks)).toEqual([]);
  });
});

describe("a title is resolved from the window, not stored on the card", () => {
  const a = pass("blink", ["quill"], "  \n  Please review the retry path\nand report back");
  const tasks = [task("flt-a", "blink", "quill", [a])];
  const name = (id: string) => (id === "blink" ? "Blink" : "Quill");

  it("names both ends of an exchange", () => {
    expect(deckTitle({ kind: "pair", from: "blink", to: "quill" }, tasks, [a], name)).toBe("Blink → Quill");
  });

  it("takes a message's first non-blank line", () => {
    expect(deckTitle({ kind: "message", passId: a.id }, tasks, [a], name)).toBe("Please review the retry path");
  });

  it("says so when the subject is not in this window rather than drawing a blank", () => {
    expect(deckTitle({ kind: "task", askId: "flt-gone" }, tasks, [a], name)).toMatch(/not in this window/);
  });
});
