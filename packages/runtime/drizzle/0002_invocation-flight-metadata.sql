ALTER TABLE `invocations` ADD `flight_metadata_json` text;--> statement-breakpoint
UPDATE invocations AS inv
SET
  flight_id = latest.id,
  state = latest.state,
  summary = latest.summary,
  output = latest.output,
  error = latest.error,
  started_at = latest.started_at,
  completed_at = latest.completed_at,
  flight_metadata_json = latest.metadata_json
FROM (
  SELECT invocation_id, id, state, summary, output, error, started_at, completed_at, metadata_json,
    ROW_NUMBER() OVER (
      PARTITION BY invocation_id
      ORDER BY COALESCE(completed_at, started_at, 0) DESC, rowid DESC
    ) AS rn
  FROM flights
) AS latest
WHERE latest.invocation_id = inv.id
  AND latest.rn = 1;
