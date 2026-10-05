import { expect, test } from "bun:test";
import { SCOUT_RUNTIME_CATALOG } from "../packages/protocol/src/runtime-execution.ts";
import { readModelMetadata, runtimeModelUpdateReport } from "./check-runtime-model-updates.ts";

const model = (id: string, context = 123456) => ({ id, name: "New model", tool_call: true, modalities: { output: ["text"] }, limit: { context } });

test("upstream additions produce review candidates without changing enablement or defaults", () => {
  const catalog = structuredClone(SCOUT_RUNTIME_CATALOG);
  const before = JSON.stringify(catalog);
  const report = runtimeModelUpdateReport(catalog, { "openai/gpt-future": model("openai/gpt-future") });
  expect(report.updates).toContainEqual({ kind: "new-model", harness: "codex", sourceId: "openai/gpt-future", proposedId: "gpt-future", name: "New model", contextWindowTokens: 123456, releaseDate: null });
  expect(JSON.stringify(catalog)).toBe(before);
  expect(report.missing.some((entry) => entry.model === "gpt-6-sol")).toBe(true);
});

test("reports exact-ID metadata differences and never guesses aliases or provider prefixes", () => {
  const report = runtimeModelUpdateReport(SCOUT_RUNTIME_CATALOG, {
    "openai/gpt-6-sol": model("openai/gpt-6-sol", 1050000),
    "openai/sol": model("openai/sol"),
    "openai/mismatch": model("other/mismatch"),
  });
  expect(report.updates).toContainEqual({ kind: "context-window", harness: "codex", model: "gpt-6-sol", sourceId: "openai/gpt-6-sol", current: 272000, proposed: 1050000 });
  expect(report.updates.some((entry) => entry.sourceId === "openai/sol" && entry.kind === "new-model")).toBe(true);
  expect(report.updates.some((entry) => entry.sourceId === "openai/mismatch")).toBe(false);
});

test("does not mistake image-only or malformed data for model updates", () => {
  expect(() => runtimeModelUpdateReport(SCOUT_RUNTIME_CATALOG, [])).toThrow();
  expect(() => runtimeModelUpdateReport(SCOUT_RUNTIME_CATALOG, { "openai/image": { id: "openai/image", name: "Image", tool_call: false, modalities: { output: ["image"] } } })).toThrow();
});

test("upstream failures and oversized responses cannot become a publication report", async () => {
  await expect(readModelMetadata(async () => new Response("unavailable", { status: 503 }))).rejects.toThrow("HTTP 503");
  await expect(readModelMetadata(async () => new Response("{}", { headers: { "content-length": "8388609" } }))).rejects.toThrow("size limit");
});
