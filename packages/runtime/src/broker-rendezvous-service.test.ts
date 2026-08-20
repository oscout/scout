import { describe, expect, test } from "bun:test";

import { SCOUT_RENDEZVOUS_INVITE_TTL_MS } from "@openscout/protocol";

import { BrokerRendezvousService } from "./broker-rendezvous-service.js";

function createHarness() {
  let now = 1_000;
  let id = 0;
  let codename = 0;
  const generatedCodenames = ["AB2CDE", "FG3HJK", "LM4NPQ"];
  const service = new BrokerRendezvousService({
    now: () => now,
    createMatchId: () => `match-${++id}`,
    createInviteCodename: () => generatedCodenames[codename++] ?? "RS5TUV",
    presenceTtlMs: 100,
    matchTtlMs: 200,
    cleanupIntervalMs: 0,
  });
  return {
    service,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("BrokerRendezvousService", () => {
  test("uses a fixed invitation window that owner polling cannot extend", async () => {
    let now = 1_000;
    const service = new BrokerRendezvousService({
      now: () => now,
      createInviteCodename: () => "AB2CDE",
      cleanupIntervalMs: 0,
    });
    const created = await service.match({
      action: "create",
      projectRoot: "/repo",
      participantId: "session:one",
    });
    expect(created).toMatchObject({ status: "created", expiresAt: 1_000 + SCOUT_RENDEZVOUS_INVITE_TTL_MS });

    now = 31_000;
    const polled = await service.match({
      action: "join",
      codename: "AB2CDE",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 0,
    });
    expect(polled).toMatchObject({ status: "waiting", expiresAt: 1_000 + SCOUT_RENDEZVOUS_INVITE_TTL_MS });
    service.dispose();
  });

  test("preserves a facilitator codename and matches it case-insensitively", async () => {
    const harness = createHarness();
    const created = await harness.service.match({
      action: "create",
      codename: "BlueBird",
      projectRoot: "/repo",
      participantId: "session:one",
    });
    expect(created).toMatchObject({
      status: "created",
      codename: "BlueBird",
      expiresAt: 1_100,
    });

    const first = harness.service.match({
      action: "join",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 90_000,
    });
    const second = await harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:two",
      waitMs: 0,
    });
    const released = await first;

    expect(second).toMatchObject({ status: "matched", codename: "BlueBird" });
    expect(released).toMatchObject({ status: "matched", codename: "BlueBird" });
    if (second.status !== "matched" || released.status !== "matched") return;
    expect(second.matchId).toBe("match-1");
    expect(released.matchId).toBe("match-1");
    expect(released.peerParticipantIds).toEqual(["session:two"]);
    expect(second.peerParticipantIds).toEqual(["session:one"]);
    harness.service.dispose();
  });

  test("keeps the creator waiting for a peer that joins later in the invite window", async () => {
    let now = 1_000;
    const service = new BrokerRendezvousService({
      now: () => now,
      createMatchId: () => "match-late-join",
      cleanupIntervalMs: 0,
    });
    const created = await service.match({
      action: "create",
      codename: "BlueBird",
      projectRoot: "/repo",
      participantId: "session:creator",
    });
    expect(created).toMatchObject({ status: "created", expiresAt: 1_000 + SCOUT_RENDEZVOUS_INVITE_TTL_MS });

    const creatorResult = service.match({
      action: "join",
      codename: "BlueBird",
      projectRoot: "/repo",
      participantId: "session:creator",
      waitMs: 600_000,
    });
    now = 181_000;
    const peerResult = await service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:peer",
      waitMs: 0,
    });

    expect(await creatorResult).toMatchObject({
      status: "matched",
      matchId: "match-late-join",
      peerParticipantIds: ["session:peer"],
    });
    expect(peerResult).toMatchObject({
      status: "matched",
      matchId: "match-late-join",
      peerParticipantIds: ["session:creator"],
    });
    service.dispose();
  });

  test("keeps normalized codenames project-scoped", async () => {
    const harness = createHarness();
    const firstProject = await harness.service.match({
      action: "create",
      codename: "BlueBird",
      projectRoot: "/repo-a",
      participantId: "session:one",
    });
    const secondProject = await harness.service.match({
      action: "create",
      codename: "BLUEBIRD",
      projectRoot: "/repo-b",
      participantId: "session:two",
    });

    expect(firstProject).toMatchObject({ status: "created", codename: "BlueBird" });
    expect(secondProject).toMatchObject({ status: "created", codename: "BLUEBIRD" });

    const joinedFirst = await harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo-a",
      participantId: "session:three",
      waitMs: 0,
    });
    expect(joinedFirst).toMatchObject({ status: "matched", codename: "BlueBird" });
    harness.service.dispose();
  });

  test("rejects a same-project codename collision without replacing its owner", async () => {
    const harness = createHarness();
    await harness.service.match({
      action: "create",
      codename: "BlueBird",
      projectRoot: "/repo",
      participantId: "session:one",
    });
    const collision = await harness.service.match({
      action: "create",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:two",
    });

    expect(collision).toMatchObject({
      status: "codename_busy",
      codename: "BlueBird",
      participantCount: 1,
      suggestion: "choose_another_codename",
    });
    const ownerPoll = await harness.service.match({
      action: "join",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 0,
    });
    expect(ownerPoll.status).toBe("waiting");
    harness.service.dispose();
  });

  test("reports project mismatch when no same-project invitation exists", async () => {
    const harness = createHarness();
    await harness.service.match({
      action: "create",
      codename: "BlueBird",
      projectRoot: "/repo-a",
      participantId: "session:one",
    });
    const otherProject = await harness.service.match({
      action: "join",
      codename: "BLUEBIRD",
      projectRoot: "/repo-b",
      participantId: "session:two",
      waitMs: 0,
    });

    expect(otherProject).toMatchObject({
      status: "project_mismatch",
      codename: "BLUEBIRD",
      projectRoot: "/repo-b",
      suggestion: "run_in_invitation_project",
    });
    expect(otherProject).not.toHaveProperty("participantIds");
    harness.service.dispose();
  });

  test("fails closed for a third participant without exposing member identities", async () => {
    const harness = createHarness();
    await harness.service.match({
      action: "create",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
    });
    await harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:two",
      waitMs: 0,
    });
    const third = await harness.service.match({
      action: "join",
      codename: "BlueBird",
      projectRoot: "/repo",
      participantId: "session:three",
      waitMs: 0,
    });

    expect(third).toMatchObject({
      status: "codename_busy",
      participantCount: 2,
      suggestion: "choose_another_codename",
    });
    expect(third).not.toHaveProperty("participantIds");
    harness.service.dispose();
  });

  test("rejects reuse by either matched participant without extending the match", async () => {
    const harness = createHarness();
    await harness.service.match({
      action: "create",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
    });
    const joined = await harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:two",
      waitMs: 0,
    });
    expect(joined).toMatchObject({ status: "matched", expiresAt: 1_200 });

    harness.advance(50);
    const ownerReuse = await harness.service.match({
      action: "join",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 0,
    });
    const peerReuse = await harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:two",
      waitMs: 0,
    });
    expect(ownerReuse).toMatchObject({ status: "consumed", expiresAt: 1_200 });
    expect(peerReuse).toMatchObject({ status: "consumed", expiresAt: 1_200 });
    expect(ownerReuse).not.toHaveProperty("participantIds");
    harness.service.dispose();
  });

  test("releases an invitation waiter with an explicit expiry", async () => {
    const harness = createHarness();
    await harness.service.match({
      action: "create",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
    });
    const waiting = harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 90_000,
    });
    harness.advance(101);
    harness.service.cleanupExpired();
    await expect(waiting).resolves.toMatchObject({
      status: "expired",
      codename: "BLUEBIRD",
      expiresAt: 1_100,
    });
    harness.service.dispose();
  });

  test("tombstones expired codenames for joins but lets a re-create supersede", async () => {
    const harness = createHarness();
    await harness.service.match({
      action: "create",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
    });
    harness.advance(101);
    harness.service.cleanupExpired();
    const afterInviteExpiry = await harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:two",
      waitMs: 0,
    });
    const recreated = await harness.service.match({
      action: "create",
      codename: "BlueBird",
      projectRoot: "/repo",
      participantId: "session:two",
    });
    const joinRecreated = await harness.service.match({
      action: "join",
      codename: "bluebird",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 0,
    });
    expect(afterInviteExpiry).toMatchObject({ status: "expired", expiresAt: 1_100 });
    expect(recreated).toMatchObject({ status: "created", codename: "BlueBird" });
    expect(joinRecreated).toMatchObject({ status: "matched" });

    const generated = await harness.service.match({
      action: "create",
      projectRoot: "/repo",
      participantId: "session:two",
    });
    expect(generated).toMatchObject({ status: "created", codename: "AB2CDE" });
    await harness.service.match({
      action: "join",
      codename: "AB2CDE",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 0,
    });
    harness.advance(201);
    harness.service.cleanupExpired();
    const afterMatchExpiry = await harness.service.match({
      action: "join",
      codename: "AB2CDE",
      projectRoot: "/repo",
      participantId: "session:three",
      waitMs: 0,
    });
    expect(afterMatchExpiry.status).toBe("not_found");
    harness.service.dispose();
  });

  test("rejects malformed codenames, non-session participants, and wait bounds", async () => {
    const harness = createHarness();
    await expect(harness.service.match({
      action: "join",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 600_001,
    })).rejects.toThrow("waitMs");
    await expect(harness.service.match({
      action: "join",
      codename: "BLUE-BIRD",
      projectRoot: "/repo",
      participantId: "session:one",
      waitMs: 0,
    })).rejects.toThrow("ASCII letters or digits");
    await expect(harness.service.match({
      action: "create",
      codename: "BLUEBIRD",
      projectRoot: "/repo",
      participantId: "shared-project-agent",
    })).rejects.toThrow("exact session:<id>");
    harness.service.dispose();
  });
});
