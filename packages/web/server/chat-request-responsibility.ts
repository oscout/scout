import type { CollaborationRecord } from "@openscout/protocol";

export function chatQuestionActions(record: CollaborationRecord, viewerActorId?: string): Array<"answer" | "close" | "reopen"> {
  if (record.kind !== "question" || !viewerActorId) return [];
  if (record.state === "open" && (record.nextMoveOwnerId ?? record.ownerId) === viewerActorId) return ["answer"];
  if (record.state === "answered" && (record.askedById ?? record.createdById) === viewerActorId
    && (!record.nextMoveOwnerId || record.nextMoveOwnerId === viewerActorId)) return ["close", "reopen"];
  return [];
}

/** Execution finishing does not necessarily settle a collaboration's next move. */
export function chatRequestResponsibility(
  record: CollaborationRecord | undefined,
  channelId: string,
  threadIds: ReadonlySet<string>,
  actorName: (id: string) => string,
  viewerActorId?: string,
) {
  if (!record?.conversationId || (record.conversationId !== channelId && !threadIds.has(record.conversationId))) return undefined;
  const terminal = record.kind === "question"
    ? record.state === "closed" || record.state === "declined"
    : record.state === "done" || record.state === "cancelled";
  const ownerId = terminal ? undefined : record.nextMoveOwnerId;
  return {
    recordId: record.id,
    updatedAt: record.updatedAt,
    actions: chatQuestionActions(record, viewerActorId),
    kind: record.kind,
    state: record.state,
    title: record.title,
    settled: terminal,
    ...(ownerId ? { actorId: ownerId, actorName: actorName(ownerId) } : {}),
    ...(record.kind === "work_item" && !terminal && record.waitingOn ? { waitingOn: record.waitingOn.label } : {}),
    ...(record.kind === "question" && record.answer ? { answer: record.answer } : {}),
  };
}
