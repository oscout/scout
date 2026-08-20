/**
 * Deprecated re-export barrel for `packages/web/server/db-queries.ts`.
 *
 * Every query that used to live here now lives under `./db/` after SCO-031.
 * This file exists for one release as a back-compat shim so import sites can
 * migrate piecemeal; it is slated for deletion once the last consumer
 * imports directly from `./db/*` (SCO-031 §6 Phase D).
 *
 * Do NOT add new functions here. New domain code goes in the matching
 * `./db/<domain>.ts` file or `packages/runtime/src/repos/` if the surface is
 * an aggregate facade.
 */

export { closeDb, configureReadonlyDb } from "./db/internal/db.ts";

export type {
  WebActivityItem,
  WebAgent,
  WebAgentRun,
  WebBrokerDialogueItem,
  WebBrokerDiagnostics,
  WebBrokerRouteAttempt,
  WebFleetActivity,
  WebFleetAsk,
  WebFleetAskStatus,
  WebFleetAttentionItem,
  WebFleetState,
  WebFlight,
  WebFollowTarget,
  WebMeshOpsFlight,
  WebMeshOpsItem,
  WebMessage,
  WebWorkDetail,
  WebWorkItem,
  WebWorkTimelineItem,
  WebWorkTimelineKind,
} from "./db/types/web.ts";
export type {
  MobileAgentDetail,
  MobileAgentSummary,
  MobileSessionSummary,
  MobileWorkspaceSummary,
} from "./db/types/mobile.ts";
export type { HeartrateBucket } from "./db/types/common.ts";

export { queryAgentById, queryAgents } from "./db/agents.ts";
export { queryRecentMessages } from "./db/messages.ts";
export { queryActivity, queryHeartrate } from "./db/activity.ts";
export { queryBrokerDiagnostics } from "./db/broker.ts";
export {
  queryRuns,
  queryFlights,
  queryFlightRecordById,
  queryFollowTarget,
} from "./db/runs.ts";
export {
  queryWorkItemById,
  queryWorkItems,
} from "./db/work.ts";
export {
  MESH_OPS_DONE_RECENCY_MS,
  queryMeshOpsActiveFlightCount,
  queryMeshOpsItems,
  queryMeshOpsWorkRecord,
} from "./db/mesh-ops.ts";
export {
  queryFleet,
  queryFleetActivity,
  queryFleetAskRows,
  queryFleetAttentionRows,
} from "./db/fleet.ts";
export {
  queryMobileAgents,
  queryMobileAgentDetail,
} from "./db/mobile/agents.ts";
export { queryMobileSessions } from "./db/mobile/sessions.ts";
export { queryMobileWorkspaces } from "./db/mobile/workspaces.ts";
export {
  queryConversationDefinitionById,
  querySessions,
  querySessionById,
} from "./db/sessions.ts";
export {
  queryTerminalSessions,
} from "./db/terminal-sessions.ts";
export type {
  TerminalSessionListOptions,
} from "./db/terminal-sessions.ts";
