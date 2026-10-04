/** Isolated scoped gateway; never mount this on the ambient Scout web server.
 * No operator MAC key, ordinary web routes, terminal, proxy or child process.
 *
 * Setup as a dedicated non-root OS user, distinct from the broker and EVERY
 * harness agent. Create its own 0700 directory; all config/key files are 0600.
 * Password helper reads stdin only (prefer a secret manager, never argv):
 *   bun server/scoped-access/index.ts hash-password
 *   bun server/scoped-access/index.ts --config /private/gateway/config.json
 *
 * Example (replace all IDs, paths and hashes):
 * {"privateDirectory":".","isolation":{"gatewayUid":502,"brokerUid":501,
 *   "agentUids":[503]},"origin":"https://access.example.test:43210",
 *  "tls":{"certFile":"./cert.pem","keyFile":"./key.pem"},
 *  "brokerUrl":"https://broker.example.test:43110",
 *  "audience":"<broker Ed25519 key ID>","tlsPin":"<verified SPKI SHA256>",
 *  "sessionTtlSeconds":3600,"idleTtlSeconds":900,
 *  "users":[{"login":"admin","passwordHash":"<hash-password output>",
 *  "deviceFile":"./device.json","delegationFile":"./delegation.json",
 *  "principalFile":"./admin-identity.json"}]}
 *
 * origin MUST use a dedicated HTTPS hostname, never localhost, an IP, the
 * ambient *.scout.local host, or a hostname shared with another web service.
 * Cookies ignore ports. TLS is required even when binding loopback (default).
 * Non-loopback broker URLs require an explicit SPKI pin plus signed node-card
 * audience verification; only a broker loopback URL may use plaintext HTTP.
 *
 * principalFile is optional. NEVER configure a root/owner signing key or an
 * operator HMAC key: root custody is refused. Membership changes are forwarded
 * only as already CLI-signed policies. Admin signing may grant to other members;
 * no self-grants. Delegations may only narrow this user's configured authority.
 * Each user needs a distinct principal/device. Compromise of this OS user exposes
 * all configured users' device and optional principal authority. The OS UID
 * declarations are operator attestations; the process cannot enumerate all
 * future agents. Deploy those accounts and filesystem ownership separately.
 *
 * Build dist/access-client first. Browser holds only a bounded HttpOnly Secure
 * session and synchronizer CSRF token, including during login. Every signing
 * action requires an exact public preview plus fresh password confirmation.
 * Password/config changes require restart. Credentials reload every operation;
 * the broker rechecks revocation and permissions on each scoped request.
 */
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { GatewayError, hashGatewayPassword, loadGatewayConfig } from "./config.ts";
import { createScopedAccessGateway } from "./server.ts";
import { createGatewayBroker } from "./broker-client.ts";
import { createGatewayManage } from "./manage.ts";

export function gatewayStaticRoot(entryUrl = import.meta.url): string {
  const directory = dirname(fileURLToPath(entryUrl));
  return basename(directory) === "scoped-access" && basename(dirname(directory)) === "server"
    ? resolve(directory, "../../dist/access-client") : resolve(directory, "access-client");
}

export async function startScopedAccessGateway(configPath: string) {
  const config = loadGatewayConfig(configPath), broker = createGatewayBroker(config);
  const staticRoot = gatewayStaticRoot();
  const gateway = createScopedAccessGateway(config, { staticRoot, broker, manage: createGatewayManage(config, broker) });
  const url = new URL(config.origin);
  const server = Bun.serve({
    hostname: config.listenHost, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    ...(config.tls ? { tls: config.tls } : {}), maxRequestBodySize: 262144, idleTimeout: 15,
    fetch: (request, server) => gateway.fetch(request, server.requestIP(request)?.address ?? "unknown"),
    error: () => Response.json({ error: "gateway_request_failed" }, { status: 500, headers: { "cache-control": "no-store" } }),
  });
  return { server, close: () => { server.stop(true); gateway.close(); } };
}
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "hash-password") {
      const reader = Bun.stdin.stream().getReader(); let input = "";
      try {
        while (true) { const item = await reader.read(); if (item.done) break; input += Buffer.from(item.value).toString("utf8"); if (Buffer.byteLength(input) > 1026) throw new GatewayError(400, "password_too_large"); }
      } finally { await reader.cancel().catch(() => {}); }
      console.log(await hashGatewayPassword(input.replace(/\r?\n$/, "")));
    } else if (args.length === 2 && args[0] === "--config" && args[1]) {
      const running = await startScopedAccessGateway(resolve(args[1]));
      console.log("Scoped access gateway listening.");
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { running.close(); process.exit(0); });
    } else throw new GatewayError(400, "usage: hash-password (stdin) or --config private-file");
  } catch (error) {
    console.error(error instanceof GatewayError ? error.code : "gateway_startup_failed");
    process.exitCode = 1;
  }
}
