CREATE INDEX `idx_agent_endpoints_roster_recency` ON `agent_endpoints` (CASE
      WHEN "updated_at" IS NULL THEN NULL
      WHEN CAST("updated_at" AS REAL) < 1000000000000
        THEN CAST(CAST("updated_at" AS REAL) * 1000 AS INTEGER)
      ELSE CAST("updated_at" AS INTEGER)
    END desc,`agent_id`);