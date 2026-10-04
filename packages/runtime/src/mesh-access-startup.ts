import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { openControlPlaneSqliteDatabase } from "./sqlite-adapter.js";

/** Read state independently of support-directory markers and SQLite feature flags. */
export function requireProtectedAccessState(dbPath: string, protectedMode: boolean): void {
  if (!existsSync(dbPath)) return;
  const db = openControlPlaneSqliteDatabase(dbPath, { readonly: true });
  try {
    const installed = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mesh_access_policies'").get();
    if (installed && db.query("SELECT 1 FROM mesh_access_policies LIMIT 1").get() && !protectedMode)
      throw new Error("scoped policy state requires protected local ingress");
  } finally { db.close?.(); }
}
export function protectAccessDirectories(controlHome: string, supportDirectory: string, dbPath: string): void {
  for (const directory of [controlHome, supportDirectory]) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("protected broker requires owner-only control and support directories");
  }
  for (const path of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("protected broker requires owner-only control database files");
  }
}
/** Remove once before any broker-owned child is launched. No derived secret is an env value. */
export function removeLocalAdminEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) if (key.startsWith("OPENSCOUT_LOCAL_ADMIN")) delete env[key];
}
