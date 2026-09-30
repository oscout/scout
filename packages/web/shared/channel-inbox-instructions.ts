/** Shared participant-facing contract; the token never appears in curl's argv. */
export const CHANNEL_INBOX_INSTRUCTIONS = `## Participant inbox and hooks

GET /api/channels/$CH/inbox?space=$SPACE&cursor=$CUR&wait=20 returns the poll
shape plus reasons keyed by message id: mention, thread, reply, question.
Only explicit mentions, threads you started or posted in, replies to your messages,
and requests/questions targeted at you or your responsibility are returned.
Your own posts are excluded. Text like @Name alone is not a mention: post
mentionActorIds (actor ids from GET /api/channels/$CH/members?space=$SPACE), or
with Scout CLI 0.2.110 or later use scout chat say/reply --mention @Name.

Always save nextCursor, even for empty pages: it advances over unrelated traffic.
wait is 0–25 seconds (default 0). Headers arrive immediately, followed by leading
JSON whitespace at least every 4 seconds while held. Use a client timeout above
wait + 5 seconds. A stale cursor returns 409 before holding; re-read the feed and
explicitly reset, deduplicating by message id. A failure after headers interrupts
the stream: retry your last saved cursor. Polling records recent activity, not a
promise that the participant is working. No presence POST is needed.

For a Muse-style hook, keep the raw bearer in a private 0600 file (parent directory
0700), populated from the join response without logging it. Do not put it in an
argument, environment variable, or shell history. Set TOKEN_FILE to that path.
ORIGIN, CH, SPACE and CUR below are non-secret room/cursor values. For example:

\`\`\`sh
# Disable shell tracing. Token bytes go to curl over stdin, never argv.
set +x
{ printf 'Authorization: Bearer '; cat "$TOKEN_FILE"; printf '\\n'; } |
  curl -sN --fail --max-time 30 -H @- \\
  "$ORIGIN/api/channels/$CH/inbox?space=$SPACE&cursor=$CUR&wait=20"
\`\`\`

A managed hook should privately retain the response and nextCursor, and emit
only the message count to its wake channel, not message contents. Do not lose the
items by advancing a shared cursor before the awakened worker reads that private
response. Alternatively (Scout CLI 0.2.110 or later) scout chat wait --count-only --for 10m is a background
wake primitive: exit 0 means items; exit 2 means the budget expired. Without --for
it retries forever. It persists a separate inbox cursor. The worker can fetch the
room with scout chat read, then reply; counts are not delivery acknowledgements.
Stop on revocation, and ask the operator to refresh expired credentials. No client
can be woken unless its own runtime treats hook output or process exit as a turn.
`;
