import { expect, test } from "bun:test";
import { isAllowedHostWebRequest } from "./host-web-request.js";
import { BrokerWebControlService } from "./broker-web-control-service.js";

test("host requests admit only native read and launch operations", () => {
  for (const path of ["/api/runner/options", "/api/comms", "/api/messages?conversationId=c.remote", "/api/agents/a.remote/observe"]) {
    expect(isAllowedHostWebRequest({ path, method: "GET" })).toBe(true);
  }
  for (const path of ["/api/sessions", "/api/send", "/api/blobs", "/api/conversations/c.remote/read-cursor"]) {
    expect(isAllowedHostWebRequest({ path, method: "POST" })).toBe(true);
  }
  for (const path of ["https://other/api/send", "//other/api/send", "/api/../api/send", "/api/%2e%2e/send", "/api/hosts/other/api/send", "/api/user", "/api/terminal/run", "/api/send#fragment"]) {
    expect(isAllowedHostWebRequest({ path, method: "POST" })).toBe(false);
  }
  expect(isAllowedHostWebRequest({ path: "/api/sessions", method: "DELETE" })).toBe(false);
});

test("host RPC uses only the destination broker's local web credential", async () => {
  const requests: Request[] = [];
  const service = new BrokerWebControlService({
    brokerControlUrl: "http://127.0.0.1:43110", resolveWebPort: () => 43120,
    env: { OPENSCOUT_WEB_AUTH_TOKEN: "destination-secret" },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      expect(request.headers.get("authorization")).toBe("Bearer destination-secret");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.url).toBe("http://127.0.0.1:43120/api/sessions");
      return Response.json({ conversationId: "c.remote" }, { status: 201 });
    }) as typeof fetch,
  });
  const body = { target: { projectPath: "/remote/project" }, seed: { clientMessageId: "stable-retry" } };
  const response = await service.requestForHost({ path: "/api/sessions", method: "POST", body });
  expect(response).toEqual({ status: 201, body: { conversationId: "c.remote" } });
  expect(await requests[0].json()).toEqual(body);
  expect((await service.requestForHost({ path: "/api/user", method: "POST" })).status).toBe(400);
  expect(requests).toHaveLength(1);
});

test("destination web failure returns a retryable error without another request", async () => {
  let calls = 0;
  const service = new BrokerWebControlService({
    brokerControlUrl: "http://127.0.0.1:43110", env: { OPENSCOUT_WEB_AUTH_TOKEN: "test" },
    fetch: (async () => { calls += 1; throw new Error("offline"); }) as typeof fetch,
  });
  expect((await service.requestForHost({ path: "/api/sessions", method: "POST" })).status).toBe(502);
  expect(calls).toBe(1);
});

test("remote attachment reads preserve bytes without sharing a web session", async () => {
  const service = new BrokerWebControlService({
    brokerControlUrl: "http://127.0.0.1:43110", env: { OPENSCOUT_WEB_AUTH_TOKEN: "test" },
    fetch: (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })) as typeof fetch,
  });
  expect(await service.requestForHost({ path: "/api/blobs/blob-one", method: "GET" })).toEqual({
    status: 200, body: null, binary: { data: "AQID", contentType: "image/png" },
  });
});
