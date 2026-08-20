import { randomBytes } from "node:crypto";

export const SCOUT_WEB_HANDOFF_COOKIE = "scout_handoff";
const WEB_HANDOFF_TTL_MS = 5 * 60 * 1000;

export type WebHandoffScope =
  | { kind: "session"; sessionId: string }
  | {
      kind: "file_change";
      sessionId: string;
      turnId: string;
      blockId: string;
    };

type WebHandoffRecord = {
  token: string;
  deviceId: string | null;
  expiresAt: number;
  scope: WebHandoffScope;
};

const activeWebHandoffs = new Map<string, WebHandoffRecord>();

function pruneExpiredWebHandoffs(now = Date.now()): void {
  for (const [token, record] of activeWebHandoffs) {
    if (record.expiresAt <= now) {
      activeWebHandoffs.delete(token);
    }
  }
}

function scopesMatch(left: WebHandoffScope, right: WebHandoffScope): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.sessionId !== right.sessionId) {
    return false;
  }
  switch (left.kind) {
    case "session":
      return true;
    case "file_change":
      return right.kind === "file_change" && left.turnId === right.turnId && left.blockId === right.blockId;
  }
}

export function pathForWebHandoffScope(scope: WebHandoffScope): string {
  switch (scope.kind) {
    case "session":
      return `/handoff/session/${encodeURIComponent(scope.sessionId)}`;
    case "file_change":
      return `/handoff/file-change/${encodeURIComponent(scope.sessionId)}/${encodeURIComponent(scope.turnId)}/${encodeURIComponent(scope.blockId)}`;
  }
}

export function issueWebHandoff(scope: WebHandoffScope, deviceId?: string | null): {
  token: string;
  expiresAt: number;
  scope: WebHandoffScope;
} {
  pruneExpiredWebHandoffs();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + WEB_HANDOFF_TTL_MS;
  activeWebHandoffs.set(token, {
    token,
    deviceId: deviceId?.trim() || null,
    expiresAt,
    scope,
  });
  return { token, expiresAt, scope };
}

export function readAuthorizedWebHandoff(
  token: string | null | undefined,
  scope: WebHandoffScope,
): WebHandoffRecord | null {
  pruneExpiredWebHandoffs();
  if (!token) {
    return null;
  }
  const record = activeWebHandoffs.get(token);
  if (!record) {
    return null;
  }
  if (!scopesMatch(record.scope, scope)) {
    return null;
  }
  return record;
}
