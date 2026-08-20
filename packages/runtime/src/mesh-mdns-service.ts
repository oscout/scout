// Mesh trust cone P1 presence (docs/proposals/mesh-trust-cone.md §2).
//
// Advertises the mesh node as `_openscout._tcp` via mDNS, but ONLY while the
// broker is actually dialable off-loopback — a loopback-bound broker must not
// announce itself (P1 keeps the broker loopback-bound by default; the bind
// flip lands in P1.5).
//
// The TXT record is deliberately compact — a full JSON card is a poor TXT
// payload: protocol version, key-ID digest (first 16 bytes), port. Peers fetch
// the full signed card via `GET /v1/node` and verify it against the TXT
// digest. Browse support discovers sibling nodes and excludes self by key-ID
// digest.
//
// Ownership lessons inherited from `_oscout-pair._tcp`
// (packages/web/server/pairing-lan-beacon.ts): the advert lifetime is tied to
// the owning process, start/stop are idempotent, and everything injectable so
// tests never need a live mDNS responder. The cross-process duplicate-advert
// claim dance is intentionally NOT copied: mesh nodes on the same Mac are
// distinct worktrees with distinct ports, and mDNS renames colliding instance
// names rather than breaking them.

import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";

import { isLoopbackHost } from "./broker-process-manager.js";
import type { RuntimeEnv } from "./portable-types.js";

/** Service type, per the trust-cone proposal: `_openscout._tcp`. */
export const MESH_MDNS_SERVICE_TYPE = "openscout";
/** Mesh wire-protocol version advertised in the TXT record. */
export const MESH_MDNS_PROTOCOL_VERSION = 1;
/** First 16 bytes of the SHA-256 key ID, as hex — 32 chars. */
export const MESH_MDNS_KEY_ID_DIGEST_HEX_CHARS = 32;

const require = createRequire(import.meta.url);

export type MdnsPublishOptions = {
  name: string;
  /** Stable DNS host used by user-space responders that publish A/AAAA records. */
  host?: string;
  type: string;
  protocol: "tcp" | "udp";
  port: number;
  txt: Record<string, string>;
};

/** A discovered `_openscout._tcp` instance as reported by the browser. */
export type MdnsAdvertisement = {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
};

export type MdnsPublishedHandle = {
  stop(callback?: () => void): void;
  /** Native publishers use this to report an advertisement that has died. */
  onFailure?(listener: (error: Error) => void): void;
};

export type MdnsBrowserHandle = {
  on(event: "up" | "down", listener: (service: MdnsAdvertisement) => void): unknown;
  stop(): void;
};

/** Structural surface of a `bonjour-service` instance — injectable for tests. */
export type MdnsResponder = {
  publish(options: MdnsPublishOptions): MdnsPublishedHandle;
  unpublishAll(callback?: () => void): void;
  find(
    options: { type: string; protocol: "tcp" | "udp" },
    onup?: (service: MdnsAdvertisement) => void,
  ): MdnsBrowserHandle;
  destroy(callback?: () => void): void;
};

export type MdnsResponderFactory = () => MdnsResponder;

type ProcessExitEvents = Pick<NodeJS.Process, "once" | "off">;

/** Arguments for Apple's native `dns-sd -R` service registration. */
export function buildDarwinDnsSdRegisterArgs(options: MdnsPublishOptions): string[] {
  return [
    "-R",
    options.name,
    `_${options.type}._${options.protocol}`,
    "local.",
    String(options.port),
    ...Object.entries(options.txt).map(([key, value]) => `${key}=${value}`),
  ];
}

/**
 * On macOS, registration must go through mDNSResponder. Running a second
 * user-space authority on UDP/5353 makes both responders claim the Mac's host
 * A/AAAA records, which causes macOS to resolve the conflict by repeatedly
 * renaming LocalHostName. Browsing is safe to keep in-process because it does
 * not publish authoritative host records.
 */
