import { expect, test } from "bun:test";

test("opt-in replay preserves canonical history and captured record versions", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileBackedBrokerJournal } = await import("./broker-journal.js");
  const directory = await mkdtemp(join(tmpdir(), "scout-shared-strings-"));
  const path = join(directory, "journal.jsonl");
  const input = [
    { kind: "message.record", message: { id: "m", conversationId: "c", actorId: "a", originNodeId: "n", class: "agent", body: "雪\ud800 first", visibility: "private", policy: "durable", createdAt: 1 } },
    { kind: "deliveries.record", deliveries: [{ id: "d", messageId: "m", targetKind: "agent", targetId: "a", transport: "local_socket", policy: "best_effort", reason: "direct_message", status: "pending", metadata: { custom: "\ud800雪" } }] },
    { kind: "delivery.status.update", deliveryId: "d", status: "acknowledged", metadata: { version: 2 } },
  ];
  const encoded = input.map(value => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(path, encoded);
  const baseline = new FileBackedBrokerJournal(path);
  const shared = new FileBackedBrokerJournal(path, { shareLoadedStrings: true });
  try {
    await baseline.load(); await shared.load();
    expect(shared.snapshot()).toEqual(baseline.snapshot());
    expect(shared.listDeliveries().find(value => value.id === "d")).toEqual(baseline.listDeliveries().find(value => value.id === "d"));
    expect(await shared.readEntries()).toEqual(input as never);
    expect(await readFile(path, "utf8")).toBe(encoded);
    const captured = shared.listDeliveries().find(value => value.id === "d")!;
    await shared.appendEntries({ kind: "delivery.status.update", deliveryId: "d", status: "completed" });
    expect(captured.status).toBe("acknowledged");
    expect(shared.listDeliveries().find(value => value.id === "d")!.status).toBe("completed");
    expect((await readFile(path, "utf8")).startsWith(encoded)).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
