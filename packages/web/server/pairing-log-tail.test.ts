import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCOUT_PAIRING_LOG_TAIL_LINE_LIMIT,
  SCOUT_PAIRING_LOG_TAIL_WINDOW_BYTES,
  readScoutPairingLogTail,
} from "./pairing.ts";

const tempDirs: string[] = [];

function tempLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "openscout-pairing-log-"));
  tempDirs.push(dir);
  return join(dir, "bridge.log");
}

/** The pre-bounded-read semantics: whole file, split, keep the last N lines. */
function naiveTail(content: string): string {
  return content.split(/\r?\n/g).slice(-SCOUT_PAIRING_LOG_TAIL_LINE_LIMIT).join("\n").trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readScoutPairingLogTail", () => {
  test("reports a missing log", () => {
    const tail = readScoutPairingLogTail(join(tmpdir(), "openscout-no-such-dir", "bridge.log"));
    expect(tail).toEqual({
      body: "",
      updatedAtLabel: null,
      missing: true,
      truncated: false,
    });
  });

  test("returns a small log whole", () => {
    const logPath = tempLogPath();
    const content = "alpha\nbravo\ncharlie\n";
    writeFileSync(logPath, content, "utf8");

    const tail = readScoutPairingLogTail(logPath);
    expect(tail.body).toBe("alpha\nbravo\ncharlie");
    expect(tail.missing).toBe(false);
    expect(tail.truncated).toBe(false);
    expect(tail.updatedAtLabel).not.toBeNull();
  });

  test("handles an empty log", () => {
    const logPath = tempLogPath();
    writeFileSync(logPath, "", "utf8");

    const tail = readScoutPairingLogTail(logPath);
    expect(tail.body).toBe("");
    expect(tail.missing).toBe(false);
    expect(tail.truncated).toBe(false);
  });

  test("splits CRLF lines", () => {
    const logPath = tempLogPath();
    writeFileSync(logPath, "one\r\ntwo\r\nthree\r\n", "utf8");

    expect(readScoutPairingLogTail(logPath).body).toBe("one\ntwo\nthree");
  });

  test("keeps only the last lines of a log under the byte window", () => {
    const logPath = tempLogPath();
    const lines = Array.from({ length: 300 }, (_, index) => `line-${String(index).padStart(4, "0")}`);
    const content = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(content)).toBeLessThan(SCOUT_PAIRING_LOG_TAIL_WINDOW_BYTES);
    writeFileSync(logPath, content, "utf8");

    const tail = readScoutPairingLogTail(logPath);
    expect(tail.body).toBe(naiveTail(content));
    expect(tail.truncated).toBe(true);
    expect(tail.body.startsWith("line-")).toBe(true);
    expect(tail.body.endsWith("line-0299")).toBe(true);
  });

  test("matches the whole-file tail on a log larger than the byte window", () => {
    const logPath = tempLogPath();
    // ~101 bytes per line * 4000 lines ≈ 404KB — larger than the 256KB window.
    const lines = Array.from(
      { length: 4000 },
      (_, index) => `line-${String(index).padStart(6, "0")}-${"x".repeat(88)}`,
    );
    const content = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(SCOUT_PAIRING_LOG_TAIL_WINDOW_BYTES);
    writeFileSync(logPath, content, "utf8");

    const tail = readScoutPairingLogTail(logPath);
    expect(tail.body).toBe(naiveTail(content));
    expect(tail.truncated).toBe(true);
    // Every rendered line is intact: the partial line cut by the byte window
    // boundary was dropped, not rendered as a torn fragment.
    for (const line of tail.body.split("\n")) {
      expect(line).toMatch(/^line-\d{6}-x{88}$/);
    }
  });

  test("keeps the first line when the window starts exactly at a line boundary", () => {
    const logPath = tempLogPath();
    // 4096-byte lines: the window holds 64 of them — fewer than the line
    // limit, so a wrongly dropped first line would change the rendered count.
    const lineBytes = 4096;
    const lineCount = SCOUT_PAIRING_LOG_TAIL_WINDOW_BYTES / lineBytes + 1;
    expect(Number.isInteger(lineCount)).toBe(true);
    const lines = Array.from(
      { length: lineCount },
      (_, index) => `L${String(index).padStart(3, "0")}-${"y".repeat(lineBytes - 6)}`,
    );
    const content = `${lines.join("\n")}\n`;
    // One full line beyond the window → the window begins exactly after
    // line 0's terminating newline.
    expect(Buffer.byteLength(content)).toBe(SCOUT_PAIRING_LOG_TAIL_WINDOW_BYTES + lineBytes);
    writeFileSync(logPath, content, "utf8");

    const tail = readScoutPairingLogTail(logPath);
    const rendered = tail.body.split("\n");
    expect(rendered).toHaveLength(lineCount - 1);
    expect(rendered[0]).toBe(lines[1]!);
    expect(tail.truncated).toBe(true);
  });
});
