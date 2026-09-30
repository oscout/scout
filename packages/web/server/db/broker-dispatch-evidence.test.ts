import { describe, expect, test } from "bun:test";
import { dispatchEvidenceFromPayload } from "./broker.ts";

describe("dispatchEvidenceFromPayload", () => {
  test("surfaces the structured reason a dispatch stopped", () => {
    expect(dispatchEvidenceFromPayload(JSON.stringify({
      kind: "unknown",
      askedLabel: "session:codex:01a0e90f",
      sessionWakeReason: "session_live_fork_unsupported",
      detail: "codex session is open in another Codex app",
    }))).toEqual({ sessionWakeReason: "session_live_fork_unsupported" });
  });

  test("keeps unavailable targets and candidate counts", () => {
    expect(dispatchEvidenceFromPayload(JSON.stringify({
      kind: "unavailable",
      target: { agentId: "vox", reason: "manual_wake_required" },
      candidates: [{ agentId: "vox" }, { agentId: "vox-2" }],
      diagnosticCode: "ambiguous_alias_scope",
    }))).toEqual({
      diagnosticCode: "ambiguous_alias_scope",
      unavailableReason: "manual_wake_required",
      unavailableAgentId: "vox",
      candidateCount: 2,
    });
  });

  test("tolerates missing or malformed payloads", () => {
    expect(dispatchEvidenceFromPayload(null)).toEqual({});
    expect(dispatchEvidenceFromPayload("{not json")).toEqual({});
    expect(dispatchEvidenceFromPayload(JSON.stringify({ sessionWakeReason: "  " }))).toEqual({});
  });
});
