import { expect, test } from "bun:test";
import { Hono } from "hono";
import { installScoutApiMiddleware, scoutApiPerfReport } from "./server-core.ts";

test("invitation bearer capabilities do not appear in API diagnostics", async () => {
  const app = new Hono();
  installScoutApiMiddleware(app, "invite-test", {
    authToken: "test-operator",
    resolvePeerAddress: () => "127.0.0.1",
    memberAccess: (_request, method, path) => method === "GET" && path.startsWith("/api/invites/"),
  });
  app.get("/api/invites/:token", (c) => c.json({ ok: true }));
  const capability = "private-invitation-capability-fixture";
  const response = await app.request(`http://localhost/api/invites/${capability}`);
  expect(response.status).toBe(200);
  expect(JSON.stringify(scoutApiPerfReport())).not.toContain(capability);
});
