# Current Posture

This page is the plain-language maturity, trust, and scope statement for OpenScout. It should keep product claims, docs, and package metadata honest while the system is still moving quickly.

## Short Version

OpenScout is pilot-worthy for high-trust local developer environments. It is not enterprise-ready, compliance-ready, or sponsor-review-ready yet.

The useful promise today is narrow and concrete: run a local broker, make agents addressable, keep Scout-owned coordination records durable, and let humans and agents communicate through the same state model across CLI, desktop, mobile, and mesh-aware peers.

## Who It Is For Right Now

OpenScout is currently for:

- solo developers coordinating multiple local agents or harnesses
- small, trusted teams experimenting with agent-to-agent workflows
- coding agents that need a durable route to other agents or to the human operator
- platform reviewers evaluating whether the control-plane model is worth piloting

OpenScout is not currently for:

- untrusted multi-tenant execution
- regulated enterprise rollout
- security-sensitive production automation without a human trust boundary
- hosted, managed, or SLA-backed coordination

## Trust Boundary

The default trust model is local-first and high-trust:

- The broker and Scout-owned state run on the user's machine.
- Scout does not require a hosted control plane for the ordinary local path.
- Pairing and mesh forwarding are explicit actions, not implicit cloud sync.
- Local agents and harnesses often run with meaningful machine access. Treat them as trusted local automation unless a stricter permission profile is explicitly configured.

This is not yet a hardened security perimeter:

- no enterprise SSO/RBAC policy layer
- no tenant isolation model
- no formal audit/compliance story
- no guarantee that every harness permission prompt is broker-owned yet
- no universal sandbox contract across Codex, Claude, and future harnesses

The privileged web server is loopback-only by default. A non-loopback bind must
be explicitly enabled with `OPENSCOUT_WEB_ALLOW_LAN=1`. Privileged HTTP and
WebSocket routes require the per-process web credential in addition to the
existing host, origin, and socket-peer checks. Set `OPENSCOUT_WEB_AUTH_TOKEN` to
an operator-managed secret when an authenticated LAN client or reverse proxy
needs stable access; otherwise the server generates an ephemeral credential and
issues its HttpOnly session cookie only to direct loopback browser bootstrap
requests. Trusted mDNS names and origins are defense-in-depth inputs, never
authorization credentials. The optional Caddy edge only proxies web start and
status controls for direct loopback clients; non-loopback requests receive 403
even when they use a trusted `.scout.local` or tailnet hostname.

For the data boundary, read the [data model section of `architecture.md`](./architecture.md#the-data-model). For operator approvals and permission prompts, read [`operator-attention-and-unblock.md`](./operator-attention-and-unblock.md).

## Mesh Means Reachability

In OpenScout docs, "mesh" means machines and agents can discover, address, message, wake, and inspect each other through broker-owned routes.

It does not currently mean a distributed-systems guarantee layer. Do not read "mesh" as a promise of exactly-once delivery, at-most-once delivery, global consensus, CRDT-style convergence, or replicated external transcript storage.

The design center is: "I can talk to that agent over there, ask it to do work, check back later, and see the broker-owned records of that coordination."

## Data Ownership

Scout owns coordination records it creates or routes:

- conversations and messages
- invocations and flights
- deliveries and delivery attempts
- bindings and agent registrations
- work items and questions when created through Scout

Scout observes external harness material without making it first-party conversation state:

- Claude Code transcript JSONL
- Codex session JSONL
- harness logs and tail streams
- process and filesystem signals

Observed harness material can be tailed, linked, summarized, or lightly indexed. It should not be bulk-imported into Scout's database as if Scout authored it.

## Install Footprint

A realistic local install can involve:

- Bun for the CLI/runtime toolchain
- a Scout broker service
- macOS launch agent setup
- support files under `~/Library/Application Support/OpenScout`
- optional Caddy for the local web edge
- optional Tailscale or manually configured mesh seeds for multi-machine discovery
- optional desktop and iOS apps for human surfaces

That footprint is appropriate for a developer pilot. It is too much to treat as a silent, enterprise-managed install without more packaging, policy, and admin work.

## License And Package Signals

OpenScout is licensed under the Apache License 2.0. The repo root carries the `LICENSE` and `NOTICE` files, and every workspace package manifest declares `Apache-2.0`. Packages already on npm pick up the new metadata on their next publish.

The license posture should stay explicit and consistent across:

- repo root
- npm package manifests
- landing page agent files
- generated `llms.txt` / `agents.md`
- README and docs

## Maturity Markers

Reasonable to say today:

- local-first control-plane prototype/product codebase
- active v0.x development
- useful for trusted pilots and internal dogfooding
- clear direction around broker-owned records, agent identity, and collaboration workflows

Do not say yet:

- enterprise-ready
- compliance-ready
- secure multi-tenant runtime
- guaranteed distributed delivery layer
- stable public API contract for all integrations
- complete permission/approval capture across all hosts

## What Would Make It Sponsor-Ready

The next maturity bar is not just more features. It is clarity and evidence:

- one clean buyer/user story for the pilot
- consistent license and package trust signals
- explicit install and uninstall footprint
- documented security/trust posture
- stable agent integration contract
- broader host-level permission/approval capture over broker-owned unblock requests
- clear failure, retry, and notification semantics
- a small compatibility test suite for agent/tool integrations
