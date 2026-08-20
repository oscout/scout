import type { ScoutId } from "./common.js";

export const SCOUT_RENDEZVOUS_GENERATED_CODENAME_LENGTH = 6;
export const SCOUT_RENDEZVOUS_CODENAME_MAX_LENGTH = 32;
// Rooms stay joinable for hours so a human can relay the codename to the
// second session at their own pace; per-call long-polls stay short.
export const SCOUT_RENDEZVOUS_INVITE_TTL_MS = 4 * 60 * 60_000;
export const SCOUT_RENDEZVOUS_MAX_WAIT_MS = 10 * 60_000;

export type ScoutRendezvousCreateRequest = {
  action: "create";
  codename?: string;
  projectRoot: string;
  participantId: ScoutId;
};

export type ScoutRendezvousJoinRequest = {
  action: "join";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  waitMs?: number;
};

export type ScoutRendezvousRequest =
  | ScoutRendezvousCreateRequest
  | ScoutRendezvousJoinRequest;

export type ScoutRendezvousCreatedResponse = {
  status: "created";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  createdAt: number;
  expiresAt: number;
};

export type ScoutRendezvousWaitingResponse = {
  status: "waiting";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  joinedAt: number;
  expiresAt: number;
};

export type ScoutRendezvousMatchedResponse = {
  status: "matched";
  matchId: ScoutId;
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  participantIds: [ScoutId, ScoutId];
  peerParticipantIds: ScoutId[];
  createdAt: number;
  expiresAt: number;
};

export type ScoutRendezvousCodenameBusyResponse = {
  status: "codename_busy";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  participantCount: number;
  expiresAt: number;
  suggestion: "choose_another_codename";
};

export type ScoutRendezvousNotFoundResponse = {
  status: "not_found";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  suggestion: "check_codename_or_create";
};

export type ScoutRendezvousExpiredResponse = {
  status: "expired";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  expiresAt: number;
  suggestion: "choose_another_codename";
};

export type ScoutRendezvousConsumedResponse = {
  status: "consumed";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  expiresAt: number;
  suggestion: "choose_another_codename";
};

export type ScoutRendezvousProjectMismatchResponse = {
  status: "project_mismatch";
  codename: string;
  projectRoot: string;
  participantId: ScoutId;
  suggestion: "run_in_invitation_project";
};

export type ScoutRendezvousResponse =
  | ScoutRendezvousCreatedResponse
  | ScoutRendezvousWaitingResponse
  | ScoutRendezvousMatchedResponse
  | ScoutRendezvousCodenameBusyResponse
  | ScoutRendezvousNotFoundResponse
  | ScoutRendezvousExpiredResponse
  | ScoutRendezvousConsumedResponse
  | ScoutRendezvousProjectMismatchResponse;

export type ScoutRendezvousFailureResponse = Extract<
  ScoutRendezvousResponse,
  { status: "codename_busy" | "not_found" | "expired" | "consumed" | "project_mismatch" }
>;

export function isScoutRendezvousFailureResponse(
  response: ScoutRendezvousResponse,
): response is ScoutRendezvousFailureResponse {
  return response.status === "codename_busy"
    || response.status === "not_found"
    || response.status === "expired"
    || response.status === "consumed"
    || response.status === "project_mismatch";
}

export function normalizeScoutRendezvousCodename(codename: string): string {
  return codename.normalize("NFKC").trim().toLocaleUpperCase("en-US");
}

/**
 * Validates a human-chosen codename while retaining its display capitalization.
 * Case folding is only for broker lookup keys.
 */
export function validateScoutRendezvousCodename(codename: unknown): string {
  if (typeof codename !== "string") {
    throw new Error("codename must be a string");
  }
  const displayCodename = codename.normalize("NFKC").trim();
  if (!displayCodename) {
    throw new Error("codename must not be blank");
  }
  const normalized = normalizeScoutRendezvousCodename(displayCodename);
  if (
    normalized.length > SCOUT_RENDEZVOUS_CODENAME_MAX_LENGTH
    || !/^[A-Z0-9]+$/u.test(normalized)
  ) {
    throw new Error(
      `codename must be 1 to ${SCOUT_RENDEZVOUS_CODENAME_MAX_LENGTH} ASCII letters or digits`,
    );
  }
  return displayCodename;
}
