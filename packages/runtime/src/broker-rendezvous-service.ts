import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  SCOUT_RENDEZVOUS_GENERATED_CODENAME_LENGTH,
  SCOUT_RENDEZVOUS_INVITE_TTL_MS,
  SCOUT_RENDEZVOUS_MAX_WAIT_MS,
  normalizeScoutRendezvousCodename,
  parseScoutComposerRouteTarget,
  validateScoutRendezvousCodename,
  type ScoutRendezvousCreatedResponse,
  type ScoutRendezvousExpiredResponse,
  type ScoutRendezvousMatchedResponse,
  type ScoutRendezvousRequest,
  type ScoutRendezvousResponse,
  type ScoutRendezvousWaitingResponse,
} from "@openscout/protocol";

const RENDEZVOUS_CODENAME_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_CODENAME_GENERATION_ATTEMPTS = 16;
const DEFAULT_MATCH_TTL_MS = 120_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 1_000;

type RendezvousPresence = {
  participantId: string;
  projectRoot: string;
  codename: string;
  normalizedCodename: string;
  joinedAt: number;
  expiresAt: number;
};

type RendezvousMatch = {
  id: string;
  projectRoot: string;
  codename: string;
  normalizedCodename: string;
  participantIds: [string, string];
  createdAt: number;
  expiresAt: number;
};

type RendezvousExpiredInvite = {
  projectRoot: string;
  codename: string;
  normalizedCodename: string;
  inviteExpiresAt: number;
  retainUntil: number;
};

type RendezvousWaiter = {
  participantId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: ScoutRendezvousResponse) => void;
};

export type BrokerRendezvousServiceOptions = {
  now?: () => number;
  createMatchId?: () => string;
  createInviteCodename?: () => string;
  presenceTtlMs?: number;
  matchTtlMs?: number;
  cleanupIntervalMs?: number;
};

export class BrokerRendezvousService {
  private readonly now: () => number;
  private readonly createMatchId: () => string;
  private readonly createInviteCodename: () => string;
  private readonly presenceTtlMs: number;
  private readonly matchTtlMs: number;
  private readonly presences = new Map<string, RendezvousPresence>();
  private readonly matches = new Map<string, RendezvousMatch>();
  private readonly expiredInvites = new Map<string, RendezvousExpiredInvite>();
  private readonly waiters = new Map<string, Set<RendezvousWaiter>>();
  private readonly cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(options: BrokerRendezvousServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createMatchId = options.createMatchId ?? (() => `match_${randomUUID()}`);
    this.createInviteCodename = options.createInviteCodename ?? createRandomInviteCodename;
    this.presenceTtlMs = positiveDuration(
      options.presenceTtlMs,
      SCOUT_RENDEZVOUS_INVITE_TTL_MS,
      "presenceTtlMs",
    );
    this.matchTtlMs = positiveDuration(
      options.matchTtlMs,
      DEFAULT_MATCH_TTL_MS,
      "matchTtlMs",
    );
    const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = cleanupIntervalMs > 0
      ? setInterval(() => this.cleanupExpired(), cleanupIntervalMs)
      : null;
    this.cleanupTimer?.unref?.();
  }

  async match(request: ScoutRendezvousRequest): Promise<ScoutRendezvousResponse> {
    const input = validateRequest(request);
    this.cleanupExpired();
    if (input.action === "create") {
      return this.create(input.projectRoot, input.participantId, input.codename);
    }

    const key = rendezvousKey(input.projectRoot, input.normalizedCodename);
    const now = this.now();
    const activeMatch = this.matches.get(key);

    if (activeMatch) {
      if (!activeMatch.participantIds.includes(input.participantId)) {
        return {
          status: "codename_busy",
          codename: activeMatch.codename,
          projectRoot: activeMatch.projectRoot,
          participantId: input.participantId,
          participantCount: activeMatch.participantIds.length,
          expiresAt: activeMatch.expiresAt,
          suggestion: "choose_another_codename",
        };
      }
      return consumedResponse(activeMatch, input.participantId);
    }

    const presence = this.presences.get(key);
    if (presence && presence.participantId !== input.participantId) {
      const match: RendezvousMatch = {
        id: this.createMatchId(),
        projectRoot: presence.projectRoot,
        codename: presence.codename,
        normalizedCodename: presence.normalizedCodename,
        participantIds: [presence.participantId, input.participantId],
        createdAt: now,
        expiresAt: now + this.matchTtlMs,
      };
      this.presences.delete(key);
      this.matches.set(key, match);
      this.resolveMatchedWaiters(key, match);
      return matchedResponse(match, input.participantId);
    }

    if (!presence) {
      const expiredInvite = this.expiredInvites.get(key);
      if (expiredInvite) {
        return expiredResponse(expiredInvite, input.participantId);
      }
      if (this.hasCodenameInAnotherProject(input.projectRoot, input.normalizedCodename)) {
        return projectMismatchResponse(input);
      }
      return {
        status: "not_found",
        codename: input.codename,
        projectRoot: input.projectRoot,
        participantId: input.participantId,
        suggestion: "check_codename_or_create",
      };
    }

    if (input.waitMs === 0) {
      return waitingResponse(presence);
    }
    return await this.waitForMatch(key, presence, input.waitMs);
  }

