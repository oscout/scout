import { db } from "./internal/db.ts";
/** Cheap cross-writer invalidation, including durable edits/deletions/reactions.
 * Conservative: an unrelated database write may invalidate a channel too. */
export function inboxDatabaseRevision(read: typeof db = db): number | null {
  try { return (read().query("PRAGMA data_version").get() as { data_version: number }).data_version; }
  catch { return null; }
}