export function createDarwinMdnsResponder(
  browserResponder: MdnsResponder,
  spawnProcess: typeof spawn = spawn,
  logger: Pick<Console, "warn"> = console,
  processEvents: ProcessExitEvents = process,
): MdnsResponder {
  const registrations = new Set<ChildProcess>();

  const stopRegistration = (child: ChildProcess): void => {
    registrations.delete(child);
    if (child.killed) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Best effort: process shutdown must not throw.
    }
  };

  const stopAll = (): void => {
    for (const child of registrations) stopRegistration(child);
  };

  processEvents.once("exit", stopAll);

  return {
    publish(options) {
      let diagnosticOutput = "";
      let failure: Error | null = null;
      const failureListeners = new Set<(error: Error) => void>();
      const child = spawnProcess("/usr/bin/dns-sd", buildDarwinDnsSdRegisterArgs(options), {
        argv0: "openscout-mesh-mdns",
        stdio: ["ignore", "pipe", "pipe"],
      });
      registrations.add(child);

      const appendDiagnostic = (chunk: Buffer | string): void => {
        diagnosticOutput = `${diagnosticOutput}${String(chunk)}`.slice(-4_096);
      };
      child.stdout?.on("data", appendDiagnostic);
      child.stderr?.on("data", appendDiagnostic);

      const reportFailure = (error: Error): void => {
        if (failure) return;
        failure = error;
        registrations.delete(child);
        logger.warn(`[mesh-mdns] native registration failed: ${error.message}`);
        for (const listener of failureListeners) listener(error);
        failureListeners.clear();
      };

      child.once("exit", (code, signal) => {
        if (!registrations.has(child)) return;
        const detail = code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
        const diagnostic = diagnosticOutput.trim();
        reportFailure(new Error(`${detail}${diagnostic ? `: ${diagnostic}` : ""}`));
      });
      child.once("error", reportFailure);

      return {
        stop(callback) {
          failureListeners.clear();
          stopRegistration(child);
          callback?.();
        },
        onFailure(listener) {
          if (failure) {
            listener(failure);
          } else {
            failureListeners.add(listener);
          }
        },
      };
    },
    unpublishAll(callback) {
      stopAll();
      callback?.();
    },
    find(options, onup) {
      return browserResponder.find(options, onup);
    },
    destroy(callback) {
      stopAll();
      processEvents.off("exit", stopAll);
      browserResponder.destroy(callback);
    },
  };
}

export function selectMdnsResponderForPlatform(
  browserResponder: MdnsResponder,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
  logger: Pick<Console, "warn"> = console,
  processEvents: ProcessExitEvents = process,
): MdnsResponder {
  return platform === "darwin"
    ? createDarwinMdnsResponder(browserResponder, spawnProcess, logger, processEvents)
    : browserResponder;
}

function defaultResponderFactory(logger: Pick<Console, "warn"> = console): MdnsResponder {
  // bonjour-service is CommonJS (`export =`), so it is loaded via createRequire
  // like the other CJS deps in this package.
  const Bonjour = require("bonjour-service") as new () => MdnsResponder;
  const responder = new Bonjour();
  return selectMdnsResponderForPlatform(responder, process.platform, spawn, logger, process);
}

/** Key-ID digest carried in the TXT record: first 16 bytes, lowercase hex. */
export function meshMdnsKeyIdDigest(keyId: string): string {
  const normalized = keyId.trim().toLowerCase();
  if (!/^[0-9a-f]{32,}$/.test(normalized)) {
    throw new Error(`mesh mDNS key ID must be at least 32 hex chars, got ${keyId.length}`);
  }
  return normalized.slice(0, MESH_MDNS_KEY_ID_DIGEST_HEX_CHARS);
}

/**
 * Compact TXT payload: protocol version, key-ID digest, port.
 * P1.5 (§11.4): additive `tls=1` when the node serves non-loopback TLS —
 * `v=` is NOT bumped; absence of the key is non-definitive (card is
 * authoritative).
 */
