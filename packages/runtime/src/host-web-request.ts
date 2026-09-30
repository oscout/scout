/** Native host context RPC: exact read/launch operations, never arbitrary URLs. */
export interface HostWebRequest {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
}
export interface HostWebResponse { status: number; body: unknown; binary?: { data: string; contentType: string } }

export function isAllowedHostWebRequest(input: unknown): input is HostWebRequest {
  if (!input || typeof input !== "object") return false;
  const { path, method } = input as Partial<HostWebRequest>;
  if (typeof path !== "string" || !path.startsWith("/api/") || /[\\\\#]|%2[fFeE]|%5[cC]/i.test(path)) return false;
  const url = new URL(path, "http://localhost");
  if (url.pathname !== path.split("?")[0]) return false;
  if (method === "GET") return /^\/api\/(runner\/options|comms|conversations|agents|messages|flights|blobs\/[^/]+|conversations\/[^/]+\/read-cursors|agents\/[^/]+\/observe)$/.test(url.pathname);
  return method === "POST" && /^\/api\/(sessions|send|blobs|conversations\/[^/]+\/read-cursor)$/.test(url.pathname);
}
