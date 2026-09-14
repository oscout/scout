import { expect, test } from "bun:test";
import type { AgentLane } from "./agent-lanes-model.ts";
import type { AdventureStop } from "./agent-adventures-model.ts";
import { adventureEvidence } from "./adventure-evidence.ts";
const lane = { agent: { cwd: "/repo" }, observe: { events: [], files: [{ path: "future.ts", state: "modified" }] } } as unknown as AgentLane;
function stop(id: string, tool: string, arg: string, result?: Record<string, string | number>): AdventureStop {
  return { id, at: 10, kind: "tool", label: "Tool", artifact: arg, event: { id, t: 0, kind: "tool", text: "", tool, arg, result } };
}
test("evidence advances and rewinds with cursor without all-time files leaking", () => {
  const stops = [stop("read", "Read", "src/a.ts"), stop("edit", "Write", '{"path":"src/b.ts"}'), stop("test", "exec_command", '{"cmd":"bun test"}', { exit_code: 0 })];
  expect(adventureEvidence(stops, -1, lane)).toEqual({ read: [], changed: [], runs: [] });
  expect(adventureEvidence(stops, 0, lane).changed).toHaveLength(0);
  expect(adventureEvidence(stops, 1, lane).runs).toHaveLength(0);
  expect(adventureEvidence(stops, 2, lane).runs[0].outcome).toBe("passed");
  expect(adventureEvidence(stops, 0, lane).read[0].resolvedPath).toBe("/repo/src/a.ts");
});
test("deduplicates paths and replayed event IDs while counting real observations", () => {
  const first = stop("one", "Read", "src/a.ts");
  const evidence = adventureEvidence([first, first, stop("two", "Read", "/repo/src/./a.ts")], 2, lane);
  expect(evidence.read).toHaveLength(1);
  expect(evidence.read[0].observations).toBe(2);
});
test("explicit exits distinguish failed, successful, and unavailable validation", () => {
  const evidence = adventureEvidence([stop("a", "bash", "npm test"), stop("b", "bash", "bun run check", { exit_code: 1 }), stop("c", "bash", "pytest", { exitCode: "0" }), stop("d", "bash", "go test ./...", { outcome: "all tests passed" })], 3, lane);
  expect(evidence.runs.map(run => run.outcome)).toEqual(["unavailable", "failed", "passed", "unavailable"]);
});
test("patch headers and direct shell reads produce paths without treating command prose as paths", () => {
  const evidence = adventureEvidence([stop("a", "apply_patch", "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch"), stop("b", "bash", "cat README.md"), stop("c", "bash", "echo bun test"), stop("d", "search", '{"query":"fake.ts"}')], 3, lane);
  expect(evidence.changed.map(file => file.path)).toEqual(["src/a.ts"]);
  expect(evidence.read.map(file => file.path)).toEqual(["README.md"]);
  expect(evidence.runs).toHaveLength(0);
});
test("unresolved relative paths stay visible without pretending they can be previewed", () => {
  expect(adventureEvidence([stop("a", "Read", "src/a.ts")], 0, { agent: {}, observe: null } as AgentLane).read[0].resolvedPath).toBeNull();
});

test("static wrapped commands use the same validation recognition as playback", () => {
  const evidence = adventureEvidence([stop("wrapped", "bash", 'text(await tools.exec_command({cmd:"bun test", max_output_tokens:1000}));')], 0, lane);
  expect(evidence.runs[0]).toMatchObject({ command: "bun test", outcome: "unavailable" });
});

test("compound reads preserve explicit file operands and distinguish search scopes", () => {
  const command = "cat README.md src/a.ts; head -n 20 docs/guide.md; sed -n '5,10p' src/b.ts; rg -n 'fake.ts' packages/web";
  const evidence = adventureEvidence([stop("paths", "bash", command)], 0, lane);
  expect(evidence.read.map(file => file.path)).toEqual(["README.md", "src/a.ts", "docs/guide.md", "src/b.ts", "packages/web"]);
  expect(evidence.read.at(-1)).toMatchObject({ clue: "Search scope", resolvedPath: null });
});
test("search patterns, options and heredoc text never become file evidence", () => {
  const command = "rg -g '*.ts' -e 'fake.ts' src\npython3 - <<'PY'\ncat invented.ts\nPY\ncat actual.ts";
  const evidence = adventureEvidence([stop("safe", "bash", command)], 0, lane);
  expect(evidence.read.map(file => file.path)).toEqual(["src", "actual.ts"]);
});
