import { expect, test } from "bun:test";
import { parseIntegrationCommand } from "./integration.ts";

test("setup uses the working project and preserves explicit selectors", () => {
  expect(parseIntegrationCommand(["setup", "slack", "--agent", "alpha", "--workspace", "T123"], "/work/alpha")).toEqual({
    path: "/v1/integrations/setup", body: { provider: "slack", mode: "project_agent", projectPath: "/work/alpha", agentId: "alpha", workspaceId: "T123" },
  });
});
test("rejects unknown/token options and ambiguous resume actions before network IO", () => {
  expect(() => parseIntegrationCommand(["setup", "slack", "--bot-token", "secret"], "/work")).toThrow("Unknown");
  expect(() => parseIntegrationCommand(["resume", "op", "--if-revision", "2", "--workspace", "T123", "--app", "A123"], "/work")).toThrow("exactly one");
  expect(() => parseIntegrationCommand(["resume", "op", "--if-revision", "2oops", "--app", "A123"], "/work")).toThrow("positive integer");
});
test("authority attestation requires an explicit dedicated flag", () => {
  expect(() => parseIntegrationCommand(["resume", "op", "--if-revision", "1"], "/work")).toThrow("exactly one");
  expect(parseIntegrationCommand(["resume", "op", "--if-revision", "1", "--confirm-workspace-authority"], "/work").body).toEqual({ action: "confirm_authority", expectedRevision: 1 });
});

test("credential attachment passes references and explicit admission policy", () => {
  expect(parseIntegrationCommand(["credentials", "op", "--if-revision", "3", "--app-token-key", "APP_KEY", "--bot-token-key", "BOT_KEY", "--allowed-users", "U1,U2", "--allowed-channels", "C1"], "/work")).toEqual({ path: "/v1/integrations/setup/op/credentials", body: {
    expectedRevision: 3, reference: { backend: "secret_cli", appTokenKey: "APP_KEY", botTokenKey: "BOT_KEY" }, allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C1"],
  } });
  expect(() => parseIntegrationCommand(["credentials", "op", "--if-revision", "3", "--app-token-key", "APP_KEY", "--bot-token-key", "BOT_KEY"], "/work")).toThrow("explicit allowed-user");
});

test("credential file backend is explicit and unknown backends fail before IO", () => {
  const args = ["credentials", "operation", "--if-revision", "1", "--app-token-key", "APP", "--bot-token-key", "BOT", "--allowed-users", "U123", "--credential-backend"];
  expect(parseIntegrationCommand([...args, "private_file"], "/repo").body).toMatchObject({ reference: { backend: "private_file" } });
  expect(() => parseIntegrationCommand([...args, "untrusted"], "/repo")).toThrow("backend");
});

 test("verify checks evidence at the current revision without manual pass flags", () => {
  expect(parseIntegrationCommand(["verify", "op", "--if-revision", "5"], "/repo")).toEqual({ path: "/v1/integrations/setup/op/verify", body: { expectedRevision: 5 } });
  expect(() => parseIntegrationCommand(["verify", "op", "--verified", "true"], "/repo")).toThrow();
});

test("credential rotation is explicit and carries only replacement entry names", () => {
  const parsed = parseIntegrationCommand(["rotate-credentials", "op", "--if-revision", "6", "--app-token-key", "NEW_APP", "--bot-token-key", "NEW_BOT", "--allowed-users", "U123", "--credential-backend", "private_file"], "/repo");
  expect(parsed.body).toMatchObject({ expectedRevision: 6, rotate: true, reference: { backend: "private_file", appTokenKey: "NEW_APP", botTokenKey: "NEW_BOT" } });
});

test("rebind requires an explicit project and revision", () => {
  expect(parseIntegrationCommand(["rebind", "op", "--project", "../beta", "--if-revision", "6"], "/work/alpha")).toEqual({ path: "/v1/integrations/setup/op/rebind", body: { expectedRevision: 6, projectPath: "/work/beta" } });
  expect(() => parseIntegrationCommand(["rebind", "op", "--if-revision", "6"], "/work/alpha")).toThrow();
});