export function buildMeshMdnsTxt(options: {
  keyId: string;
  port: number;
  protocolVersion?: number | string;
  /** When true, add `tls=1` without bumping v= */
  tls?: boolean;
}): Record<string, string> {
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65_535) {
    throw new Error(`mesh mDNS port must be an integer in 1..65535, got ${options.port}`);
  }
  const txt: Record<string, string> = {
    v: String(options.protocolVersion ?? MESH_MDNS_PROTOCOL_VERSION),
    kid: meshMdnsKeyIdDigest(options.keyId),
    port: String(options.port),
  };
  if (options.tls) {
    txt.tls = "1";
  }
  return txt;
}

/** A discovered mesh peer, normalized from a raw mDNS advertisement. */
export type MeshMdnsPeer = {
  name: string;
  host: string | null;
  addresses: string[];
  port: number | null;
  /** Key-ID digest from the TXT record (32 hex chars), null when malformed. */
  kid: string | null;
  /** Protocol version from the TXT record, null when absent/malformed. */
  protocolVersion: string | null;
  txt: Record<string, string>;
};

export type MeshMdnsStartOptions = {
  port: number;
  /** Full key ID (SHA-256 hex of the DER public key, from node-identity). */
  keyId: string;
  protocolVersion?: number | string;
  /** mDNS instance name; display-only, never used for trust. */
  name?: string;
  /** §11.4: advertise tls=1 when non-loopback TLS listeners are active */
  tls?: boolean;
};

export type MeshMdnsBrowseOptions = {
  onPeerFound?: (peer: MeshMdnsPeer) => void;
  onPeerLost?: (peer: MeshMdnsPeer) => void;
};

export type MeshMdnsServiceOptions = {
  responderFactory?: MdnsResponderFactory;
  logger?: Pick<Console, "log" | "warn">;
};

/**
 * Publishes and browses `_openscout._tcp` on behalf of one broker process.
 * start()/stop() are idempotent; stop() unpublishes, stops the browser, and
 * destroys the responder. Advertisement is the caller's decision — this class
 * publishes whatever start() is asked to publish; use `wireMeshMdns` for the
 * dialability gating.
 */
export class MeshMdnsService {
  private responder: MdnsResponder | null = null;
  private published: MdnsPublishedHandle | null = null;
  private browser: MdnsBrowserHandle | null = null;
  private ownKidDigest: string | null = null;

  constructor(private readonly options: MeshMdnsServiceOptions = {}) {}

  get isAdvertising(): boolean {
    return this.published !== null;
  }

  start(options: MeshMdnsStartOptions): void {
    this.ownKidDigest = meshMdnsKeyIdDigest(options.keyId);
    if (this.published) {
      return;
    }
    const responder = this.ensureResponder();
    const published = responder.publish({
      name: options.name ?? `OpenScout Node ${this.ownKidDigest.slice(0, 8)}`,
      // bonjour-service otherwise defaults to os.hostname() and publishes A/AAAA
      // records for it. A key-derived host avoids competing with the OS-owned
      // hostname on platforms where the user-space publisher is retained.
      host: `openscout-${this.ownKidDigest}.local`,
      type: MESH_MDNS_SERVICE_TYPE,
      protocol: "tcp",
      port: options.port,
      txt: buildMeshMdnsTxt(options),
    });
    this.published = published;
    published.onFailure?.(() => {
      if (this.published === published) this.published = null;
    });
  }

  startBrowse(options: MeshMdnsBrowseOptions = {}): void {
    if (this.browser) {
      return;
    }
    const responder = this.ensureResponder();
    const browser = responder.find({ type: MESH_MDNS_SERVICE_TYPE, protocol: "tcp" });
    browser.on("up", (service) => {
      const peer = normalizeAdvertisement(service);
      if (this.isSelf(peer)) return;
      options.onPeerFound?.(peer);
    });
    browser.on("down", (service) => {
      const peer = normalizeAdvertisement(service);
      if (this.isSelf(peer)) return;
      options.onPeerLost?.(peer);
    });
    this.browser = browser;
  }

