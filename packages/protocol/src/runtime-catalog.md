# Runtime model catalog

Scout publishes its enabled models, labels, ordering, defaults, reasoning
choices and context windows as versioned JSON. The canonical source is
`packages/protocol/src/runtime-catalog.v1.json`; the public data endpoint is
`https://openscout.app/.well-known/runtime-catalog.v1.json`.

The catalog controls product choices. Harness adapters separately check the
local executable and readiness, then launch the selected identifier through
their normal integration. A provider rejection is reported as an execution
failure. An installed harness's advertised model list does not silently rewrite
Scout's published enabled list. A model in this catalog does not prove that a
particular provider account, client or workspace can use it.

`Default` leaves the model and effort unspecified and uses the harness's own
configuration. A suggested catalog default does not replace that configuration.

## Review and publish model data

1. Optionally run `bun scripts/check-runtime-model-updates.ts`. This prints a
   read-only comparison with [Models.dev's model metadata](https://models.dev/models.json).
   It proposes new model facts and context-window changes; it does not enable
   models, rename IDs, change defaults or publish anything. Upstream context
   values describe provider/API metadata and may differ from a harness's usable
   budget. Verify identifiers, context windows and reasoning controls against
   the harness and provider documentation.
2. Edit `packages/protocol/src/runtime-catalog.v1.json`, including each model's
   explicit `enabled` flag. Increment its `YYYY-MM-DD.N` revision. New model
   names are data; use exact launch identifiers rather than guessed aliases.
3. Run `bun scripts/generate-runtime-catalog.ts` and then the same command with
   `--check`. The generated bundled fallback and public-site mirror must match
   the reviewed source. Review the data change and deploy the landing site
   through the authorized local site process. No app rebuild, package publish,
   daemon restart or hosted workflow is part of model-data publication.
4. Run `bun scripts/generate-runtime-catalog.ts --verify-live` after deployment.
   This read-only check requires the public JSON's revision and bytes to
   match the generated source mirror; generating a local mirror alone does not prove publication.

Current clients check the published catalog once a minute, save the valid model
list and check time, and use conditional requests with the catalog ETag. The
saved list stays available offline, with the bundled catalog as a first-install
fallback. A separate upcoming client update changes the normal network check
to once a day and adds a **Refresh models** action that checks immediately.
Existing clients keep their one-minute refresh schedule until they receive
that client update. Ordinary model-data changes need no subsequent package
update.

To intentionally restore older model contents, publish them under a new,
higher revision. Scout rejects revision downgrades and same-revision content
changes so retries cannot roll back or silently replace a catalog.

Normal model additions, removals and metadata changes require only a JSON
publication. Adding a new harness or execution protocol can still require an
adapter update. Do not infer an aggregator-qualified ID from a vendor
announcement: xAI's `grok-4.6` proves the Grok ID, but not an
`opencode-go/grok-4.6` ID.

Catalog requests can provide aggregate request-volume measurements in existing
hosting logs. Request volume is not a unique-user count: checks, manual
refreshes and retries affect it. The client sends no installation identifier,
project path, account data or model-selection event with a catalog request.

The `gpt-6.1-sol` entry is distinct from `gpt-6-sol`. OpenAI documents its exact
identifier, 1,050,000-token API context window and medium API default effort in
[the API model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
The API effort list runs from low through max; Scout's Codex entry also includes
Ultra because [the Codex model guide](https://learn.chatgpt.com/docs/models)
documents Light through Ultra for this model, subject to plan, client and
workspace availability. Ultra is a Codex control, rather than an additional
API effort. Existing catalog defaults remain unchanged. This publication does
not prove that the mini's installed client or account can use the model, or
diagnose an older client's rejection.
