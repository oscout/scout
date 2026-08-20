import { createHash } from "crypto";

export class InvalidMobileTerminalSessionError extends Error {
  constructor(message = "Invalid mobile terminal session name") {
    super(message);
    this.name = "InvalidMobileTerminalSessionError";
  }
}

/** A readable device class plus a short signature of the per-install SSH key. */
export function mobileTerminalSessionName(
  sshPublicKey: string,
  deviceClass: string | undefined,
): string {
  const normalizedClass = normalizeMobileTerminalDeviceClass(deviceClass);
  const signature = createHash("sha256")
    .update(sshPublicKey.trim())
    .digest("hex")
    .slice(0, 8);
  return `scout-${normalizedClass}-${signature}`;
}

/** Missing deviceClass means a legacy client that will still attach `scout`. */
export function provisionedMobileTerminalSessionName(
  sshPublicKey: string,
  deviceClass: string | undefined,
): string {
  return deviceClass === undefined
    ? "scout"
    : mobileTerminalSessionName(sshPublicKey, deviceClass);
}

function normalizeMobileTerminalDeviceClass(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^(?:iphone|ipad)(?:-sim)?$/.test(normalized)
    ? normalized
    : "ios";
}

export function validatedMobileTerminalSessionName(value: string | undefined): string {
  const normalized = value?.trim() || "scout";
  if (normalized === "scout" || /^scout-(?:ios|iphone|ipad)(?:-sim)?-[a-f0-9]{8}$/.test(normalized)) {
    return normalized;
  }
  throw new InvalidMobileTerminalSessionError();
}

/** Allow status metadata only for the session provisioned to this paired peer. */
export function authorizedMobileTerminalSessionName(
  requestedSessionName: string | undefined,
  provisionedSessionName: string | undefined,
): string {
  const requested = validatedMobileTerminalSessionName(requestedSessionName);
  const provisioned = validatedMobileTerminalSessionName(provisionedSessionName);
  if (requested !== provisioned) {
    throw new InvalidMobileTerminalSessionError(
      "Mobile terminal session is not provisioned for this paired device",
    );
  }
  return requested;
}
