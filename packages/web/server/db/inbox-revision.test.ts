import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxDatabaseRevision } from "./inbox-revision.ts";

test("readonly revision changes for another connection's edit and deletion, not merely inserts", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-revision-"));
  const path = join(dir, "test.sqlite");
  const writer = new Database(path);
  writer.exec("CREATE TABLE messages(id TEXT PRIMARY KEY, body TEXT); INSERT INTO messages VALUES ('same-id','before')");
  const reader = new Database(path, { readonly: true });
  try {
    const first = inboxDatabaseRevision(() => reader);
    writer.exec("UPDATE messages SET body='corrected' WHERE id='same-id'");
    const edited = inboxDatabaseRevision(() => reader);
    expect(edited).not.toBe(first);
    writer.exec("DELETE FROM messages");
    expect(inboxDatabaseRevision(() => reader)).not.toBe(edited);
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