  private create(
    projectRoot: string,
    participantId: string,
    requestedCodename: string | null,
  ): ScoutRendezvousResponse {
    const now = this.now();
    if (requestedCodename) {
      const normalizedCodename = normalizeScoutRendezvousCodename(requestedCodename);
      const key = rendezvousKey(projectRoot, normalizedCodename);
      const activeMatch = this.matches.get(key);
      if (activeMatch) {
        if (activeMatch.participantIds.includes(participantId)) {
          return consumedResponse(activeMatch, participantId);
        }
        return {
          status: "codename_busy",
          codename: activeMatch.codename,
          projectRoot,
          participantId,
          participantCount: activeMatch.participantIds.length,
          expiresAt: activeMatch.expiresAt,
          suggestion: "choose_another_codename",
        };
      }
      const presence = this.presences.get(key);
      if (presence) {
        return {
          status: "codename_busy",
          codename: presence.codename,
          projectRoot,
          participantId,
          participantCount: 1,
          expiresAt: presence.expiresAt,
          suggestion: "choose_another_codename",
        };
      }
      // The tombstone only exists so a late joiner gets a clean "expired"
      // answer; an explicit re-create supersedes it immediately.
      this.expiredInvites.delete(key);
      return this.createPresence(
        projectRoot,
        participantId,
        requestedCodename,
        normalizedCodename,
        now,
      );
    }

    for (let attempt = 0; attempt < MAX_CODENAME_GENERATION_ATTEMPTS; attempt += 1) {
      const codename = validateScoutRendezvousCodename(this.createInviteCodename());
      const normalizedCodename = normalizeScoutRendezvousCodename(codename);
      const key = rendezvousKey(projectRoot, normalizedCodename);
      if (
        this.presences.has(key)
        || this.matches.has(key)
        || this.expiredInvites.has(key)
      ) continue;
      return this.createPresence(
        projectRoot,
        participantId,
        codename,
        normalizedCodename,
        now,
      );
    }
    throw new Error("could not allocate a unique match codename");
  }

  private createPresence(
    projectRoot: string,
    participantId: string,
    codename: string,
    normalizedCodename: string,
    now: number,
  ): ScoutRendezvousCreatedResponse {
    const presence: RendezvousPresence = {
      participantId,
      projectRoot,
      codename,
      normalizedCodename,
      joinedAt: now,
      expiresAt: now + this.presenceTtlMs,
    };
    this.presences.set(rendezvousKey(projectRoot, normalizedCodename), presence);
    return {
      status: "created",
      codename,
      projectRoot,
      participantId,
      createdAt: now,
      expiresAt: presence.expiresAt,
    };
  }

  private hasCodenameInAnotherProject(
    projectRoot: string,
    normalizedCodename: string,
  ): boolean {
    return [
      ...this.presences.values(),
      ...this.matches.values(),
      ...this.expiredInvites.values(),
    ].some((record) =>
      record.normalizedCodename === normalizedCodename
      && record.projectRoot !== projectRoot
    );
  }

