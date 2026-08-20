import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { defineProbeFamily, type ProbeCtx } from "./registry.js";
import { execProbeFile, ProbeCommandError } from "./exec.js";

export type CertStatus = {
  certPath: string;
  exists: boolean;
  validAtLeast24h: boolean;
  issuer: string | null;
  subject: string | null;
  publiclyTrusted: boolean;
};

function canonicalCertPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof ProbeCommandError
    && (error.code === "ENOENT" || error.code === "spawn" || error.code === "exit");
}

export const certStatusProbe = defineProbeFamily<string, CertStatus>({
  id: "cert.status",
  ttlMs: 5 * 60_000,
  timeoutMs: 5_000,
  maxKeys: 64,
  idleKeyTtlMs: 30 * 60_000,
  maxConcurrentKeys: 2,
  normalizeKey: canonicalCertPath,
  run: async (certPath, ctx: ProbeCtx) => {
    if (!existsSync(certPath)) {
      return {
        certPath,
        exists: false,
        validAtLeast24h: false,
        issuer: null,
        subject: null,
        publiclyTrusted: false,
      };
    }

    let validAtLeast24h = false;
    try {
      await execProbeFile(ctx, "openssl", ["x509", "-in", certPath, "-noout", "-checkend", "86400"], {
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      validAtLeast24h = true;
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
    }

    let issuer: string | null = null;
    let subject: string | null = null;
    try {
      const { stdout } = await execProbeFile(ctx, "openssl", ["x509", "-in", certPath, "-noout", "-issuer", "-subject"], {
        maxStdoutBytes: 128 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      issuer = stdout.match(/^issuer=(.*)$/m)?.[1]?.trim() || null;
      subject = stdout.match(/^subject=(.*)$/m)?.[1]?.trim() || null;
    } catch (error) {
      if (!isUnavailable(error)) {
        throw error;
      }
    }

    return {
      certPath,
      exists: true,
      validAtLeast24h,
      issuer,
      subject,
      publiclyTrusted: Boolean(validAtLeast24h && issuer && subject && issuer !== subject),
    };
  },
});

export async function readCertStatus(certPath: string, maxAgeMs = 5 * 60_000): Promise<CertStatus | null> {
  const snapshot = await certStatusProbe.for(certPath).fresh({ maxAgeMs });
  return snapshot.value ?? null;
}
