# OTLP receiver implementation

Start with the [implementation and operations guide](../../../../docs/otlp.md)
for commands, HTTP behavior, sanitization, queue/storage limits, inspection
semantics, source map and verification recipes.

The [agent reference](../../../../docs/agent/otlp.agent.md) is the compact
contract. [SCO-105](../../../../docs/eng/sco-105-otel-ingest.md) describes the
broader design and future acceptance gates.

This module is an inspection receiver. Successful exports acknowledge bounded
queue admission, not durable persistence or canonical Scout usage/session state.
