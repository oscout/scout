# Semantic Spec Index

Verified: 2026-06-19

Dense agent-oriented subsystem specs. Read the relevant file before extending that area.

Not governance docs. Not proposals. Compressed ontology + invariants.

| Spec | Scope |
|---|---|
| [README.agent.md](./README.agent.md) | repo entry, paths, non-negotiables |
| [broker.agent.md](./broker.agent.md) | canonical writer, records, routing outcomes |
| [scout-comms.agent.md](./scout-comms.agent.md) | CLI/MCP workflows, send vs ask |
| [runtime-sessions.agent.md](./runtime-sessions.agent.md) | agent/session/endpoint lifecycle |
| [pairing-runtime.agent.md](./pairing-runtime.agent.md) | mobile bridge, QR, relay (not broker) |
| [scoutd.agent.md](./scoutd.agent.md) | launchd, supervise, doctor |
| [macos.agent.md](./macos.agent.md) | Scout app + HUD + menu helper targets, hosting, data layer |
| [integration-contract.agent.md](./integration-contract.agent.md) | external agent minimum contract |
| [current-posture.agent.md](./current-posture.agent.md) | maturity/trust boundaries |

## Read order by task

| Task | Read |
|---|---|
| send/ask/route | `scout-comms.agent.md` → `broker.agent.md` |
| start/wake/attach harness | `runtime-sessions.agent.md` → `broker.agent.md` |
| mobile pair / QR | `pairing-runtime.agent.md` |
| local service broken | `scoutd.agent.md` |
| macOS native UI work | `macos.agent.md` |
| new harness adapter | `integration-contract.agent.md` → `runtime-sessions.agent.md` |

## Format

The core subsystem specs follow: Role → Model → Relations → (State/Flows) → Invariants → Forbidden → Code map → Verification. `current-posture.agent.md` and `integration-contract.agent.md` are posture/contract digests without code map/verification.