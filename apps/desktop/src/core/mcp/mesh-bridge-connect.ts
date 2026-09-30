import { createHash, randomBytes } from "node:crypto";

/**
 * The CLI half of self-serve bridge provisioning: a loopback callback server,
 * a PKCE pair, a browser hop to the gateway's connect page, and the code
 * exchange for an `osbr_` bridge credential. The gateway half lives in
 * apps/mesh-front-door/src/mcp-bridge-connect.ts.
 */
export const MESH_BRIDGE_CREDENTIAL_KEYCHAIN_SERVICE = "OPENSCOUT_MCP_BRIDGE_CREDENTIAL";

const CONNECT_TIMEOUT_MS = 10 * 60_000;

export interface MeshBridgeConnectResult {
  credential: string;
  credentialId: string;
  node: string;
  account: string;
}

export interface MeshBridgeConnectOptions {
  relayUrl: string;
  node: string;
  label: string | null;
  /** Show the connect URL to the person (and usually open it). */
  openUrl: (url: string) => void | Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function closePage(title: string, detail: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>`
      + `<body style="font-family:-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem">`
      + `<h1 style="font-size:1.3rem">${title}</h1><p>${detail}</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function connectMeshBridge(options: MeshBridgeConnectOptions): Promise<MeshBridgeConnectResult> {
  const doFetch = options.fetch ?? fetch;
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));

  let settle!: (value: { code: string } | { error: string }) => void;
  const callback = new Promise<{ code: string } | { error: string }>((resolve) => {
    settle = resolve;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      // Another tab or program hitting the port must not end the flow.
      if (url.searchParams.get("state") !== state) return new Response("State mismatch", { status: 400 });
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        settle({ error: error ?? "no code returned" });
        return closePage("Not connected", "You can close this tab and return to the terminal.");
      }
      settle({ code });
      return closePage("Mac connected", "You can close this tab and return to the terminal.");
    },
  });

  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    const connectUrl = new URL("/v1/mcp/bridge/connect", options.relayUrl);
    connectUrl.searchParams.set("redirect_uri", redirectUri);
    connectUrl.searchParams.set("state", state);
    connectUrl.searchParams.set("code_challenge", challenge);
    connectUrl.searchParams.set("code_challenge_method", "S256");
    connectUrl.searchParams.set("node", options.node);
    if (options.label) connectUrl.searchParams.set("label", options.label);
    await options.openUrl(connectUrl.toString());

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      callback,
      new Promise<{ error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ error: "timed out waiting for approval in the browser" }), options.timeoutMs ?? CONNECT_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if ("error" in outcome) {
      throw new Error(outcome.error === "access_denied" ? "the connection was cancelled in the browser" : outcome.error);
    }

    const response = await doFetch(new URL("/v1/mcp/bridge/token", options.relayUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: outcome.code, code_verifier: verifier, redirect_uri: redirectUri }),
    });
    const body = await response.json().catch(() => ({})) as {
      credential?: string;
      id?: string;
      node?: string;
      account?: string;
      error?: string;
      detail?: string;
    };
    if (response.status !== 201 || !body.credential?.startsWith("osbr_")) {
      throw new Error(`the gateway refused the exchange: ${body.detail ?? body.error ?? `HTTP ${response.status}`}`);
    }
    return {
      credential: body.credential,
      credentialId: body.id ?? "",
      node: body.node ?? options.node,
      account: body.account ?? "",
    };
  } finally {
    server.stop(true);
  }
}

/** Revoke a self-serve credential at the gateway. Shared operator tokens are left alone. */
export async function revokeMeshBridgeCredential(relayUrl: string, credential: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  if (!credential.startsWith("osbr_")) return false;
  const response = await doFetch(new URL("/v1/mcp/bridge/credential", relayUrl), {
    method: "DELETE",
    headers: { authorization: `Bearer ${credential}` },
  });
  return response.ok || response.status === 401;
}

/**
 * `security -i` reads its command from stdin, which keeps the credential out
 * of the process list. The credential is hex after a fixed prefix, so it
 * needs no quoting beyond the surrounding double quotes.
 */
export function storeKeychainSecret(service: string, secret: string): boolean {
  if (!/^[A-Za-z0-9_]+$/.test(secret) || !/^[A-Za-z0-9_.-]+$/.test(service)) return false;
  const result = Bun.spawnSync(["security", "-i"], {
    stdin: new TextEncoder().encode(`add-generic-password -U -a openscout -s ${service} -w "${secret}"\n`),
  });
  return result.exitCode === 0;
}

export function deleteKeychainSecret(service: string): void {
  Bun.spawnSync(["security", "delete-generic-password", "-a", "openscout", "-s", service]);
}
