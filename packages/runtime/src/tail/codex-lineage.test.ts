import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSource } from "./codex-source.js";
const original = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT;
const roots: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT;
  else process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = original;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture(payload: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "scout-codex-lineage-")); roots.push(root);
  process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = root;
  writeFileSync(join(root, "rollout-child.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "child", cwd: "/repo", ...payload } }) + "\n");
}
test("discovers current Codex child metadata on fresh and cached scans", () => {
  fixture({ parent_thread_id: "parent", agent_nickname: "Kant" });
  for (let index = 0; index < 2; index++) expect(CodexSource.discoverTranscripts([])[0]).toMatchObject({ sessionId: "child", parentSessionId: "parent", subagentId: "child", agentNickname: "Kant" });
});
test("discovers legacy nested spawn metadata", () => {
  fixture({ source: { sub_agent: { thread_spawn: { parent_thread_id: "parent", agent_nickname: "Ada" } } } });
  expect(CodexSource.discoverTranscripts([])[0]).toMatchObject({ parentSessionId: "parent", subagentId: "child", agentNickname: "Ada" });
});
test("ordinary fork is not a child affiliation", () => {
  fixture({ forked_from_id: "parent" });
  expect(CodexSource.discoverTranscripts([])[0]).toMatchObject({ parentSessionId: null, subagentId: null, agentNickname: null });
});
test("self parent does not create a child affiliation", () => {
  fixture({ parent_thread_id: "child", agent_nickname: "Kant" });
  expect(CodexSource.discoverTranscripts([])[0]).toMatchObject({ parentSessionId: null, subagentId: null, agentNickname: null });
});
