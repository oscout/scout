import { expect, test } from "bun:test";
import { devinSessionTransport, externalSessionConnections, normalizeDevinSessionId, type ExternalSessionConnection } from "./external-session-transport.js";
const connection: ExternalSessionConnection = { id: "devin", ownerId: "owner", agentId: "agent", provider: "devin", organizationId: "org-test", tokenEnv: "DEVIN_TOKEN" };
test("Devin uses fixed origin and exact v3 session for inspect/send, with bounded auth", async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { calls.push([String(url), init]); return Response.json({ session_id: "devin-abcdef", status: "resuming" }); }) as typeof fetch;
  const transport = devinSessionTransport(connection, { DEVIN_TOKEN: "secret" }, fetcher);
  await transport.inspect("abcdef"); await transport.send("devin-abcdef", 'Do "this".');
  expect(calls[0]?.[0]).toBe("https://api.devin.ai/v3/organizations/org-test/sessions/devin-abcdef");
  expect(calls[1]?.[0]).toEndWith("/sessions/devin-abcdef/messages");
  expect(calls[1]?.[1]).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify({ message: 'Do "this".' }) });
  expect(calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});
test("transport distinguishes rejection from ambiguous POST and hides provider bodies", async () => {
  const transport = (response: () => Promise<Response>) => devinSessionTransport(connection, { DEVIN_TOKEN: "secret" }, response as typeof fetch);
  for (const status of [401, 403, 404, 429]) {
    await expect(transport(async () => new Response("secret server body", { status })).send("abcdef", "work")).rejects.toMatchObject({ uncertain: false, message: `devin_http_${status}` });
  }
  await expect(transport(async () => { throw new Error("secret"); }).send("abcdef", "work")).rejects.toMatchObject({ uncertain: true, message: "devin_transport_unconfirmed" });
  await expect(transport(async () => Response.json({ session_id: "devin-other1", status: "running" })).send("abcdef", "work")).rejects.toMatchObject({ uncertain: true, message: "devin_session_identity_mismatch" });
  await expect(devinSessionTransport(connection, {}).send("abcdef", "work")).rejects.toMatchObject({ uncertain: false, message: "external_session_credential_missing" });
});
test("configuration and native-id validation reject untrusted URLs and duplicate connections", () => {
  expect(() => normalizeDevinSessionId("https://attacker.test/session")).toThrow();
  expect(() => externalSessionConnections({ OPENSCOUT_EXTERNAL_SESSION_CONNECTIONS: JSON.stringify([connection, connection]) })).toThrow();
  expect(externalSessionConnections({})).toEqual([]);
});
