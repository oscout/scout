# OpenScout Session Trace React

`@openscout/session-trace-react` is the React presentation layer for OpenScout
live session traces. It renders trace turns, action blocks, reasoning blocks,
approval cards, and question blocks using the framework-agnostic models from
`@openscout/session-trace`.

Keep this package UI-focused. Trace state and selectors belong in
`@openscout/session-trace`; broker-owned coordination state belongs in
`@openscout/runtime`.

## What Lives Here

- `TraceTimeline.tsx` renders the session trace timeline.
- `TraceTurn.tsx` renders one turn.
- `TraceBlock.tsx` dispatches block rendering.
- `TraceActionBlock.tsx`, `TraceReasoningBlock.tsx`, `TraceQuestionBlock.tsx`,
  and `TraceApprovalCard.tsx` render specific block types.
- `hooks.ts` contains React helpers for trace consumers.

## Local Commands

From the repo root:

```bash
npm --prefix packages/session-trace-react run build
npm --prefix packages/session-trace-react run check
```

## Read Next

- [`../session-trace/README.md`](../session-trace/README.md) for the underlying
  trace model
- [`../web/README.md`](../web/README.md) for the web UI package that consumes
  trace presentation
- [`../../docs/architecture.md`](../../docs/architecture.md#the-data-model) for the
  observed-source versus Scout-owned record boundary
