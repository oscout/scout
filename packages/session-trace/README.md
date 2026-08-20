# OpenScout Session Trace

`@openscout/session-trace` is the framework-agnostic model for rendering live
agent session activity. It turns session events and snapshots into trace blocks,
view models, selectors, and formatting helpers that UI packages can consume.

This package is presentation support for observed harness/session activity. It
does not own broker coordination records, messages, invocations, or flights.

## What Lives Here

- `trace-types.ts` defines trace block and view model shapes.
- `trace-view-model.ts` builds renderable session trace models.
- `trace-selectors.ts` exposes selectors over trace state.
- `trace-formatters.ts` formats trace content for UI surfaces.
- `trace-intents.ts` detects common action/question intent patterns.

## Local Commands

From the repo root:

```bash
npm --prefix packages/session-trace run build
npm --prefix packages/session-trace run check
```

## Read Next

- [`../agent-sessions/README.md`](../agent-sessions/README.md) for the harness
  session substrate
- [`../session-trace-react/README.md`](../session-trace-react/README.md) for the
  React renderer layer
- [`../../docs/architecture.md`](../../docs/architecture.md#the-data-model) for the
  observed-source versus Scout-owned record boundary
