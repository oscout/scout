# Historical Scout Desktop Plan

This file records the old `apps/desktop` consolidation plan. It is no longer
the active architecture direction.

Current direction: migrate shared behavior out of `apps/desktop` into
package-owned boundaries, keep current web work in `packages/web`, keep native
macOS shell behavior in `apps/macos`, and reduce this tree to compatibility
shims before removing it.

## Layout

```text
apps/desktop/
├── bin/
│   └── scout.ts
├── src/
│   ├── cli/
│   │   ├── main.ts
│   │   ├── argv.ts
│   │   ├── context.ts
│   │   ├── options.ts
│   │   ├── registry.ts
│   │   ├── help.ts
│   │   ├── output.ts
│   │   ├── errors.ts
│   │   └── commands/
│   ├── app/
│   │   ├── host/
│   │   └── desktop/
│   ├── core/
│   │   ├── broker/
│   │   ├── agents/
│   │   ├── pairing/
│   │   ├── setup/
│   │   ├── flows/
│   │   ├── context/
│   │   └── services/
│   ├── ui/
│   │   ├── terminal/
│   │   ├── monitor/
│   │   └── format/
│   └── shared/
└── plan.md
```

## Ownership Rules

- `src/cli` temporarily owns argv parsing, command registration, help, and exit
  behavior until that implementation moves to `packages/cli`.
- `src/core` temporarily owns typed product behavior and cross-domain flows
  until reusable services move to `packages/runtime` or another package
  boundary.
- `src/ui` owns rendering for terminal, monitor, and formatted output.
- `src/app` is old desktop/local-host integration. Native-specific behavior
  should move to `apps/macos`; shared behavior should move to packages.
- `src/shared` stays low-level and should not absorb product logic.

## Donor Strategy

- Treat this tree as donor/transitional code, not the long-term runtime path.
- Port capabilities out of `apps/desktop/src` instead of extending it.
- Prefer moving reusable behavior into typed services before exposing it as a Scout command.

## Current Port Status

- `core/setup` owns `setup`, `doctor`, and `runtimes` reporting.
- `core/broker` owns `send`, `speak`, `ask`, `watch`, `who`, and `broadcast`.
- `cli` now owns shared command context, option parsing, output mode selection, and context-root handling.
- `pairing` and `agents` now have Scout-native command paths.
- `monitor` now has a Scout-native terminal surface behind `scout tui`.
- `app/desktop` now owns Scout-native desktop shell composition and phone-preparation state.
- `app/host` now owns desktop host config, the Scout-native service surface for app info/shell state/phone-preparation state, and the typed IPC contract for host wiring.
- Host integration now lives in `app/host`; remaining donor cleanup should continue there instead of reintroducing legacy host-specific layers.
