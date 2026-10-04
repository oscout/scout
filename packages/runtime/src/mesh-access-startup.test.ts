import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, chmodSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectAccessDirectories, removeLocalAdminEnvironment, requireProtectedAccessState } from "./mesh-access-startup.js";

test("policy database independently requires protected mode and owner-only state; children inherit no admin key path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "access-startup-")), dbPath = join(dir, "control.sqlite"), support = join(dir, "different-support");
  try {
    const db = new Database(dbPath); db.exec("CREATE TABLE mesh_access_policies(network_id TEXT); INSERT INTO mesh_access_policies VALUES('installed')"); db.close();
    expect(() => requireProtectedAccessState(dbPath, false)).toThrow("requires protected");
    expect(() => requireProtectedAccessState(dbPath, true)).not.toThrow();
    chmodSync(dbPath, 0o600); protectAccessDirectories(dir, support, dbPath);
    chmodSync(support, 0o750); expect(() => protectAccessDirectories(dir, support, dbPath)).toThrow("owner-only"); chmodSync(support, 0o700);
    chmodSync(dbPath, 0o644); expect(() => protectAccessDirectories(dir, support, dbPath)).toThrow("owner-only");
    const env = { ...process.env, OPENSCOUT_LOCAL_ADMIN_KEY_FILE: "/never/inherit", OPENSCOUT_LOCAL_ADMIN_DERIVED: "never-inherit" };
    removeLocalAdminEnvironment(env);
    const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith('OPENSCOUT_LOCAL_ADMIN'))))"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("[]"); expect(await child.exited).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP handlers consume gate classification and never derive operator authority from raw socket addresses", () => {
  for (const path of ["broker-http-router.ts", "broker-access-http-routes.ts", "broker-guest-http-routes.ts", "broker-mesh-http-service.ts", "broker-request-context.ts"]) {
    let source: string;
    try { source = readFileSync(join(import.meta.dir, path), "utf8"); } catch { continue; }
    expect(source).not.toMatch(/request\.socket|req\.socket|\.socket\?\.remoteAddress|socket\.remoteAddress/);
  }
});
