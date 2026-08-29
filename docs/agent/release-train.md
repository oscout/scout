# Release train

OpenScout delivery trains are owned by the repo-local
[`release-train` skill](../../.agents/skills/release-train/SKILL.md). The skill
contains the normative stage workflow, checkpoint schemas, deterministic
runner/checker, evidence recipes, review-escalation matrix, retry/stop policy,
and completion contract.

Do not duplicate the workflow in this document. Invoke it explicitly:

```text
Use $release-train for exactly one resumable cycle.
```

If the skill, workflow definition, or runner is missing or invalid, report the
missing workflow as the blocker. Do not fall back to an unstructured sweep.

The intended cadence is 09:00 and 17:00 America/Montreal. A scheduled task in
this ongoing chat should use the exact prompt above so every run resumes the
durable local checkpoint and advances at most one legal cycle. Live checkpoints
belong under `~/.openscout/control-plane/release-train/`; only the skill,
schemas, templates, and examples belong in Git.

Read-only preflight does not consume the cycle action. The selected write
command first validates and computes its one legal state transition, then
renews an expired same-run lease and persists the result within that gated
command; a scheduled run must not use a separate lease-renewal cycle.

Validate the checked-in workflow with:

```bash
python3 /Users/art/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/release-train
bun test ./.agents/skills/release-train/scripts/release-train.test.ts
bun .agents/skills/release-train/scripts/release-train.ts validate
bun .agents/skills/release-train/scripts/release-train.ts init
```
