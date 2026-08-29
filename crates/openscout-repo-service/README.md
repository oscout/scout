# openscout-repo-service

Thin compatibility wrapper for the Scout repo scan/diff implementation now owned
by the `scoutd` crate.

The public one-shot contract remains buildable for existing invokers and release
packaging (`OPENSCOUT_REPO_SERVICE_BIN`, `openscout-repo-service scan`, and
`openscout-repo-service diff`), but the parsing and Git execution code lives in
`crates/scoutd/src/repo_service.rs` and is also served over the resident
`scoutd probes serve` socket.

```bash
cargo run --manifest-path crates/openscout-repo-service/Cargo.toml -- scan < request.json
cargo run --manifest-path crates/openscout-repo-service/Cargo.toml -- diff < request.json
```

Scan input:

```json
{
  "hints": [{ "path": "/Users/art/dev/openscout", "source": "endpoint" }],
  "limits": {
    "includeDiff": true,
    "includeLastCommit": true,
    "maxRoots": 8,
    "maxWorktrees": 4,
    "maxFilesPerWorktree": 12,
    "scanBudgetMs": 4000
  }
}
```
