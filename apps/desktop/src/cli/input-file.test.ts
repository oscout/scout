import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCliInputFile } from "./input-file.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openscout-cli-input-"));
  tempDirs.add(dir);
  return dir;
}

describe("readCliInputFile", () => {
  test("reads UTF-8 prompt files and strips a BOM", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "prompt.md");
    writeFileSync(filePath, "\uFEFFReview the parser\n", "utf8");

    await expect(readCliInputFile(filePath, "prompt")).resolves.toBe(
      "Review the parser\n",
    );
  });

  test("rejects empty message files", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "empty.md");
    writeFileSync(filePath, "\n\n", "utf8");

    await expect(readCliInputFile(filePath, "message")).rejects.toThrow(
      "message file is empty",
    );
  });
});
