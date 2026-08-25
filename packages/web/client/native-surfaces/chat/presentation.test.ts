import { describe, expect, it } from "bun:test";

import {
  CHAT_DENSITIES,
  DEFAULT_CHAT_DENSITY,
  SENDER_HUE_COUNT,
  decisionStatus,
  hostStatus,
  humaniseStatus,
  identityFor,
  isGroupedWithPrevious,
  resolveDensity,
  senderAttribution,
  showsSenderLabel,
} from "./presentation.ts";

function incoming(actorId: string, createdAt = 0) {
  return { actorId, isOperator: false, createdAt };
}

function outgoing(createdAt = 0) {
  return { actorId: "you", isOperator: true, createdAt };
}

describe("resolveDensity", () => {
  it("accepts every advertised density", () => {
    for (const density of CHAT_DENSITIES) expect(resolveDensity(density)).toBe(density);
  });

  it("falls back to the refined default for unknown, missing, or malformed values", () => {
    for (const value of [undefined, null, "", "cozy", 3, {}, ["compact"]]) {
      expect(resolveDensity(value)).toBe(DEFAULT_CHAT_DENSITY);
    }
  });

  it("defaults to standard so a fresh install gets the refined reading scale", () => {
    expect(DEFAULT_CHAT_DENSITY).toBe("standard");
  });
});

describe("senderAttribution", () => {
  it("reports a one-to-one conversation as single-sender", () => {
    const attribution = senderAttribution([outgoing(1), incoming("fable", 2), outgoing(3), incoming("fable", 4)]);
    expect(attribution.multiSender).toBe(false);
    expect(attribution.incomingActorIds).toEqual(["fable"]);
  });

  it("ignores the operator when counting voices", () => {
    // Several operator messages must never make a 1:1 chat look like a group.
    const attribution = senderAttribution([outgoing(1), outgoing(2), outgoing(3)]);
    expect(attribution.multiSender).toBe(false);
    expect(attribution.incomingActorIds).toEqual([]);
  });

  it("reports multi-sender once a second voice speaks", () => {
    const attribution = senderAttribution([incoming("fable", 1), outgoing(2), incoming("kimi", 3)]);
    expect(attribution.multiSender).toBe(true);
    expect(attribution.incomingActorIds).toEqual(["fable", "kimi"]);
  });

  it("assigns stable palette slots by first appearance and wraps within the palette", () => {
    const actors = ["a", "b", "c", "d", "e", "f"];
    const attribution = senderAttribution(actors.map((actorId, index) => incoming(actorId, index)));
    expect(actors.map((actorId) => attribution.hueIndexOf(actorId))).toEqual([0, 1, 2, 3, 0, 1]);
    // Repeated lookups are stable, and an unseen actor lands on a real slot.
    expect(attribution.hueIndexOf("b")).toBe(1);
    expect(attribution.hueIndexOf("never-spoke")).toBeLessThan(SENDER_HUE_COUNT);
  });
});

describe("showsSenderLabel", () => {
  const base = { mode: "normie", isOperator: false, grouped: false, multiSender: false } as const;

  it("drops the redundant label in a one-to-one Normie chat", () => {
    expect(showsSenderLabel(base)).toBe(false);
  });

  it("keeps the label in a Normie chat once topology requires it", () => {
    expect(showsSenderLabel({ ...base, multiSender: true })).toBe(true);
  });

  it("keeps machine attribution in Techie even one-to-one", () => {
    expect(showsSenderLabel({ ...base, mode: "techie" })).toBe(true);
  });

  it("never labels the operator's own bubbles", () => {
    expect(showsSenderLabel({ ...base, mode: "techie", isOperator: true })).toBe(false);
    expect(showsSenderLabel({ ...base, multiSender: true, isOperator: true })).toBe(false);
  });

  it("labels only the head of a burst", () => {
    expect(showsSenderLabel({ ...base, multiSender: true, grouped: true })).toBe(false);
    expect(showsSenderLabel({ ...base, mode: "techie", grouped: true })).toBe(false);
  });
});

