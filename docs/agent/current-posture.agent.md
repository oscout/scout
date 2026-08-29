# Current Posture Agent Notes

Source: `docs/current-posture.md`.

Verified: 2026-06-10

## Status

| Dimension | Current truth |
|---|---|
| Maturity | v0.x, active development |
| Best fit | high-trust local developer pilots |
| Not fit | enterprise rollout, regulated deployment, untrusted multi-tenant automation |
| License | not finalized; manifests currently use `UNLICENSED`; no top-level LICENSE |
| Install footprint | Bun, broker service, macOS launch agent, support files, optional Caddy, optional Tailscale/mesh, optional apps |
| Mesh | reachability and coordination |
| Mesh is not | exactly-once delivery, global consensus, external transcript replication |

## Trust Boundary

- Broker and Scout-owned state run locally.
- Nothing phones home by default.
- Pairing and mesh forwarding are explicit.
- Local agents often have meaningful machine access.
- Treat local agents as trusted automation unless a stricter permission profile is configured.

## Do Not Claim

- enterprise-ready
- compliance-ready
- secure multi-tenant runtime
- guaranteed distributed delivery
- stable public API for all integrations
- complete host permission capture
- open-source license unless the license files/package metadata have changed

## Link Targets

- Data boundary: `docs/architecture.md#the-data-model`
- Permission/operator attention: `docs/operator-attention-and-unblock.md`
- Trust/maturity narrative: `docs/current-posture.md`
