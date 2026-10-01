import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOpenCodeTransport } from "./index.js";

const scratch: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-transport-"));
  scratch.push(dir);
  return dir;
}

function installOpenCode2(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "opencode2");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("defaultOpenCodeTransport", () => {
  test("falls back to ACP when no opencode2 is installed", () => {
    const home = scratchDir();
    expect(defaultOpenCodeTransport({ HOME: home, PATH: "" }, [])).toBe("opencode_acp");
  });

  test("prefers V2 when opencode2 is in a known install dir", () => {
    const home = scratchDir();
    installOpenCode2(join(home, ".bun", "bin"));
    expect(defaultOpenCodeTransport({ HOME: home, PATH: "" }, [])).toBe("opencode_v2");
  });

  test("prefers V2 when opencode2 is only on PATH", () => {
    const home = scratchDir();
    const bin = scratchDir();
    installOpenCode2(bin);
    expect(defaultOpenCodeTransport({ HOME: home, PATH: bin }, [])).toBe("opencode_v2");
  });

  test("honours an OPENCODE_V2_BIN that exists", () => {
    const home = scratchDir();
    const bin = installOpenCode2(scratchDir());
    expect(defaultOpenCodeTransport({ HOME: home, PATH: "", OPENCODE_V2_BIN: bin }, [])).toBe("opencode_v2");
  });

  test("throws on an OPENCODE_V2_BIN that is missing instead of falling back", () => {
    const home = scratchDir();
    installOpenCode2(join(home, ".bun", "bin"));
    expect(() =>
      defaultOpenCodeTransport({ HOME: home, PATH: "", OPENCODE_V2_BIN: join(home, "nope", "opencode2") }, []),
    ).toThrow(/OPENCODE_V2_BIN/);
  });
});
