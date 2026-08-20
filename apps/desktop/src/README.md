`apps/desktop/src` is organized by architectural role:

- `cli/` command parsing, help, and command handlers
- `app/` host/runtime wiring
- `core/` product logic and orchestration
- `web/` the React renderer app
- `ui/` terminal/monitor presentation helpers
- `shared/` low-level utilities

Rules:
- Only `cli/` should parse argv or decide exit codes.
- `core/` exposes typed behavior and never owns help text.
- `web/` owns renderer routing, composition, and feature UI.
- `ui/` renders terminal/monitor state and command results; it should not own domain logic.
- `shared/` stays small and low-level.
