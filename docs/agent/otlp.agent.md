# OTLP inspection receiver — agent reference

Verified: 2026-09-22 against `scout/otel-ingest` worktree implementation.
Human reference: [../otlp.md](../otlp.md). Future design: [SCO-105](../eng/sco-105-otel-ingest.md).

## Role

Local OTLP/HTTP inspection evidence. No canonical Scout domain writes, usage
rollups, quota readings, exporter configuration, forwarding or public `scout otel` command. Do not infer installed-release availability from this worktree.

## Model and flow

`HTTP guard → bounded body/gzip → pinned schema decode → allowlist → memory queue → SQLite → bounded read/UI`.

- Signals: traces/logs/metrics. Encodings: JSON/protobuf; identity/gzip.
- Record: `{id, signal, receivedAt, resourceKey, resource, scope, attributes, data}`.
- Resource key: SHA-256 of sorted sanitized resource attributes; not identity.
- Receiver API: `startOtlpReceiver({databasePath, port?, limits?, now?})` → `{url, flush, status, close}`.
- `close()` idempotent; stops admission/timers, closes listener, drains, closes DB.
- 200 means queue admission, possibly partial success; never durable acknowledgement.
- Per-signal rejection counts count original items; metrics count points.
- Forbidden-field stripping does not itself count as item rejection.
- Failed DB batches are discarded; inspect `persistenceFailures/persistenceLost`.

## Entry points

| Surface | Contract |
| --- | --- |
| Development | `OPENSCOUT_RUNTIME_ENTRYPOINT=source bun packages/runtime/bin/openscout-runtime.mjs otel ...` |
| `serve` | Required `--database`; optional `--port`; SIGINT/SIGTERM drains. |
| `status` | Default subcommand; GET health; JSON. |
| `tail` | One-shot persisted read; `--limit 1..500`, default 100; JSONL. |
| Broker | Exact `OPENSCOUT_OTLP_ENABLED=1`; `OPENSCOUT_OTLP_PORT` or 43160; DB under control home. Startup failure disables telemetry only. |
| Bind | Fixed `127.0.0.1`; API port 0 allowed for tests, CLI requires 1..65535. Worktree ports 45300–45999. |
| HTTP | POST `/v1/{traces,logs,metrics}`; GET `/health`, `/observations`, `/`, `/favicon.ico`. |

## Invariants

- No Origin header; loopback Host allowlist; no CORS. Local pilot, not authenticated emitters.
- Sanitize before queue/store; no raw fallback. No log bodies, span names/events/links, prompts, responses or status text.
- Identifiers: bounded `[A-Za-z0-9_.:/@+-]+`; exact keys in `sanitize.ts`.
- Large integers remain strings. Metric temporality is retained, not converted into usage.
- Defaults: 1 MiB wire, 4 MiB decoded, 4 active requests, 10 s deadline, depth 32.
- Sanitize: 4096 items/request, first 64 attrs/list, identifier length 256.
- Queue: 4096 records / 8 MiB / 512 pending per resource; flush 128 every 300 ms.
- Retention: 6 h receive-time TTL / 2000 rows per resource / 20k global / 32 MiB payload.
- SQLite: own database, app id `0x534f544c`, schema 1, exclusive writer, WAL, 64 MiB main-page cap. Not a total filesystem cap.
- Inspection: latest 500 rows; groups by `(resourceKey, unambiguous native id)`; timeline latest 80 log/span entries/group.
- Token rows: only recognized Claude service + api_request log events; no sum across signals, no dedup, no inferred missing buckets.
- Grouped session identifiers do not create canonical sessions or agents. Span completion does not mean work completion.

## Code map and verification

`packages/runtime/src/otlp/`: `config.ts` defaults; `receiver.ts` HTTP/queue;
`codec.ts` schema validation; `sanitize.ts` allowlists; `store.ts` retention;
`inspection-view.ts` grouping; `inspection-page.ts` escaped HTML;
`standalone.ts` CLI; `broker-lifecycle.ts` opt-in; `schema.generated.ts` descriptor.

`bun test packages/runtime/src/otlp`: 45 tests / 251 assertions passed on verification date.
Compiled smoke: `node --test scripts/verify-otlp-build.mjs` after non-cleaning
protocol → agent-sessions → runtime TypeScript emit; exact recipe in human guide.
Synthetic tests prove receiver behavior, not real-harness compatibility.

Schema: `opentelemetry-proto` v1.7.0, pinned revision in `proto/provenance.json`;
protobufjs 7.6.6. `node scripts/generate-otlp-schema.mjs` regenerates from vendored
files; `--fetch` retrieves pinned files first. Keep license/provenance.