  stop(): void {
    if (this.browser) {
      try {
        this.browser.stop();
      } catch {
        // best effort — shutdown must not throw
      }
      this.browser = null;
    }
    const responder = this.responder;
    this.responder = null;
    this.published = null;
    if (responder) {
      try {
        responder.unpublishAll();
      } catch {
        // best effort
      }
      try {
        responder.destroy();
      } catch {
        // best effort
      }
    }
  }

  private ensureResponder(): MdnsResponder {
    if (!this.responder) {
      this.responder = this.options.responderFactory
        ? this.options.responderFactory()
        : defaultResponderFactory(this.options.logger);
    }
    return this.responder;
  }

  /** Self-exclusion: a discovered instance is us iff its TXT digest matches. */
  private isSelf(peer: MeshMdnsPeer): boolean {
    return this.ownKidDigest !== null && peer.kid === this.ownKidDigest;
  }
}

/** Normalize a raw browser advertisement; TXT values are coerced to strings. */
export function normalizeAdvertisement(service: MdnsAdvertisement): MeshMdnsPeer {
  const txt = normalizeTxt(service.txt);
  const kid = txt.kid?.toLowerCase() ?? null;
  return {
    name: service.name ?? "",
    host: service.host ?? null,
    addresses: service.addresses ?? [],
    port: typeof service.port === "number" ? service.port : null,
    kid: kid && /^[0-9a-f]{32}$/.test(kid) ? kid : null,
    protocolVersion: txt.v ?? null,
    txt,
  };
}

function normalizeTxt(txt: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!txt) return out;
  for (const [key, value] of Object.entries(txt)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value);
    } else if (value instanceof Uint8Array) {
      out[key] = Buffer.from(value).toString("utf8");
    }
  }
  return out;
}

export type WireMeshMdnsOptions = {
  /** Host the broker actually bound — the dialability signal. */
  host: string;
  port: number;
  keyId: string;
  protocolVersion?: number | string;
  env?: RuntimeEnv;
  onPeerFound?: (peer: MeshMdnsPeer) => void;
  onPeerLost?: (peer: MeshMdnsPeer) => void;
  responderFactory?: MdnsResponderFactory;
  logger?: Pick<Console, "log" | "warn">;
};

/**
 * Laptop toggle (proposal §2): `OPENSCOUT_MDNS_ENABLED=0` opts the node out of
 * mDNS advertisement AND browse. The route gate is unaffected.
 */
export function meshMdnsEnabled(env: RuntimeEnv = process.env): boolean {
  const raw = (env.OPENSCOUT_MDNS_ENABLED ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * The daemon-side seam: start advertising + browsing when the broker is
 * dialable off-loopback, else stand down entirely. Returns null in the
 * stand-down cases so the caller has nothing to stop. The returned service's
 * stop() must be called from the daemon shutdown path.
 */
export function wireMeshMdns(options: WireMeshMdnsOptions): MeshMdnsService | null {
  const logger = options.logger;
  if (!meshMdnsEnabled(options.env)) {
    logger?.log("[openscout-runtime] mesh mDNS disabled via OPENSCOUT_MDNS_ENABLED");
    return null;
  }
  if (isLoopbackHost(options.host)) {
    // Per the proposal: never advertise a loopback-only broker — peers could
    // not reach it. The browse half also stands down with the advert: there
    // is no mesh dial path while the broker is loopback-bound.
    return null;
  }
  const service = new MeshMdnsService({
    responderFactory: options.responderFactory,
    logger,
  });
  try {
    service.start({
      port: options.port,
      keyId: options.keyId,
      protocolVersion: options.protocolVersion,
    });
    service.startBrowse({
      onPeerFound: options.onPeerFound,
      onPeerLost: options.onPeerLost,
    });
  } catch (error) {
    service.stop();
    throw error;
  }
  logger?.log(`[openscout-runtime] mesh mDNS advertising _openscout._tcp on port ${options.port}`);
  return service;
}
