import { openControlPlaneSqliteDatabase } from "./sqlite-adapter.js";
import { join } from "node:path";
import { mkdir, chmod, writeFile, unlink } from "node:fs/promises";
import { createRoomListeningService, createRoomListeningHttpServer } from "./room-listening-service.js";
import { OPENSCOUT_PORTS, resolveBrokerControlUrl } from "./local-config.js";

process.title = "scout-listening";
const controlHome = process.env.OPENSCOUT_CONTROL_HOME ?? join(process.env.HOME ?? process.cwd(), ".openscout", "control-plane");
const port = Number(process.env.OPENSCOUT_LISTENING_PORT ?? OPENSCOUT_PORTS.roomListening);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid listening port");
const home = join(controlHome, "chat-listening");
await mkdir(home, { recursive: true, mode: 0o700 });
const lockPath = join(home, "owner.pid");
// A separate, service-private SQLite lock (NOT the broker database). OS locks
// release on crash; no stale-PID unlink race or process adoption. Never remove
// this file: an unlinked inode would allow two owners of the JSON store.
const ownerLockPath = join(home, "owner-lock.sqlite");
const ownerLock = openControlPlaneSqliteDatabase(ownerLockPath, { create: true });
await chmod(ownerLockPath, 0o600);
ownerLock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
await writeFile(lockPath, String(process.pid), { mode: 0o600 });
const service = createRoomListeningService({ controlHome, brokerUrl: process.env.OPENSCOUT_BROKER_URL ?? resolveBrokerControlUrl() });
let ready = false, closing = false;
const server = createRoomListeningHttpServer(service, () => ready);
async function shutdown(code: number) {
  if (closing) return;
  closing = true; ready = false;
  server.close();
  await service.stop();
  await unlink(lockPath).catch(() => undefined);
  ownerLock.close?.();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void shutdown(0); });
server.on("error", () => { void shutdown(1); });
server.listen(port, "127.0.0.1", async () => {
  try { await service.load(); service.start(); ready = true; console.log(`[scout-listening] loopback ${port}`); }
  catch { await shutdown(1); }
});
const parent = Number(process.env.OPENSCOUT_PARENT_PID ?? 0);
if (Number.isSafeInteger(parent) && parent > 0) setInterval(() => {
  try { process.kill(parent, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") void shutdown(0); }
}, 2000).unref();
