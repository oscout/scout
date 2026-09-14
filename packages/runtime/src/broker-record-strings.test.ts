import { expect, test } from "bun:test";
import { shareLoadedRecordStrings } from "./broker-record-strings.js";
import type { BrokerJournalEntry } from "./broker-journal.js";

test("sharing parsed record strings preserves exact keys, values, Unicode and unknown fields", () => {
  const inputs = [
    { kind: "deliveries.record", deliveries: [{ id: "雪🦊\ud800", targetKind: "agent", transport: "local_socket", policy: "best_effort", reason: "direct_message", status: "acknowledged", metadata: { status: "new\ud800", body: "agent" }, extension: ["雪", null] }] },
    { kind: "delivery.status.update", deliveryId: "d", status: "pending", metadata: { future: true } },
    { kind: "message.record", message: { id: "m", class: "agent", body: "agent\ud800雪", metadata: { class: "future" } } },
    { kind: "deliveries.record", deliveries: [{ targetKind: "future🦊", transport: "__proto__", status: "constructor", policy: "", reason: "toString" }, {}, { status: null, policy: 42 }] },
    { kind: "future.record", nested: { status: "agent" } },
  ];
  for (const input of inputs) {
    const encoded = JSON.stringify(input);
    const parsed = JSON.parse(encoded) as BrokerJournalEntry;
    shareLoadedRecordStrings(parsed);
    shareLoadedRecordStrings(parsed);
    expect(JSON.stringify(parsed)).toBe(encoded);
    expect(parsed).toEqual(input as never);
  }
});

test("sharing does not traverse or replace nested user-owned values", () => {
  const entry = JSON.parse('{"kind":"deliveries.record","deliveries":[{"status":"acknowledged","metadata":{"status":"pending","__proto__":{"literal":true}},"attachments":[{"body":"agent"}]}]}');
  const record = entry.deliveries[0];
  const metadata = record.metadata;
  const attachments = record.attachments;
  shareLoadedRecordStrings(entry);
  expect(entry.deliveries[0]).toBe(record);
  expect(record.metadata).toBe(metadata);
  expect(record.attachments).toBe(attachments);
  expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
  expect(Object.hasOwn(record, "transport")).toBe(false);
});
