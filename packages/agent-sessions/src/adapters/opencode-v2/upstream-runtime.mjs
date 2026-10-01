// Runtime-only bridge to the official product-V2 client. `npm run build`
// bundles this bridge into dist/upstream.js (the Promise client and service
// helper need only Node builtins), so the published OpenScout package carries
// the official implementation without exposing the client's effect-typed
// declarations or adding its dependency tree to consumers.
export { OpenCode } from "@opencode/client";
export { Service } from "@opencode/client/service";
