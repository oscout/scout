import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJetStreamConfig } from "./config.js";
import { JetStreamJournalPublisher, readJetStreamPublisherProgress } from "./publisher.js";

test("valid JSON with a non-object shape is invalid progress, never a fresh start", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-progress-shape-"));
  try {
    const path = join(root, "progress.json");
    for (const value of ["null", "[]", "true", "123", '"text"']) {
      writeFileSync(path, value);
      expect(readJetStreamPublisherProgress(path).kind).toBe("invalid");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed first-enable barrier cannot be silently retaken after broker admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-progress-boundary-"));
  let captures = 0;
  let published = 0;
  try {
    const publisher = new JetStreamJournalPublisher({
      config: resolveJetStreamConfig({ OPENSCOUT_JETSTREAM_HOME: root }, { enabled: true }),
      publisherNodeId: "node-test",
      connection: { publishEvent: async () => { published++; throw new Error("must not publish"); } } as never,
      journal: {
        captureReplayBoundary: async () => { captures++; throw new Error("journal unavailable"); },
        replay: async () => { throw new Error("must not replay"); },
      },
    });
    await publisher.establishStartBoundary();
    expect(publisher.snapshot().blocked).toBe(true);
    expect(publisher.snapshot().state).toBe("degraded");
    await publisher.start();
    await publisher.checkpoint();
    await publisher.stop();
    expect(captures).toBe(1);
    expect(published).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
