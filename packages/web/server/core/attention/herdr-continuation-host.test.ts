import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { grantFilePolicyFor, resolveHerdrContinuationHooks } from "./herdr-continuation-host.ts";

const injected = {
  sendKeys: async () => {},
  policyFor: () => ({ level: "workspace" as const, source: "injected" }),
  audit: () => {},
  claim: () => true,
};

describe("resolveHerdrContinuationHooks", () => {
  test("inside the test runner, injected hooks are honored", () => {
    expect(resolveHerdrContinuationHooks(injected)?.policyFor).toBe(injected.policyFor);
  });

  test("false disables; nothing injected under the test runner is disabled", () => {
    expect(resolveHerdrContinuationHooks(false)).toBeNull();
    expect(resolveHerdrContinuationHooks(undefined)).toBeNull();
  });

  test("outside the test runner, injected authority is replaced by the grant file", async () => {
    // A plain script (not *.test.ts) under NODE_ENV=production.
    const hostModule = join(import.meta.dir, "herdr-continuation-host.ts");
    const script = `
      import { resolveHerdrContinuationHooks, grantFilePolicyFor } from ${JSON.stringify(hostModule)};
      import { appendContinuationAudit, claimContinuationActuation } from "@openscout/runtime";
      const hooks = resolveHerdrContinuationHooks({
        sendKeys: async () => {},
        policyFor: () => ({ level: "workspace", source: "injected" }),
        audit: () => {},
        claim: () => true,
      });
      const fallback = resolveHerdrContinuationHooks(undefined);
      console.log(JSON.stringify({
        policy: hooks.policyFor === grantFilePolicyFor,
        audit: hooks.audit === appendContinuationAudit,
        claim: hooks.claim === claimContinuationActuation,
        fallback: fallback?.policyFor === grantFilePolicyFor,
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toEqual({
      policy: true,
      audit: true,
      claim: true,
      fallback: true,
    });
  });
});