describe("isGroupedWithPrevious", () => {
  it("does not group the first message", () => {
    expect(isGroupedWithPrevious(incoming("fable", 1_000), undefined)).toBe(false);
  });

  it("groups a burst from one voice", () => {
    expect(isGroupedWithPrevious(incoming("fable", 60_000), incoming("fable", 1_000))).toBe(true);
  });

  it("does not group two different agents in a group thread", () => {
    // Both are incoming, so an isOperator-only comparison merged them and the
    // second agent lost both its avatar and its name.
    expect(isGroupedWithPrevious(incoming("kimi", 60_000), incoming("fable", 1_000))).toBe(false);
  });

  it("does not group across the operator boundary", () => {
    expect(isGroupedWithPrevious(incoming("fable", 60_000), outgoing(1_000))).toBe(false);
  });

  it("breaks the burst once the gap exceeds the window", () => {
    expect(isGroupedWithPrevious(incoming("fable", 121_001), incoming("fable", 1_000))).toBe(false);
  });
});

describe("hostStatus", () => {
  it("names the machine when the host reports one", () => {
    expect(hostStatus({ name: "Scout Mac mini", state: "synced" }))
      .toEqual({ text: "Synced with Scout Mac mini", tone: "neutral", state: "synced" });
  });

  it("falls back to a generic phrasing only when no name is available", () => {
    for (const name of [undefined, null, "", "   "]) {
      expect(hostStatus({ name, state: "synced" })?.text).toBe("Synced with host");
    }
  });

  it("trims a padded name rather than rendering the padding", () => {
    expect(hostStatus({ name: "  Scout Mac mini  ", state: "synced" })?.text).toBe("Synced with Scout Mac mini");
  });

  it("never claims synced while disconnected, degraded, or failed", () => {
    const claims = (["connecting", "degraded", "offline", "failed"] as const)
      .map((state) => hostStatus({ name: "Scout Mac mini", state })?.text ?? "");
    expect(claims.some((text) => text.toLowerCase().includes("synced"))).toBe(false);
    expect(claims).toEqual([
      "Connecting to Scout Mac mini…",
      "Reconnecting to Scout Mac mini",
      "Not connected to Scout Mac mini",
      "Can’t reach Scout Mac mini",
    ]);
  });

  it("spends a reserved colour family only where the state earns it", () => {
    expect(hostStatus({ name: "M", state: "synced" })?.tone).toBe("neutral");
    expect(hostStatus({ name: "M", state: "connecting" })?.tone).toBe("neutral");
    expect(hostStatus({ name: "M", state: "degraded" })?.tone).toBe("warning");
    expect(hostStatus({ name: "M", state: "offline" })?.tone).toBe("warning");
    expect(hostStatus({ name: "M", state: "failed" })?.tone).toBe("error");
  });

  it("shows nothing at all when the host reports nothing usable", () => {
    for (const identity of [null, undefined, {}, { name: "Scout Mac mini" }, { state: "bogus" }, { state: null }]) {
      expect(hostStatus(identity as never)).toBeNull();
    }
  });
});

