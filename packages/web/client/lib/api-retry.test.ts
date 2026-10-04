import { describe, expect, test } from "bun:test";
import { readWithRetry } from "./api-retry.ts";

describe("startup reads", () => {
  test("remains pending during recovery and resolves without publishing the first network failure", async () => {
    const trace: string[] = [];
    let reads = 0;
    let resume!: () => void;
    const sleep = () => new Promise<void>((resolve) => { resume = resolve; });
    const result = readWithRetry("Home", async () => {
      if (++reads === 1) throw new Error("Failed to fetch");
      return { ready: true };
    }, (line) => trace.push(line), { sleep });
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(trace).toContain("Home: no response yet; retrying");
    resume();
    expect(await result).toEqual({ ready: true });
    expect(reads).toBe(2);
  });
  test("a stopped server produces a final failure after three attempts", async () => {
    let reads = 0;
    const waits: number[] = [];
    await expect(readWithRetry("Home", async () => {
      reads++; throw new Error("Failed to fetch");
    }, () => {}, { sleep: async (ms) => { waits.push(ms); } })).rejects.toThrow("Failed to fetch");
    expect(reads).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });
  test("permission errors fail directly without automatic retries", async () => {
    let reads = 0;
    await expect(readWithRetry("Home", async () => {
      reads++; throw new Error("Permission denied");
    }, () => {})).rejects.toThrow("Permission denied");
    expect(reads).toBe(1);
  });
  test("superseded requests do not run another retry", async () => {
    let active = true;
    let reads = 0;
    await expect(readWithRetry("Home", async () => {
      reads++; throw new Error("HTTP 503");
    }, () => {}, { active: () => active, sleep: async () => { active = false; } })).rejects.toThrow("superseded");
    expect(reads).toBe(1);
  });
});
