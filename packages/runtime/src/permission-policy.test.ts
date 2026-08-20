import { describe, expect, test } from "bun:test";

import { compileCodexPermissionProfile } from "./permission-policy.js";

describe("permission policy", () => {
  test("keeps legacy Codex posture unless a profile is requested", () => {
    expect(compileCodexPermissionProfile(undefined)).toMatchObject({
      profile: "trusted_local",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      enforcement: "native",
    });
  });

  test("compiles Scout profiles into native Codex thread parameters", () => {
    expect(compileCodexPermissionProfile("observe")).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
      enforcement: "native",
    });
    expect(compileCodexPermissionProfile("workspace_write")).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      enforcement: "native",
    });
  });
});
