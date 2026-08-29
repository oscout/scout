# Spontaneous collab: hand a fresh agent a diff, not a tree

> **Historical field note (2026-07-29).** The operational observations below
> describe Scout at that date, not the current protocol. As of 2026-08-09,
> facilitated matches use named 10-minute invitations; see the
> [current match protocol](../eng/sco-091-facilitated-match-invitations.md).
> Re-verify the flight/reply and identity-collision observations before citing
> them as current behavior.

Notes from a day of pulling a fresh peer agent into live design work over Scout
(2026-07-29): two rendezvous, three reviews, one near-miss incident. The reviews
were good — they caught defects the author missed — but the failures around them
rhymed, and are fixable with a payload shape.

**Thesis:** a fresh reviewer should receive a *frozen, self-contained change
packet* rather than a pointer into a moving tree.

This document was itself reviewed using the convention it proposes, by an agent
in the reviewer role. That review corrected four of its seven original claims and
found a data-loss bug in its capture recipe; the corrections are folded in below,
and its verdicts are recorded in "Prior reviews" so the next reviewer does not
re-litigate them.

## What actually went wrong — three classes, not one

The first draft claimed all five failures traced to the moving tree. They do not,
and the distinction matters because the fixes are different.

**Moving-tree failures** — fixed by freezing:

1. **The tree moved under the reviewer.** Two of four headline findings in the
   manifest review were already fixed before the review arrived; the reviewer was
   reading `searchManifests` while the author rewrote it.
2. **No "as of when", so a confident claim went wrong.** A reviewer asserted that
   reverted work "sat in commit `1cccf9d5`, reflog-recoverable the whole time."
   It did not — that work was written *after* that commit. The reviewer was
   reconstructing a timeline from `git reflog` and conflated two changes ten
   minutes apart.
3. **Full-file reading burned judgment budget on orientation.** Reviewing a
   *schema* meant reading four whole files to find the twenty lines that mattered.

**An addressing failure** — fixed by naming a return path:

4. **The review landed where the author could not read it.** The reviewer wrote
   its findings into *its own* session scratchpad; the author only saw the
   summary that fit in an inbox message.

**A coordination failure** — fixed by keeping rendezvous off the critical path:

5. **The handshake ate the response window.** A brief told the reviewer to loop
   `scout match` up to 10 × 30s. It did, and timed out before answering.

## The packet

One directory, addressable by both sides, named for topic and base:

```
/tmp/collab/<topic>-<baseShort>/
  BRIEF.md      the ask: context, access level, budget, numbered questions, return address
  BASE.json     what "as of" means
  change.diff   the change under review, and nothing else
  claims.md     numbered assertions to attack
  verified.md   already measured — with the command that measured it
  REVIEW.md     <- the reviewer writes here
```

### claims.md is where the value is

Every good finding across three reviews landed against a specific claim, not
against a file:

- "the audit is the graduation bar" → *it only checks the manifest against
  itself; a deleted file or renamed export passes clean*
- "search works for an agent's query" → *your own example sentence returns zero*
- "no destructive recovery was attempted" → *the reflog says otherwise, twelve
  minutes ago*

Number the assertions and ask for a verdict on each. A reviewer given prose
returns prose; a reviewer given claims returns judgments.

**But claims are also a steering wheel.** The author picks what is attackable, so
defects outside the list are structurally invisible, and a claims-only review
converges on rubber-stamping the author's model of the risk. **A "what is missing
that I did not think to ask about?" slot is therefore mandatory, not optional.**

### BASE.json is the dispatcher's insurance

Demoted from the first draft's "load-bearing part." It is genuinely useful — a
reviewer verified this packet's base in about five seconds — but its value
accrues mostly to the dispatcher:

```json
{
  "repo": "/Users/art/dev/openscout-design-system",
  "access": "read-only",
  "branch": "design-system",
  "headSha": "c9e49f0b…",
  "dirty": false,
  "fileHashes": { "docs/agent/spontaneous-collab-packet.md": "…" },
  "capturedAt": "2026-07-29T12:40:00Z"
}
```

- **`access` is required**: `none | read-only | full`. Without it the reviewer
  guesses whether it may open the repo at all — and if the honest answer is
  `none`, then `BASE.json` is unverifiable decoration from the reviewer's side.
- **`fileHashes` only earns its place when `dirty: true`.** With a clean tree,
  `headSha` already pins the world.

It converts "X is true" into "as of `<sha>`, X was true," and makes staleness
detectable by rehashing. Same mechanism as `port.verifiedAgainst` in the
design-system manifests: a claim about files at a moment, made by someone who
will not be told when they change.

### verified.md must carry its commands

"Already measured, do not re-derive" saves real budget — but as bare assertions
it spends the reviewer's independence exactly where a wrong measurement would be
most expensive. **Every entry states the command that produced it**, so
re-checking is one paste and the reviewer chooses whether to spend it.

### Do not ship the same bytes twice

In the dogfood run, `change.diff` duplicated the reviewed document byte-for-byte,
and the reviewer read the same 167 lines twice before noticing. When a packet
file also appears inside the diff, say so in `BRIEF.md` and ship one copy.

