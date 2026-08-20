import { describe, expect, test } from "bun:test";

import { renderScoutHelp } from "./help.ts";

describe("renderScoutHelp", () => {
  test("documents the operator loop, lifecycle, and routing model", () => {
    const help = renderScoutHelp("0.2.99");

    expect(help).toContain("Fast path:");
    expect(help).toContain("Orientation (only when route or sender is unclear):");
    expect(help).toContain("scout search index");
    expect(help).toContain("scout search query");
    expect(help).toContain("scout search status");
    expect(help).toContain("Lifecycle:");
    expect(help).toContain("one target -> DM");
    expect(help).toContain("multiple targets + no channel");
    expect(help).toContain("File-backed input:");
    expect(help).toContain("--prompt-file");
    expect(help).toContain("--message-file");
    expect(help).toContain("Project targets:");
    expect(help).toContain("scout ask --project ../talkie");
    expect(help).toContain("scout ask --harness codex");
    expect(help).toContain("no agent id needed");
    expect(help).toContain("quote >> in shells");
    expect(help).toContain("Doctor flags:");
    expect(help).toContain("scout doctor --fix --yes");
    expect(help).toContain("scout providers usage");
    expect(help).toContain("MCP parity:");
    expect(help).toContain("scout card create");
  });
});