describe("identityFor", () => {
  const session = { name: "Fable", adapterType: "codex", status: "ready", cwd: "/Users/example/dev/openscout", model: "gpt-5" };
  const base = {
    actorId: "fable", name: "Fable", kind: "agent" as const,
    soleIncomingActorId: "fable", session, hostName: "Scout Mac mini",
  };

  it("shows the identity facts people actually use in Normie", () => {
    const identity = identityFor({ ...base, mode: "normie" });
    expect(identity.facts).toEqual([
      { label: "Host", value: "Scout Mac mini" },
      { label: "Project", value: "openscout" },
      { label: "Model", value: "gpt-5" },
    ]);
    // A healthy agent answers no question, so no status line.
    expect(identity.status).toBeNull();
  });

  it("adds the machinery in Techie without dropping the identity facts", () => {
    const identity = identityFor({ ...base, mode: "techie" });
    expect(identity.facts.map((fact) => fact.label)).toEqual(["Host", "Project", "Model", "Runtime"]);
  });

  it("never invents a branch, because the session contract carries none", () => {
    for (const mode of ["normie", "techie"] as const) {
      const labels = identityFor({ ...base, mode }).facts.map((fact) => fact.label);
      expect(labels).not.toContain("Branch");
      expect(labels).not.toContain("Worktree");
    }
  });

  it("never attaches the session's facts to another voice in a group thread", () => {
    // Kimi spoke in the same conversation, but the session describes Fable.
    const identity = identityFor({ ...base, actorId: "kimi", name: "Kimi", mode: "techie", soleIncomingActorId: null });
    expect(identity.isConversationAgent).toBe(false);
    expect(identity.facts.map((fact) => fact.label)).toEqual(["Host"]);
    expect(identity.name).toBe("Kimi");
  });

  it("offers a deeper destination only for the conversation's own agent", () => {
    expect(identityFor({ ...base, mode: "normie" }).isConversationAgent).toBe(true);
    expect(identityFor({ ...base, mode: "normie", soleIncomingActorId: null }).isConversationAgent).toBe(false);
    // A person is never described by the conversation's session.
    expect(identityFor({ ...base, mode: "normie", kind: "person" }).isConversationAgent).toBe(false);
  });

  it("omits a fact rather than inventing a placeholder for it", () => {
    const identity = identityFor({
      ...base, mode: "techie",
      session: { name: "Fable", adapterType: null, status: "  ", cwd: "", model: undefined },
      hostName: null,
    });
    expect(identity.facts).toEqual([]);
  });

  it("names the project from the working directory, not the whole path", () => {
    for (const [cwd, expected] of [["/Users/example/dev/openscout", "openscout"], ["/Users/example/dev/openscout/", "openscout"], ["/", null]] as const) {
      const facts = identityFor({ ...base, mode: "normie", session: { ...session, cwd } }).facts;
      expect(facts.find((fact) => fact.label === "Project")?.value ?? null).toBe(expected);
    }
  });
});

describe("humaniseStatus", () => {
  it("turns adapter words into something a person reads", () => {
    expect(humaniseStatus("ready")).toBe("Ready");
    expect(humaniseStatus("needs_input")).toBe("Needs input");
  });

  it("returns nothing for nothing", () => {
    for (const value of [null, undefined, "", "   "]) expect(humaniseStatus(value)).toBeNull();
  });
});

describe("decisionStatus", () => {
  it("stays quiet for a healthy agent", () => {
    for (const nominal of ["ready", "active", "idle", "completed"]) {
      expect(decisionStatus(nominal)).toBeNull();
    }
  });

  it("speaks up only when the state changes what you would do next", () => {
    expect(decisionStatus("connecting")).toBe("Connecting");
    expect(decisionStatus("error")).toBe("Error");
    expect(decisionStatus("closed")).toBe("Closed");
    expect(decisionStatus("waiting")).toBe("Waiting");
    expect(decisionStatus("blocked")).toBe("Blocked");
  });

  it("surfaces a decision status through the identity", () => {
    const session = { name: "Fable", adapterType: "codex", status: "error", cwd: "/w/openscout", model: "gpt-5" };
    const identity = identityFor({
      actorId: "fable", name: "Fable", kind: "agent", mode: "normie",
      soleIncomingActorId: "fable", session, hostName: "Scout Mac mini",
    });
    expect(identity.status).toBe("Error");
  });

  it("returns nothing for nothing", () => {
    for (const value of [null, undefined, "", "  "]) expect(decisionStatus(value)).toBeNull();
  });
});
