import { describe, expect, test } from "bun:test";

import {
  parseRustProtocolSpec,
  renderRustProtocolSpecMarkdown,
} from "./extract-rust-protocol-spec.mjs";

const SAMPLE_SOURCE = `
//! Shared protocol facade for tests.
//!
//! - Initializes the client.
//! - Resolves server requests.

pub use codex_app_server::in_process::DEFAULT_IN_PROCESS_CHANNEL_CAPACITY;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ServerRequest;
use codex_app_server_protocol::JSONRPCErrorError;

pub struct InProcessClientStartArgs {
    pub client_name: String,
    pub channel_capacity: usize,
}

pub enum AppServerEvent {
    Lagged { skipped: usize },
    ServerRequest(ServerRequest),
}

pub type RequestResult = std::result::Result<serde_json::Value, JSONRPCErrorError>;

v2_enum_from_core!(
    pub enum PermissionGrantScope from CorePermissionGrantScope {
        Turn,
        Session
    }
);

impl InProcessClientStartArgs {
    /// Starts the session facade.
    pub async fn start(&self, request: ClientRequest) -> RequestResult {
        let _ = request;
        unimplemented!()
    }

    fn helper(&self) {}
}

pub(crate) fn reject_server_request(error: JSONRPCErrorError) -> RequestResult {
    Err(error)
}
`;

describe("extract-rust-protocol-spec", () => {
  test("parses public items, impl methods, and macro invocations", () => {
    const spec = parseRustProtocolSpec(SAMPLE_SOURCE, "/tmp/sample.rs");

    expect(spec.fileName).toBe("sample.rs");
    expect(spec.moduleDocs).toContain("Shared protocol facade for tests.");
    expect(spec.publicReexports).toContain("codex_app_server::in_process::DEFAULT_IN_PROCESS_CHANNEL_CAPACITY");
    expect(spec.protocolImports).toContain("codex_app_server_protocol::ClientRequest");
    expect(spec.types.some((item) => item.name === "InProcessClientStartArgs" && item.kind === "struct")).toBe(true);
    expect(spec.types.some((item) => item.name === "AppServerEvent" && item.kind === "enum")).toBe(true);
    expect(spec.impls).toHaveLength(1);
    expect(spec.impls[0]?.target).toBe("InProcessClientStartArgs");
    expect(spec.impls[0]?.methods.map((method) => method.name)).toEqual(["start"]);
    expect(spec.macros.map((macro) => macro.name)).toEqual(["v2_enum_from_core"]);
    expect(spec.functions.map((fn) => fn.name)).toEqual(["reject_server_request"]);
    expect(spec.responsibilities).toContain("requires explicit server-request resolution or rejection");
  });

  test("renders a markdown summary", () => {
    const spec = parseRustProtocolSpec(SAMPLE_SOURCE, "/tmp/sample.rs");
    const markdown = renderRustProtocolSpecMarkdown(spec);

    expect(markdown).toContain("# Rust Protocol Spec: sample.rs");
    expect(markdown).toContain("## Module Summary");
    expect(markdown).toContain("### `AppServerEvent` enum");
    expect(markdown).toContain("### `InProcessClientStartArgs`");
    expect(markdown).toContain("`pub async fn start(&self, request: ClientRequest) -> RequestResult`");
    expect(markdown).toContain("## Macro Invocations");
  });
});
