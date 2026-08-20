import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assertTestIsolatedUserData,
  resolveOpenScoutSupportPaths,
} from "@openscout/runtime";

import type { MeshEnrollmentHandshake } from "./trust-service.ts";

/**
 * Pending initiator-side enrollment, persisted between
 * `scout mesh enroll <url>` (handshake + show words) and
 * `scout mesh enroll --confirm-sas <words>` (grant). This is operator
 * convenience state, not a trust root — the grant only lands after the words
 * comparison and the broker re-verifies the card material.
 */

const PENDING_FILE = "mesh-enroll-pending.json";

export function pendingMeshEnrollmentPath(supportDirectory?: string): string {
  const dir = supportDirectory ?? resolveOpenScoutSupportPaths().supportDirectory;
  return join(dir, PENDING_FILE);
}

export function savePendingMeshEnrollment(
  handshake: MeshEnrollmentHandshake,
  supportDirectory?: string,
): void {
  if (!supportDirectory) {
    assertTestIsolatedUserData("write the pending mesh enrollment", "OPENSCOUT_SUPPORT_DIRECTORY");
  }
  const path = pendingMeshEnrollmentPath(supportDirectory);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(handshake, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function loadPendingMeshEnrollment(
  supportDirectory?: string,
): MeshEnrollmentHandshake | null {
  const path = pendingMeshEnrollmentPath(supportDirectory);
  if (!existsSync(path)) {
    return null;
  }
  let parsed: MeshEnrollmentHandshake;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as MeshEnrollmentHandshake;
  } catch {
    throw new Error(`Corrupt pending mesh enrollment at ${path}; remove it and start over.`);
  }
  if (parsed.version !== 1 || !parsed.enrollmentId || !Array.isArray(parsed.words)) {
    throw new Error(`Corrupt pending mesh enrollment at ${path}; remove it and start over.`);
  }
  return parsed;
}

export function clearPendingMeshEnrollment(supportDirectory?: string): void {
  const path = pendingMeshEnrollmentPath(supportDirectory);
  if (existsSync(path)) {
    rmSync(path);
  }
}