  cleanupExpired(): void {
    const now = this.now();
    for (const [key, presence] of this.presences) {
      if (presence.expiresAt > now) continue;
      this.presences.delete(key);
      const expiredInvite = this.recordExpiredInvite(presence);
      this.resolveExpiredWaiters(key, expiredInvite);
    }
    for (const [key, match] of this.matches) {
      if (match.expiresAt > now) continue;
      this.matches.delete(key);
    }
    for (const [key, expiredInvite] of this.expiredInvites) {
      if (expiredInvite.retainUntil > now) continue;
      this.expiredInvites.delete(key);
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    for (const [key, presence] of this.presences) {
      this.resolveExpiredWaiters(key, this.recordExpiredInvite(presence));
    }
    this.presences.clear();
    this.matches.clear();
    this.expiredInvites.clear();
  }

  private waitForMatch(
    key: string,
    presence: RendezvousPresence,
    waitMs: number,
  ): Promise<ScoutRendezvousResponse> {
    return new Promise((resolveWait) => {
      const waitDuration = Math.min(
        waitMs,
        Math.max(0, presence.expiresAt - this.now()),
      );
      const waiter: RendezvousWaiter = {
        participantId: presence.participantId,
        resolve: resolveWait,
        timer: setTimeout(() => {
          this.removeWaiter(key, waiter);
          const currentPresence = this.presences.get(key);
          if (currentPresence && currentPresence.expiresAt <= this.now()) {
            this.presences.delete(key);
            const expiredInvite = this.recordExpiredInvite(currentPresence);
            this.resolveExpiredWaiters(key, expiredInvite);
            resolveWait(expiredResponse(expiredInvite, waiter.participantId));
            return;
          }
          if (currentPresence) {
            resolveWait(waitingResponse(currentPresence));
            return;
          }
          const expiredInvite = this.expiredInvites.get(key);
          if (expiredInvite) {
            resolveWait(expiredResponse(expiredInvite, waiter.participantId));
            return;
          }
          resolveWait(notFoundResponse(presence, waiter.participantId));
        }, waitDuration),
      };
      waiter.timer.unref?.();
      const keyedWaiters = this.waiters.get(key) ?? new Set<RendezvousWaiter>();
      keyedWaiters.add(waiter);
      this.waiters.set(key, keyedWaiters);
    });
  }

  private resolveMatchedWaiters(key: string, match: RendezvousMatch): void {
    const keyedWaiters = this.waiters.get(key);
    if (!keyedWaiters) return;
    this.waiters.delete(key);
    for (const waiter of keyedWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(matchedResponse(match, waiter.participantId));
    }
  }

  private resolveExpiredWaiters(
    key: string,
    expiredInvite: RendezvousExpiredInvite,
  ): void {
    const keyedWaiters = this.waiters.get(key);
    if (!keyedWaiters) return;
    this.waiters.delete(key);
    for (const waiter of keyedWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(expiredResponse(expiredInvite, waiter.participantId));
    }
  }

  private recordExpiredInvite(presence: RendezvousPresence): RendezvousExpiredInvite {
    const expiredInvite: RendezvousExpiredInvite = {
      projectRoot: presence.projectRoot,
      codename: presence.codename,
      normalizedCodename: presence.normalizedCodename,
      inviteExpiresAt: presence.expiresAt,
      retainUntil: this.now() + this.matchTtlMs,
    };
    this.expiredInvites.set(
      rendezvousKey(presence.projectRoot, presence.normalizedCodename),
      expiredInvite,
    );
    return expiredInvite;
  }

  private removeWaiter(key: string, waiter: RendezvousWaiter): void {
    const keyedWaiters = this.waiters.get(key);
    if (!keyedWaiters) return;
    keyedWaiters.delete(waiter);
    if (keyedWaiters.size === 0) {
      this.waiters.delete(key);
    }
  }
}

type ValidatedRendezvousRequest =
  | {
      action: "create";
      codename: string | null;
      projectRoot: string;
      participantId: string;
      waitMs: 0;
    }
  | {
      action: "join";
      codename: string;
      normalizedCodename: string;
      projectRoot: string;
      participantId: string;
      waitMs: number;
    };

function validateRequest(request: ScoutRendezvousRequest): ValidatedRendezvousRequest {
  if (!request || typeof request !== "object") {
    throw new Error("rendezvous request must be an object");
  }
  if (request.action !== "create" && request.action !== "join") {
    throw new Error("action must be create or join");
  }
  const participantId = sessionParticipantId(request.participantId);
  const rawProjectRoot = requiredField(request.projectRoot, "projectRoot");
  if (rawProjectRoot.includes("\0")) {
    throw new Error("projectRoot must not contain NUL");
  }
  const waitMs = request.action === "join"
    ? request.waitMs ?? SCOUT_RENDEZVOUS_MAX_WAIT_MS
    : 0;
  if (
    !Number.isInteger(waitMs)
    || waitMs < 0
    || waitMs > SCOUT_RENDEZVOUS_MAX_WAIT_MS
  ) {
    throw new Error(
      `waitMs must be an integer between 0 and ${SCOUT_RENDEZVOUS_MAX_WAIT_MS}`,
    );
  }
  const projectRoot = resolve(rawProjectRoot);
  if (request.action === "create") {
    return {
      action: "create",
      codename: request.codename === undefined
        ? null
        : validateScoutRendezvousCodename(request.codename),
      projectRoot,
      participantId,
      waitMs: 0,
    };
  }
  const codename = validateScoutRendezvousCodename(request.codename);
  return {
    action: "join",
    codename,
    normalizedCodename: normalizeScoutRendezvousCodename(codename),
    projectRoot,
    participantId,
    waitMs,
  };
}

function requiredField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return value.trim();
}