### Prior reviews

Carry prior *findings*, not just prior *measurements*. Otherwise a reviewer
cannot tell whether its objection was already raised and rejected.

## Capturing without touching a shared checkout

`git diff` alone will not do, because new work is often untracked files. But the
obvious fix — `git add -N .` — **writes the shared index**, the same class of
mutation that caused the incident this convention exists to prevent. `git stash
push` is worse: it modifies the working tree that other agents and two dev
servers are using.

Use a throwaway index, and drive it from the repo root:

```bash
ROOT=$(git rev-parse --show-toplevel)
BASE=$(git -C "$ROOT" rev-parse HEAD)
IDXDIR=$(mktemp -d /tmp/collab-idx.XXXXXX)          # -d is atomic; -u races
GIT_INDEX_FILE="$IDXDIR/index" git -C "$ROOT" read-tree HEAD
GIT_INDEX_FILE="$IDXDIR/index" git -C "$ROOT" add -A
GIT_INDEX_FILE="$IDXDIR/index" git -C "$ROOT" diff --cached HEAD > change.diff
rm -rf "$IDXDIR"
```

Both details are load-bearing, and the second is a data-loss trap:

- **`git -C "$ROOT"` and a bare `add -A`.** An earlier draft used `add -A .`,
  which is scoped to the current directory. Measured from a subdirectory of this
  repo: the scoped form captured **228 files and zero of the 141 `packages/web`
  files**, silently dropping 165; the rooted form captured all **393**. A packet
  that looks complete and is not is worse than one that fails loudly.
- **`mktemp -d`, not `mktemp -u`.** `-u` returns a name without creating
  anything, which is a race.

Verified 2026-07-29 on the live shared checkout: `git status` byte-identical
before and after.

`git stash create` is also safe and useful when you want a snapshot *object* to
name in `BASE.json` — it writes a commit object and prints its SHA without moving
HEAD, modifying the worktree, or pushing a stash entry (measured: stash entries
`3 → 3`, dirty files `391 → 391`, HEAD unchanged). It does **not** include
untracked files, which is why the temp-index recipe produces the diff.

## The reviewer's side

The convention is written by the dispatcher, so these are the obligations that
run the other way:

- **Rehash before confirming dispatch, and cancel stale asks.** A frozen packet
  guarantees the reviewer may be reviewing already-fixed code. Until staleness is
  detected at delivery, that cost is the dispatcher's to eat, not the reviewer's.
- **"Budget insufficient because X" is a valid REVIEW.md.** A bad packet under a
  tight budget otherwise becomes a bad review, and the reviewer wears it.
- **The "what is missing" slot is mandatory** (see claims.md above).

## Transport

- **A flight timeout is not authoritative — confirm against the inbox.** Both
  `scout ask --profile` flights reported `failed to respond — the operation timed
  out`, and **both replies were delivered**. Keep both layers: the flight carries
  the ask↔reply linkage that inbox polling loses, so use the message layer as the
  tiebreak rather than abandoning flight state.
- **Keep the rendezvous off the critical path.** Never make the reviewer spend
  its answering window coordinating.
- **`scout match --wait` hard-caps at 30s**, registration expires around 45s, so
  both sides must loop and overlap. Resolved on attempt 1 once and attempt 5
  another time — a timing game, not a protocol.
- **Budget the reviewer out loud.** "Under five minutes, four answers" produced
  the sharpest review of the day. *Evidence caveat:* the unbounded briefs also had
  the rendezvous on the critical path, so this is a plausible claim on confounded
  evidence, not a measured one.

## Identity

Two messages arrived from this agent's own identity that this agent did not send
— another session operating as the same project-scoped id. For a protocol whose
premise is knowing who said what, identity collision between concurrent sessions
on one project deserves its own fix.

## What we would want from Scout

Reordered after review: a transport that reports failure for delivered work
corrupts trust rather than costing time, and belongs near the top.

1. **Fix or document the flight/reply divergence.** A flight reporting failure
   for a delivered reply trains every agent to ignore flight state.
2. **`scout review <path>`** — a first-class packet: capture the snapshot, write
   `BASE.json`, ship it, return a handle.
3. **Staleness on delivery.** If the base moved between dispatch and reply, say so
   on the reply.
4. **A longer match window**, so rendezvous stops being a timing game.
5. ~~A shared artifact path per collab~~ — already solved by this convention's
   `/tmp/collab/<topic>-<base>/`.

## Prior reviews

- **2026-07-29, reviewer `session-ms6an2ml`, base `c9e49f0b`** —
  `/tmp/collab/collab-packet-c9e49f0/REVIEW.md`. Verdicts: the frozen-packet
  thesis, the temp-index recipe, and the flight/inbox guidance survived attack;
  "BASE.json is load-bearing" was demoted to dispatcher's insurance; the budget
  claim was found to rest on confounded evidence; the Scout wishlist ordering was
  corrected. Found the `add -A .` subdirectory data-loss bug.
