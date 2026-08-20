import { indexRecentSessionKnowledge, SQLiteKnowledgeStore } from "@openscout/runtime";

/**
 * Child-process entrypoint for /api/knowledge/sessions/index. Session
 * indexing parses hundreds of MB of transcripts and performs heavy SQLite/FTS
 * writes; running it in a separate process keeps the web server's event loop
 * (and memory footprint) isolated from the job — a crash or OOM here cannot
 * take the server down. Options arrive as JSON in argv[2]; the outcome is
 * printed as a single JSON line on stdout.
 */
async function main() {
  const raw = JSON.parse(process.argv[2] ?? "{}") as {
    days?: number;
    hours?: number;
    limit?: number;
    force?: boolean;
    harness?: string | string[];
  };
  const input = {
    days: typeof raw.days === "number" ? raw.days : undefined,
    hours: typeof raw.hours === "number" ? raw.hours : undefined,
    limit: typeof raw.limit === "number" ? raw.limit : undefined,
    force: raw.force === true,
    harness: raw.harness,
  };
  try {
    const result = await indexRecentSessionKnowledge(input);
    // Status after index is a pure read; avoid a second writable connection.
    const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
    try {
      console.log(JSON.stringify({ ok: true, result, status: store.status() }));
    } finally {
      store.close();
    }
  } catch (error) {
    console.log(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    process.exitCode = 1;
  }
}

await main();