function sessionParticipantId(value: unknown): string {
  const participantId = requiredField(value, "participantId");
  const target = parseScoutComposerRouteTarget(participantId);
  if (target?.kind !== "session_id" || !target.value) {
    throw new Error("participantId must be an exact session:<id> address");
  }
  return target.value;
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return duration;
}

function createRandomInviteCodename(): string {
  return Array.from(
    { length: SCOUT_RENDEZVOUS_GENERATED_CODENAME_LENGTH },
    () => RENDEZVOUS_CODENAME_ALPHABET[randomInt(RENDEZVOUS_CODENAME_ALPHABET.length)],
  ).join("");
}

function rendezvousKey(projectRoot: string, normalizedCodename: string): string {
  return `${projectRoot}\0${normalizedCodename}`;
}

function waitingResponse(presence: RendezvousPresence): ScoutRendezvousWaitingResponse {
  return {
    status: "waiting",
    codename: presence.codename,
    projectRoot: presence.projectRoot,
    participantId: presence.participantId,
    joinedAt: presence.joinedAt,
    expiresAt: presence.expiresAt,
  };
}

function matchedResponse(
  match: RendezvousMatch,
  participantId: string,
): ScoutRendezvousMatchedResponse {
  return {
    status: "matched",
    matchId: match.id,
    codename: match.codename,
    projectRoot: match.projectRoot,
    participantId,
    participantIds: match.participantIds,
    peerParticipantIds: match.participantIds.filter((id) => id !== participantId),
    createdAt: match.createdAt,
    expiresAt: match.expiresAt,
  };
}

function consumedResponse(
  match: RendezvousMatch,
  participantId: string,
): ScoutRendezvousResponse {
  return {
    status: "consumed",
    codename: match.codename,
    projectRoot: match.projectRoot,
    participantId,
    expiresAt: match.expiresAt,
    suggestion: "choose_another_codename",
  };
}

function expiredResponse(
  expiredInvite: RendezvousExpiredInvite,
  participantId: string,
): ScoutRendezvousExpiredResponse {
  return {
    status: "expired",
    codename: expiredInvite.codename,
    projectRoot: expiredInvite.projectRoot,
    participantId,
    expiresAt: expiredInvite.inviteExpiresAt,
    suggestion: "choose_another_codename",
  };
}

function projectMismatchResponse(
  input: Extract<ValidatedRendezvousRequest, { action: "join" }>,
): ScoutRendezvousResponse {
  return {
    status: "project_mismatch",
    codename: input.codename,
    projectRoot: input.projectRoot,
    participantId: input.participantId,
    suggestion: "run_in_invitation_project",
  };
}

function notFoundResponse(
  presence: RendezvousPresence,
  participantId: string,
): ScoutRendezvousResponse {
  return {
    status: "not_found",
    codename: presence.codename,
    projectRoot: presence.projectRoot,
    participantId,
    suggestion: "check_codename_or_create",
  };
}
