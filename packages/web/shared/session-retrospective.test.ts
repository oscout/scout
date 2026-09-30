import { describe, expect, test } from "bun:test";
import {
  buildSessionRetrospectiveProfile,
  normalizeJevLabels,
  retrospectiveLabelEvidence,
} from "./session-retrospective.ts";

describe("session retrospective Jev profile", () => {
  test("contains only aggregate categories and counts, never raw session values", () => {
    const profile = buildSessionRetrospectiveProfile({
      events: [
        { kind: "tool", tool: "Read", text: "private prompt", arg: "/secret/path" } as never,
        { kind: "tool", tool: "Edit" },
        { kind: "tool", tool: "Bash" },
      ],
      files: [{ state: "read" }, { state: "modified" }, { state: "created" }],
      metadata: {
        session: { model: "private-model", adapterType: "private-harness" },
        topology: {
          agents: [{ name: "private-name" }],
          relationships: [{ kind: "spawned", fromId: "private-id", toId: "private-child" }],
        },
      },
    });
    expect(profile).toEqual({
      schema: "openscout.session-retrospective.v1",
      observedEventCount: 3,
      toolActivity: { readOrSearch: 1, editOrWrite: 1, testOrBuild: 0, command: 1, other: 0 },
      fileActivity: { read: 1, created: 1, modified: 1 },
      knownAgentCount: 1,
      observedSpawnedRelationshipCount: 1,
    });
    expect(JSON.stringify(profile)).not.toMatch(/private|secret|path/);
  });

  test("selects at most two labels only when evidence exists and probability clears threshold", () => {
    const profile = buildSessionRetrospectiveProfile({
      events: [
        { kind: "tool", tool: "Read" },
        { kind: "tool", tool: "Edit" },
        { kind: "tool", tool: "Test" },
      ],
    });
    const labels = normalizeJevLabels(profile, {
      exploration: 0.82,
      implementation: 0.73,
      debugging: 0.99,
      delegation: 1,
    });
    expect(labels.map((label) => label.id)).toEqual(["debugging", "exploration"]);
    expect(labels.every((label) => label.rationale.length > 0)).toBe(true);
    expect(retrospectiveLabelEvidence(buildSessionRetrospectiveProfile({ events: [] })).some((entry) => entry.hasEvidence)).toBe(false);
  });

  test("counts shell test and build commands as testOrBuild without carrying command text", () => {
    const profile = buildSessionRetrospectiveProfile({
      events: [
        { kind: "tool", tool: "bash", arg: "cd /secret/repo && bun test server/foo.test.ts" },
        { kind: "tool", tool: "bash", arg: "npm run build" },
        { kind: "tool", tool: "bash", arg: "bun run web:check" },
        { kind: "tool", tool: "bash", arg: "git checkout main" },
        { kind: "tool", tool: "bash", arg: "ls /secret/repo" },
      ],
    });
    expect(profile.toolActivity.testOrBuild).toBe(3);
    expect(profile.toolActivity.command).toBe(2);
    expect(JSON.stringify(profile)).not.toContain("secret");
  });
});
