# Local delivery evidence

Hosted execution is opt-in. Local validation is the default authority for a
reviewed source merge, subject to real repository protections. Manual and
callable workflows remain available, but an agent must have explicit operator
authorization for hosted execution in the current campaign before dispatching.
Tagging or pushing must not start hosted workflows automatically.

Freeze a `validationPlan` in S30: one entry per approved lane, with `laneId`
and nonempty `checks: [{ id, platform }]`. Choose proportional checks from the
changed source and release surface before seeing results. A platform-specific
requirement cannot be satisfied by another platform. Document omitted Linux or
native coverage honestly; local macOS tests do not establish Linux compatibility.

Each required S50 local receipt has `laneId`, `checkId`, full `headSha` and
`baseSha`, exact `command`, `result: PASS`, `exitCode: 0`, ISO `startedAt` and
`finishedAt`, `platform`, `architecture`, nonempty `toolVersions`, absolute
`outputRef`, and the raw output's `outputSha256`. Keep outputs in durable local
release evidence storage, outside scratch directories. The checked-in validator
checks hashes on recording S80 and again before S90. It verifies recorded
claims and integrity; it does not authenticate the machine or run commands.

S60 records the observed PR `headSha` and `baseSha`. S70 requires an explicit
`APPROVE` with the exact `headSha`; `FOLLOW_UP` is not an approval. S80 uses
`validationSource: LOCAL_RECEIPTS`, those same revisions, passing checks,
current base, mergeability and no blocking feedback. Missing, skipped, stale,
wrong-platform or altered evidence fails closed. Freshly read remote state
immediately before merging and use an exact-head merge condition. Changed
heads or bases invalidate acceptance and require a new review/validation cycle.
The runner is not a remote branch lock; another actor can change GitHub after
an observation. Preserve merge commit receipts and verify final ancestry.

For explicitly requested hosted checks, S30 also records
`hostedCiAuthorization`. S80 uses `validationSource: HOSTED_CI` and
`hostedEvidence: { outputRef, outputSha256 }` naming a saved JSON run receipt
with `headSha`, `baseSha`, actual `runUrl` and matching per-lane `checks`.
Fetch the run and job results from GitHub; never manufacture a green status.
The runner validates receipt integrity and coverage, not GitHub identity.

Source merging and publishing are separate decisions. Use canonical public
`oscout/scout` for npm and public DMG distribution. Local builds must preserve
exact native dependency pins, approved Developer ID, notarization, Sparkle
signing and public-byte verification. A local npm process cannot claim the
GitHub OIDC provenance of the hosted publisher. Canonical public `oscout/scout`
now provides a reviewed local publisher; follow its current `docs/releases.md`
and preserve its release scripts during source exports. Local publication needs
configured authentication and exact retained candidates. If authentication is
missing, retain the candidates and report that specific blocker. Do not invoke
the hosted publisher without explicit operator authorization.
