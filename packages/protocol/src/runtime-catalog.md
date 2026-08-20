# Runtime model catalog

The operator contract is intentionally one step:

1. Edit `packages/protocol/src/runtime-catalog.v1.json`.

That is all. The deployed well-known route publishes the same JSON and every
running `scoutd` checks it once a minute. Valid revisions replace the bundled
or persisted last-known-good catalog; malformed or unreachable revisions are
quarantined with a warning. No generator, daemon restart, app rebuild, or
cache-bust command is part of a model update.

To intentionally restore older model contents, publish them under a new,
higher revision. Scout rejects revision downgrades and same-revision content
changes so retries cannot roll back or silently replace a catalog.

Increment the `YYYY-MM-DD.N` `revision` and add the provider's exact model ID,
label, harness, default, effort metadata, and `contextWindowTokens` when the
provider publishes it. Do not infer an aggregator-qualified ID from a
vendor announcement: xAI's `grok-4.6` proves the Grok IDs, but not an
`opencode-go/grok-4.6` ID.
