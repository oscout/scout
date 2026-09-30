import { expect, test } from "bun:test";
import { chatSessionApprovals } from "./chat-approval-association.ts";
import type { WebFlight } from "../shared/api/web.ts";
import type { NormalizedApprovalRequest } from "@openscout/agent-sessions/client";
const flight = { id: "flight", state: "waiting", sessions: [{ sessionId: "session", nodeId: "local", startedAt: 100, lastAcknowledgedAt: 101 }] } as WebFlight;
const approval = { sessionId: "session", turnId: "turn", blockId: "block", version: 2, actionStatus: "awaiting_approval", turnStartedAt: 110 } as NormalizedApprovalRequest;
test("only observed current-turn prompts from the exact local session are returned", () => {
  const result = chatSessionApprovals("flight", [flight], [approval, { ...approval, sessionId: "elsewhere" }, { ...approval, turnStartedAt: 99 }, { ...approval, turnStartedAt: undefined }], "local");
  expect(result).toEqual({ sessionId: "session", approvals: [approval] });
});
test("terminal, ended, remote, unknown, and concurrently shared sessions cannot be associated", () => {
  expect(chatSessionApprovals("missing", [flight], [approval], "local")).toBeNull();
  expect(chatSessionApprovals("flight", [{ ...flight, state: "completed" }], [approval], "local")).toBeNull();
  expect(chatSessionApprovals("flight", [{ ...flight, sessions: [{ ...flight.sessions[0]!, endedAt: 120 }] }], [approval], "local")).toBeNull();
  expect(chatSessionApprovals("flight", [flight], [approval], "remote")).toBeNull();
  expect(chatSessionApprovals("flight", [{ ...flight, sessions: [] }], [approval], "local")).toBeNull();
  expect(chatSessionApprovals("flight", [flight, { ...flight, id: "other" }], [approval], "local")).toBeNull();
});
