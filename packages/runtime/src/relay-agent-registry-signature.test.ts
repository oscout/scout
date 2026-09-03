import { describe, expect, test } from "bun:test";

import { createRelayAgentRegistrySignatureReader } from "./relay-agent-registry-signature";

type MutableMetadata = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function createHarness() {
  let clockMs = 1_000;
  let contents = "alpha";
  let metadata: MutableMetadata = {
    dev: 1,
    ino: 10,
    size: contents.length,
    mtimeMs: 100,
    ctimeMs: 100,
  };
  let readCount = 0;
  let hashCount = 0;
  const reader = createRelayAgentRegistrySignatureReader({
    resolvePath: () => "/support/relay-agents.json",
    statFile: async () => metadata,
    readFileContents: async () => {
      readCount++;
      return Buffer.from(contents);
    },
    hashContents: (value) => {
      hashCount++;
      return Buffer.from(value).toString("base64url");
    },
    now: () => clockMs,
    hashBackstopMs: 60_000,
  });

  return {
    reader,
    counts: () => ({ readCount, hashCount }),
    advance(ms: number) {
      clockMs += ms;
    },
    replace(nextContents: string) {
      contents = nextContents;
      metadata = {
        ...metadata,
        ino: metadata.ino + 1,
        size: nextContents.length,
      };
    },
    rewriteIdentically() {
      metadata = {
        ...metadata,
        ino: metadata.ino + 1,
        mtimeMs: metadata.mtimeMs + 1,
        ctimeMs: metadata.ctimeMs + 1,
      };
    },
    rewriteWithoutMetadataChange(nextContents: string) {
      contents = nextContents;
    },
  };
}

describe("relay agent registry signature reader", () => {
  test("uses metadata as the unchanged fast path without reading or hashing", async () => {
    const harness = createHarness();

    const initial = await harness.reader();
    harness.advance(5_000);
    const unchanged = await harness.reader();

    expect(unchanged).toBe(initial);
    expect(harness.counts()).toEqual({ readCount: 1, hashCount: 1 });
  });

  test("detects a same-size, same-mtime replacement by inode", async () => {
    const harness = createHarness();

    const initial = await harness.reader();
    harness.replace("bravo");
    harness.advance(5_000);
    const replaced = await harness.reader();

    expect(replaced).not.toBe(initial);
    expect(harness.counts()).toEqual({ readCount: 2, hashCount: 2 });
  });

  test("keeps the content signature stable across an identical atomic rewrite", async () => {
    const harness = createHarness();

    const initial = await harness.reader();
    harness.rewriteIdentically();
    harness.advance(5_000);
    const rewritten = await harness.reader();

    expect(rewritten).toBe(initial);
    expect(harness.counts()).toEqual({ readCount: 2, hashCount: 2 });
  });

  test("periodically hashes unchanged metadata to catch coarse-timestamp rewrites", async () => {
    const harness = createHarness();

    const initial = await harness.reader();
    harness.rewriteWithoutMetadataChange("bravo");
    harness.advance(59_999);
    expect(await harness.reader()).toBe(initial);
    expect(harness.counts()).toEqual({ readCount: 1, hashCount: 1 });

    harness.advance(1);
    expect(await harness.reader()).not.toBe(initial);
    expect(harness.counts()).toEqual({ readCount: 2, hashCount: 2 });
  });
});
