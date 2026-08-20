# Adapter Layout

Each runnable adapter owns one directory under `src/adapters/<adapter-id>/`.
The canonical shape is:

- `adapter.ts` - runtime implementation and `createAdapter` factory
- `index.ts` - small public entrypoint for that adapter directory
- `adapter.spec.json` - formal contract when the adapter has a stable upstream or
  OpenScout contract worth validating
- `*.test.ts` - adapter-specific tests, colocated with the adapter behavior
- `references/` and `tools/` - upstream notes or extraction helpers when needed

Shared helpers that are not one adapter's runtime implementation stay at the
`src/adapters/` level, such as budget observation aggregation and event
inventory tooling.

The goal is boring consistency: an adapter folder should be readable from top to
bottom without knowing which harness was added first.
