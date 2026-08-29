---
name: release-train
description: Run OpenScout commit, pull-request, review, merge, release, and WIP-convergence trains as deterministic resumable cycles. Use when Codex must inventory delivery work, preserve concurrent lanes, advance ready branches through GitHub gates, coordinate Scout owner polls or independent reviews, verify a canonical release, resume a prior train checkpoint, or perform the scheduled 09:00/17:00 America/Montreal release-train cycle.
---

# Release Train

Run exactly one checkpointed cycle at a time. Treat the workflow definition and
runner as the state authority; use judgment only at the explicit planning,
review, and release gates.

## Start or resume

1. Read repository instructions and `docs/releases.md` before mutations.
2. Run the checker from the repository root:

   ```bash
   bun .agents/skills/release-train/scripts/release-train.ts validate
   bun .agents/skills/release-train/scripts/release-train.ts init
   ```

   Both commands are read-only by default. `init` prints the checkpoint it would
   create or reports the incomplete run it would resume.
3. Pass `--write` only to persist checkpoint state. The runner never commits,
   pushes, opens or merges PRs, tags, publishes, or rebases; perform those as
   explicit agent actions after the runner reports the gate open.
4. Run `status` or `ledger` after every mutation and attach the receipt before
   advancing.

Scheduled write commands renew an expired lease within the same gated command
when the persisted run id and lock token still match. After the read-only
preflight, perform the one legal stage action directly; do not spend a scheduled
cycle on a separate `init --write` lease renewal. Missing, malformed, foreign,
released, or token-mismatched locks still fail closed and require explicit
recovery.

The runner serializes checkpoint and lease writes with a per-repository update
guard, re-reads the checkpoint under that guard, and rejects stale writers.
It reclaims a leftover guard only when the recorded local process no longer
exists; a live or malformed guard fails closed.

Live state belongs under
`~/.openscout/control-plane/release-train/runs/<run-id>/checkpoint.json`, not in
Git. Override with `OPENSCOUT_RELEASE_TRAIN_HOME` or `--state-dir` for tests.
The runner resumes the newest incomplete checkpoint before creating a new
09:00/17:00 America/Montreal slot.

## Execute one resumable cycle

For a scheduled heartbeat, do at most one of these before returning:

- create/resume a checkpoint and finish its current stage output;
- advance one legal stage;
- execute one explicitly gated external action, record its receipt, and stop;
- take one legal S70/S80 recovery loop step;
- quarantine one blocked lane while leaving independent READY lanes eligible.

Read-only `validate`, `init`, `status`, and `next` calls are preflight. Exactly
one subsequent write or explicitly gated external action is the resumable cycle.

Invoke this skill with: `Use $release-train for exactly one resumable cycle.`
If this skill, its workflow definition, or runner is missing or invalid, report
that as the blocker. Never replace it with a free-form delivery sweep.

## Follow the encoded graph

Load [workflow-v1.json](references/workflow-v1.json) for the normative stage
graph, typed outputs, transition rules, review-escalation matrix, retry policy,
idempotency operations, and stop conditions. The checked-in
[checkpoint-v1.schema.json](references/checkpoint-v1.schema.json) documents the
persisted shape; the runner applies corresponding typed validators before
recording or advancing.

- `S00`: acquire the run lock and capture the immutable baseline.
- `S10`: discover WIP and record the source/ownership ledger.
- `S20`: poll owners and classify every lane `READY`, `HOLD`, `BLOCK`, or
  `EXCLUDE`.
- `S30`: freeze scope and record commit, PR, and release plans.
- `S40`: create logical commits only for approved READY lanes.
- `S50`: run proportional checks and attach exact receipts.
- `S60`: reuse, open, or update coherent PRs idempotently.
- `S70`: record `SELF`, `INDEPENDENT`, or `MULTI_AGENT` review. Changes loop to
  `S40` or `S50`.
- `S80`: require green CI, current base, mergeability, and no blocking feedback.
  Failures loop to `S40` or `S50`.
- `S90`: merge and verify the canonical release decision. `AMBIGUOUS` stops.
- `S100`: poll participating owners and reconcile only authorized READY work.
- `S110`: record the final ledger, stable receipts, unresolved work, and next
  checkpoint, then complete and release the lock.

Never mutate `HOLD`, `BLOCK`, or `EXCLUDE` lanes. Preserve owner vetoes. Never
force-push or rewrite an owner branch without explicit authorization.

Do not classify Scout as unavailable from a connection failure observed inside
a restricted execution sandbox. Follow the transport diagnostic gate in
`references/recipes.md`: preserve the initial error, retry the exact read or
action with loopback/network access, and require that second receipt before
recording a transport `BLOCK`. Never restart or repoint the broker merely to
work around sandbox isolation.

## Use deterministic recipes

Read [recipes.md](references/recipes.md) before discovery, GitHub review, Scout
polling, rebase/reconciliation, or release verification. Use the commands there
as evidence recipes, not as permission to mutate. Keep repository and GitHub
state authoritative when agent reports disagree.

## Runner commands

```bash
# Read-only preview/resume/status
bun .agents/skills/release-train/scripts/release-train.ts init
bun .agents/skills/release-train/scripts/release-train.ts status
bun .agents/skills/release-train/scripts/release-train.ts ledger
bun .agents/skills/release-train/scripts/release-train.ts next

# Persist local checkpoint state only
bun .agents/skills/release-train/scripts/release-train.ts init --write
bun .agents/skills/release-train/scripts/release-train.ts record-stage \
  --stage S10 --artifact /absolute/source-ledger.json --write
bun .agents/skills/release-train/scripts/release-train.ts advance --to S20 --write
bun .agents/skills/release-train/scripts/release-train.ts receipt \
  --kind pr_open --lane <lane-id> --target pr:<number> \
  --external-id <url-or-number> --write
bun .agents/skills/release-train/scripts/release-train.ts quarantine \
  --lane <lane-id> --reason <evidence-backed-blocker> --write
bun .agents/skills/release-train/scripts/release-train.ts stop \
  --reason <terminal-blocker-or-exhausted-retry-budget> --write
bun .agents/skills/release-train/scripts/release-train.ts complete --write
```

Use `--run-id` to select a specific checkpoint and `--state-dir` for an
alternate state root. Use `discover` to render a read-only worktree/branch
starter ledger. Run `help` for the complete contract.

## Validate changes to this skill

```bash
python3 /Users/art/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/release-train
bun test ./.agents/skills/release-train/scripts/release-train.test.ts
bun .agents/skills/release-train/scripts/release-train.ts validate
bun .agents/skills/release-train/scripts/release-train.ts init
```

Forward-test risky changes with an independent Scout reviewer using the compact
brief in `references/recipes.md`. Record the Scout flight/conversation/work ref
and classify findings as `must_fix`, `should_fix`, `follow_up`, or `reject`.
