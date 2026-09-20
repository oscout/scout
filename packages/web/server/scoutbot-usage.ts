import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDbPath } from "./db/internal/db.ts";
import { validUsageNumber, type VoiceModelUsage, type VoiceModelUsageSummary, type VoiceTokenUsage, type VoiceUsageMode } from "../shared/voice-usage.ts";

/** Web-owned provider telemetry only. Never writes broker coordination records or transcripts. */
export class ScoutbotUsageStore {
  private readonly db: Database;
  private readonly owned: boolean;
  constructor(options: { database?: Database; path?: string } = {}) {
    const path = options.path ?? join(dirname(resolveDbPath()), "scoutbot-usage.sqlite");
    if (!options.database) mkdirSync(dirname(path), { recursive: true });
    this.db = options.database ?? new Database(path, { create: true });
    this.owned = !options.database;
    this.db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS model_usage (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mode TEXT NOT NULL,
        model TEXT NOT NULL, provider TEXT, started_at INTEGER NOT NULL,
        finished_at INTEGER, elapsed_ms INTEGER, state TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS model_usage_recent ON model_usage(started_at DESC);
      CREATE INDEX IF NOT EXISTS model_usage_session ON model_usage(session_id, started_at DESC);`);
  }

  start(input: { sessionId: string; mode: VoiceUsageMode; model: string; provider?: string; startedAt: number }): string {
    const id = randomUUID();
    this.db.query("INSERT INTO model_usage (id, session_id, mode, model, provider, started_at, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
      .run(id, input.sessionId, input.mode, input.model, input.provider ?? null, input.startedAt);
    return id;
  }

  finish(id: string, input: { state: "completed" | "failed"; provider?: string; finishedAt: number; usage?: VoiceTokenUsage | null }): void {
    const usage = input.usage;
    this.db.query(`UPDATE model_usage SET state=?2, provider=?3, finished_at=?4,
      elapsed_ms=MAX(0, ?4-started_at), input_tokens=?5, output_tokens=?6, total_tokens=?7
      WHERE id=?1 AND state='pending'`).run(id, input.state, input.provider ?? null, input.finishedAt,
        validUsageNumber(usage?.inputTokens, true), validUsageNumber(usage?.outputTokens, true), validUsageNumber(usage?.totalTokens, true));
  }

  snapshot(): { records: VoiceModelUsage[]; summaries: VoiceModelUsageSummary[] } {
    const records = this.db.query(`SELECT id, session_id AS sessionId, mode, model, provider,
      started_at AS startedAt, finished_at AS finishedAt, elapsed_ms AS elapsedMs, state,
      input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens
      FROM model_usage ORDER BY started_at DESC, id DESC LIMIT 40`).all() as VoiceModelUsage[];
    const summaries = this.db.query(`SELECT mode, COUNT(*) AS requests,
      SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS missingTokenReports,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(total_tokens) AS totalTokens,
      SUM(elapsed_ms) AS elapsedMs FROM model_usage GROUP BY mode`).all() as VoiceModelUsageSummary[];
    return { records, summaries };
  }

  close(): void { if (this.owned) this.db.close(); }
}
