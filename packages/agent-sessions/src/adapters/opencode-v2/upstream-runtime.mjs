// Runtime-only bridge to the exact official product-V2 client. The package's
// current next build publishes extensionless ESM imports that Node cannot load
// directly. `npm run build` bundles this bridge into dist/upstream.js, so the
// published OpenScout package keeps the official implementation without
// depending on a consumer-side package-manager patch.
export { OpenCode } from "@opencode-ai/client";
export { Service } from "@opencode-ai/client/service";
