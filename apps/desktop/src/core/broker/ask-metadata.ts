import type {
  ScoutAskSenderContext,
  ScoutAskWorkspace,
} from "./ask-types.ts";

export type ScoutAskMetadataInput = {
  source: string;
  workRecordId?: string;
  senderContext?: ScoutAskSenderContext;
  workspace?: ScoutAskWorkspace;
  labels?: string[];
};

export type ScoutAskMetadata = {
  source: string;
  collaborationRecordId?: string;
  workId?: string;
  senderContext?: ScoutAskSenderContext;
  askWorkspace?: ScoutAskWorkspace;
  labels?: string[];
};

export function buildScoutAskMetadata(
  input: ScoutAskMetadataInput,
): ScoutAskMetadata {
  return {
    source: input.source,
    ...(input.workRecordId
      ? {
          collaborationRecordId: input.workRecordId,
          workId: input.workRecordId,
        }
      : {}),
    ...(input.senderContext ? { senderContext: input.senderContext } : {}),
    ...(input.workspace ? { askWorkspace: input.workspace } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
  };
}
