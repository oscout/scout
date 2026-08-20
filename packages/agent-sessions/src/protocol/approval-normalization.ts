import type { ActionBlock, Session } from "./primitives.js";
import type { SessionState } from "../state.js";

export type NormalizedApprovalRisk = "low" | "medium" | "high";

export type NormalizedApprovalRequest = {
  sessionId: string;
  sessionName: string;
  adapterType: string;
  turnId: string;
  blockId: string;
  version: number;
  risk: NormalizedApprovalRisk;
  title: string;
  description: string;
  detail: string | null;
  actionKind: ActionBlock["action"]["kind"];
  actionStatus: ActionBlock["action"]["status"];
};

function defaultApprovalTitle(block: ActionBlock): string {
  switch (block.action.kind) {
    case "command":
      return "Approve Command";
    case "file_change":
      return "Approve File Change";
    case "tool_call":
      return "Approve Tool Call";
    case "subagent":
      return "Approve Subagent";
  }
}

function defaultApprovalDetail(block: ActionBlock): string | null {
  switch (block.action.kind) {
    case "command":
      return block.action.command?.trim() || null;
    case "file_change":
      return block.action.path?.trim() || null;
    case "tool_call":
      return block.action.toolName?.trim() || null;
    case "subagent":
      return block.action.agentName?.trim() || block.action.agentId?.trim() || null;
  }
}

export function normalizeApprovalRequest(
  session: Session,
  turnId: string,
  block: ActionBlock,
): NormalizedApprovalRequest | null {
  if (block.action.status !== "awaiting_approval" || !block.action.approval) {
    return null;
  }

  const title = defaultApprovalTitle(block);
  const detail = defaultApprovalDetail(block);
  const description = block.action.approval.description?.trim() || detail || title;

  return {
    sessionId: session.id,
    sessionName: session.name,
    adapterType: session.adapterType,
    turnId,
    blockId: block.id,
    version: block.action.approval.version,
    risk: block.action.approval.risk ?? "medium",
    title,
    description,
    detail,
    actionKind: block.action.kind,
    actionStatus: block.action.status,
  };
}

export function extractPendingApprovalRequests(snapshot: SessionState): NormalizedApprovalRequest[] {
  const approvals: NormalizedApprovalRequest[] = [];

  for (const turn of snapshot.turns) {
    for (const blockState of turn.blocks) {
      if (blockState.block.type !== "action") {
        continue;
      }

      const approval = normalizeApprovalRequest(snapshot.session, turn.id, blockState.block);
      if (approval) {
        approvals.push(approval);
      }
    }
  }

  return approvals;
}
