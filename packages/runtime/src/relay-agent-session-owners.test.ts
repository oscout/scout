import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listRelayAgentTmuxSessionOwners } from "./local-agents.js";
import { writeRelayAgentProcessLease } from "./relay-agent-process-leases.js";

const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalNodeQualifier = process.env.OPENSCOUT_NODE_QUALIFIER;
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "openscout-session-owners-"));
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(tempRoot, "support");
  process.env.OPENSCOUT_NODE_QUALIFIER = "test-node";
  mkdirSync(process.env.OPENSCOUT_SUPPORT_DIRECTORY, { recursive: true });
});

afterEach(() => {
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalNodeQualifier === undefined) {
    delete process.env.OPENSCOUT_NODE_QUALIFIER;
  } else {
    process.env.OPENSCOUT_NODE_QUALIFIER = originalNodeQualifier;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("listRelayAgentTmuxSessionOwners", () => {
  test("maps configured, legacy, and lease-claimed session names to their agents", async () => {
    const projectRoot = join(tempRoot, "projects", "talkie");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(process.env.OPENSCOUT_SUPPORT_DIRECTORY!, "relay-agents.json"), JSON.stringify({
      version: 1,
      agents: {
        "session-abc123": {
          agentId: "session-abc123",
          definitionId: "session-abc123",
          projectName: "talkie",
          projectRoot,
          defaultHarness: "claude",
          runtime: {
            cwd: projectRoot,
            harness: "claude",
            transport: "tmux",
            sessionId: "session-abc123",
            wakePolicy: "on_demand",
          },
        },
      },
    }), "utf8");

    writeRelayAgentProcessLease({
      agentId: "session-lease-only",
      sessionName: "session-lease-only",
      ownerPid: 4242,
      startedAtMs: Date.now(),
    });

    const owners = await listRelayAgentTmuxSessionOwners();

    // The configured session name, plus the legacy relay-<agentId> fallback.
    // Owner values carry the instance-qualified id the broker itself uses.
    expect(owners.get("session-abc123")).toBe("session-abc123.test-node");
    expect(owners.get("relay-session-abc123-test-node")).toBe("session-abc123.test-node");
    // A lease claims sessions that no registration knows about anymore.
    expect(owners.get("session-lease-only")).toBe("session-lease-only");
    // No entry ever exists for a session nobody claims.
    expect(owners.has("operator-scratchpad")).toBe(false);
  });
});
