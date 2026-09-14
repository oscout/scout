# Session search

Search **observed harness sessions** (Codex, Claude, Kimi, …) after an
**explicit warm-up**. This is not broker chat history and does not import
transcripts into Scout messages.

## When to use it

| Need | Prefer |
| --- | --- |
| Who is online / what just happened on the broker | `scout who`, `scout latest` |
| Live harness firehose | `scout tail` |
| “What did a past session say/do about X?” | **`scout search`** |
| Exact session coordinates after a hit | session id + path from search hits |

## Contract

1. **Explicit index only** — no ambient background indexing.
2. Warm a **time span** (and optional harness), then query.
3. Query does **not** auto-index. If coverage is missing, Scout says so and
   suggests the warm-up command.
4. Hits are **derived** (QMD + FTS). Raw JSONL/wire files remain authority.

## Commands

```bash
# Status + recent warm spans
scout search status

# Explicit warm-up
scout search index --source sessions --days 3
scout search index --source sessions --harness kimi --hours 12
scout search index --source sessions --harness claude --days 7 --force

# Query (only searches what was warmed)
scout search query "xcodebuild" --harness kimi --hours 12
scout search query "pairing flap" --project openscout --days 3
scout search query "iOS build" --harness kimi --json
```

### Flags

| Flag | Index | Query | Meaning |
| --- | --- | --- | --- |
| `--source sessions` | yes | (implied) | First product slice: harness sessions only |
| `--days N` / `--hours N` | lookback | coverage + optional mtime filter | Hours overrides days; max 30d |
| `--harness <id>` | filter roots | facet + coverage | `codex`, `claude`, `kimi` (repeatable) |
| `--project <name>` | — | facet | Project basename facet |
| `--limit N` | discovery cap | hit cap | |
| `--force` | re-index | — | Ignore content-hash skip |

### Coverage honesty

| Message | Meaning |
| --- | --- |
| empty / not warmed | That source×harness×window was not explicitly indexed; run the suggested `index` command |
| warmed, no matches | Span was indexed; query simply had no FTS hits |
| warmed (stale) | Covered, but last warm is old relative to the lookback — re-index if you need fresher files |

## Where data lives

| Path | Role |
| --- | --- |
| Harness stores (e.g. `~/.kimi-code/sessions`, `~/.codex/sessions`, `~/.claude/projects`) | Authority transcripts |
| `~/.openscout/control-plane/knowledge/knowledge.sqlite` | Rebuildable FTS + warm spans |
| `~/.openscout/control-plane/knowledge/qmd/` | Derived markdown sidecars |

Control-plane SQLite (messages, flights) is **separate**. Search never writes
Scout-owned conversation records from harness text.

## Agent guidance

When the operator asks about prior agent work across sessions (what was built,
which session ran a command, where a harness instance lived):

1. `scout search status` — is anything warmed?
2. If not covered: `scout search index --source sessions --harness <id> --hours N`
3. `scout search query "…" --harness <id> --hours N`
4. Report session id, project/cwd, and source path from hits — do not invent peers.

Do **not** grepping entire `~/.codex` / `~/.kimi-code` trees by hand when this
path is available. Do **not** bulk-import transcripts into Scout messages.

## Related

- Checkpoints: `docs/archive/eng/session-search-checkpoint-1.md`, `docs/archive/eng/session-search-checkpoint-2.md`
- Design: `docs/eng/sco-062-qmd-knowledge-search-and-context-index.md`
- Runtime: `packages/runtime/src/knowledge/`
- CLI: `apps/desktop/src/cli/commands/search.ts`

## Scoutbot read-only tools

Scoutbot can use `sessions_search` to query this same existing FTS index without
indexing or opening raw transcript files. Queries are bounded to 300 characters,
1–20 hits (default 8), and 1–720 hours (default 72). Optional harness and project
basename filters use existing index facets. This is lexical search; a natural
language request is translated into search terms, not a semantic embedding query.
The response always includes warm coverage and staleness. Missing coverage skips
the search and returns the explicit warm-up suggestion for the operator.

`sessions_inventory` reads the existing canonical session views and observed
terminal inventory, with literal filters and at most 20 returned results. The
underlying view is bounded (80 sessions / 100 terminal records), so it does not
prove that a session or process does not exist. `live_attachable` requires a
terminal surface observed as live or detached. `history_only` requires all matched terminal surfaces to be explicitly exited;
it does not rule out an independent harness process. Missing terminal evidence,
unknown surface state, or unavailable inventory is reported as `unknown`.

Search hits receive an Open session link only when their harness-native identity
matches a canonical session, and an Attach terminal link only for an observed
live/detached surface. Index-only hits retain source coordinates and have no
fabricated action. Both tools are read-only; neither imports transcripts, warms
an index, launches a shell, resumes a harness, or dispatches work. Returned source
text remains untrusted observed material.


## Scoutbot attachment inspection

`attachments_read` accepts an attachment id and optional originating message id.
It requires an active broker reply context and a canonical operator message in
that same conversation. Only that message's same-origin `/api/blobs/<id>` URL
can be read. Authentication uses the existing Scout Web bearer/bootstrap path;
redirects, arbitrary URLs, and filesystem reads are not allowed.

Text/code attachments must match their declared MIME type, contain valid UTF-8
text, and stay within 256 KiB. Returned text is limited to 32,000 characters and
reports truncation. Image, audio, video, PDF, and other binary inspection is
explicitly unavailable in this runtime; accepting such a file in the composer
does not imply that the assistant can inspect it. Source text is untrusted data.
