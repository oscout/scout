# openscout-iroh-bridge

Rust sidecar for OpenScout Mesh.

This crate owns the first Iroh boundary for issue #48:

- persist one Iroh identity per Scout node
- expose the public endpoint id as JSON
- bind an Iroh endpoint with ALPN `openscout/mesh/0`
- print the current Iroh `EndpointAddr` for Cloudflare rendezvous publication

It does not own Scout broker state. Future forwarding commands should continue to
carry the existing broker `/v1/mesh/*` JSON bundles so the TypeScript broker
handles Scout coordination writes.

## Commands

```bash
cargo run --manifest-path packages/runtime/native/iroh-bridge/Cargo.toml -- \
  identity --identity-path ~/.openscout/mesh/iroh.key

cargo run --manifest-path packages/runtime/native/iroh-bridge/Cargo.toml -- \
  serve --identity-path ~/.openscout/mesh/iroh.key \
  --broker-url http://127.0.0.1:65501

cargo run --manifest-path packages/runtime/native/iroh-bridge/Cargo.toml -- \
  forward --identity-path ~/.openscout/mesh/iroh.key \
  --endpoint-addr-json '{"id":"remote-endpoint","addrs":[]}' \
  --route messages < mesh-bundle.json
```

When `OPENSCOUT_IROH_BRIDGE_BIN` points at the compiled bridge, the TypeScript
broker can start `serve` automatically, read the printed endpoint metadata, and
publish that Iroh entrypoint on the local node.
