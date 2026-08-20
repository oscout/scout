import { describe, expect, test } from "bun:test";

import {
  constructAgentAlias,
  constructAgentIdentity,
  diagnoseAgentIdentity,
  extractAgentIdentities,
  formatAgentReferenceIdentity,
  formatAgentAlias,
  formatAgentIdentity,
  formatMinimalAgentIdentity,
  isReservedAgentDefinitionId,
  parseAgentIdentity,
  parseAgentSelector,
  resolveAgentAlias,
  resolveAgentIdentity,
  resolveAgentSelector,
  withAgentReferenceAliases,
  OPENSCOUT_COORDINATOR_AGENT_ID,
  SCOUT_DISPATCHER_AGENT_ID,
} from "./agent-identity.js";

describe("agent identity grammar", () => {
  test("parses bare, positional, and typed identities", () => {
    expect(parseAgentIdentity("@arc")).toEqual({
      raw: "arc",
      label: "@arc",
      definitionId: "arc",
    });

    expect(parseAgentIdentity("@arc.main")).toEqual({
      raw: "arc.main",
      label: "@arc.main",
      definitionId: "arc",
      workspaceQualifier: "main",
    });

    expect(parseAgentIdentity("@arc.main.profile:dev-browser.harness:claude")).toEqual({
      raw: "arc.main.profile:dev-browser.harness:claude",
      label: "@arc.main.profile:dev-browser.harness:claude",
      definitionId: "arc",
      workspaceQualifier: "main",
      profile: "dev-browser",
      harness: "claude",
    });

    expect(parseAgentIdentity("@arc.profile:dev.main")).toEqual({
      raw: "arc.profile:dev.main",
      label: "@arc.main.profile:dev",
      definitionId: "arc",
      workspaceQualifier: "main",
      profile: "dev",
    });

    expect(parseAgentIdentity("@arc.branch:super/refactor.persona:dev-browser.runtime:codex.node:mini")).toEqual({
      raw: "arc.branch:super/refactor.persona:dev-browser.runtime:codex.node:mini",
      label: "@arc.super-refactor.profile:dev-browser.harness:codex.node:mini",
      definitionId: "arc",
      workspaceQualifier: "super-refactor",
      profile: "dev-browser",
      harness: "codex",
      nodeQualifier: "mini",
    });

    expect(parseAgentIdentity("@lattices#codex?5.5")).toEqual({
      raw: "lattices#codex?5.5",
      label: "@lattices.harness:codex.model:5-5",
      definitionId: "lattices",
      harness: "codex",
      model: "5-5",
    });

    expect(parseAgentIdentity("@lattices.main#claude?sonnet")).toEqual({
      raw: "lattices.main#claude?sonnet",
      label: "@lattices.main.harness:claude.model:sonnet",
      definitionId: "lattices",
      workspaceQualifier: "main",
      harness: "claude",
      model: "sonnet",
    });
  });

  test("parses 3-segment positional as definitionId.workspaceQualifier.nodeQualifier", () => {
    const result = parseAgentIdentity("@arc.dev.mini");
    expect(result).not.toBeNull();
    expect(result!.definitionId).toBe("arc");
    expect(result!.workspaceQualifier).toBe("dev");
    expect(result!.nodeQualifier).toBe("mini");
  });

  test("rejects invalid and legacy-shaped identities", () => {
    expect(parseAgentIdentity("")).toBeNull();
    expect(parseAgentIdentity("@arc.profile:")).toBeNull();
    expect(parseAgentIdentity("@arc@mini#main")).toBeNull();
    expect(parseAgentIdentity("@arc#")).toBeNull();
    expect(parseAgentIdentity("@arc?sonnet#claude")).toBeNull();
    expect(parseAgentIdentity("@arc.a.b.c")).toBeNull(); // 3+ positionals rejected
  });

  test("constructs canonical agent identities", () => {
    expect(constructAgentIdentity({
      definitionId: "Arc",
      workspaceQualifier: "Super Refactor",
      profile: "Dev Browser",
      harness: "Claude",
      model: "GPT-5.5",
      nodeQualifier: "Mini.local",
    })).toEqual({
      raw: "arc.super-refactor.profile:dev-browser.harness:claude.model:gpt-5-5.node:mini-local",
      label: "@arc.super-refactor.profile:dev-browser.harness:claude.model:gpt-5-5.node:mini-local",
      definitionId: "arc",
      workspaceQualifier: "super-refactor",
      profile: "dev-browser",
      harness: "claude",
      model: "gpt-5-5",
      nodeQualifier: "mini-local",
    });
  });

  test("formats canonical identities", () => {
    expect(formatAgentIdentity({
      definitionId: "arc",
      workspaceQualifier: "main",
      profile: "dev-browser",
      harness: "claude",
      model: "sonnet",
      nodeQualifier: "mini",
    })).toBe("@arc.main.profile:dev-browser.harness:claude.model:sonnet.node:mini");
  });

  test("extracts unique identities from text", () => {
    expect(extractAgentIdentities(
      "Compare @arc.main.profile:dev-browser with @hudson, then ping @arc.main.profile:dev-browser and @lattices#codex?5.5.",
    )).toEqual([
      {
        raw: "arc.main.profile:dev-browser",
        label: "@arc.main.profile:dev-browser",
        definitionId: "arc",
        workspaceQualifier: "main",
        profile: "dev-browser",
      },
      {
        raw: "hudson",
        label: "@hudson",
        definitionId: "hudson",
      },
      {
        raw: "lattices#codex?5.5",
        label: "@lattices.harness:codex.model:5-5",
        definitionId: "lattices",
        harness: "codex",
        model: "5-5",
      },
    ]);
  });

  test("keeps selector aliases as thin compatibility exports", () => {
    expect(parseAgentSelector("@arc.main.profile:dev")).toEqual({
      raw: "arc.main.profile:dev",
      label: "@arc.main.profile:dev",
      definitionId: "arc",
      workspaceQualifier: "main",
      profile: "dev",
    });
  });

  test("constructs and formats explicit aliases", () => {
    const alias = constructAgentAlias({
      alias: "@Huddy",
      target: {
        definitionId: "hudson",
        workspaceQualifier: "main",
        profile: "dev-browser",
      },
    });

    expect(alias).toEqual({
      alias: "huddy",
      target: {
        definitionId: "hudson",
        workspaceQualifier: "main",
        profile: "dev-browser",
      },
    });
    expect(formatAgentAlias(alias!)).toBe("@huddy");
  });
});

describe("agent identity resolution", () => {
  const candidates = [
    {
      agentId: "arc.default",
      definitionId: "arc",
      workspaceQualifier: "main",
      profile: "base",
      harness: "codex",
      aliases: [formatAgentIdentity({ definitionId: "arc" })],
    },
    {
      agentId: "arc.browser",
      definitionId: "arc",
      workspaceQualifier: "main",
      profile: "dev-browser",
      harness: "codex",
    },
    {
      agentId: "arc.claude",
      definitionId: "arc",
      workspaceQualifier: "super-refactor",
      profile: "dev-browser",
      harness: "claude",
      nodeQualifier: "mini",
    },
    {
      agentId: "hudson.main",
      definitionId: "hudson",
      workspaceQualifier: "hudson-main-8012ac",
      harness: "codex",
      nodeQualifier: "arachs-mac-mini-local",
      aliases: ["@huddy"],
    },
    {
      agentId: "hudson.browser",
      definitionId: "hudson",
      workspaceQualifier: "hudson-main-8012ac",
      profile: "dev-browser",
      harness: "codex",
      nodeQualifier: "arachs-mac-mini-local",
    },
    {
      agentId: "hudson.other-node",
      definitionId: "hudson",
      workspaceQualifier: "hudson-main-8012ac",
      harness: "codex",
      nodeQualifier: "backup-mac-mini",
    },
    {
      agentId: "lattices.codex-55",
      definitionId: "lattices",
      workspaceQualifier: "main",
      harness: "codex",
      model: "gpt-5.5",
    },
    {
      agentId: "lattices.codex-54",
      definitionId: "lattices",
      workspaceQualifier: "main",
      harness: "codex",
      model: "gpt-5.4",
    },
    {
      agentId: "lattices.sonnet",
      definitionId: "lattices",
      workspaceQualifier: "main",
      harness: "claude",
      model: "claude-sonnet-4-6",
    },
  ];

  test("prefers explicit default aliases for bare identities", () => {
    const identity = parseAgentIdentity("@arc");
    expect(identity).not.toBeNull();
    expect(resolveAgentIdentity(identity!, candidates)).toEqual(candidates[0]);
  });

  test("resolves typed qualifiers to the matching concrete agent", () => {
    const identity = parseAgentIdentity("@arc.main.profile:dev-browser");
    expect(identity).not.toBeNull();
    expect(resolveAgentIdentity(identity!, candidates)).toEqual(candidates[1]);
  });

  test("resolves fully qualified identities including harness and node", () => {
    const identity = parseAgentIdentity("@arc.super-refactor.profile:dev-browser.harness:claude.node:mini");
    expect(identity).not.toBeNull();
    expect(resolveAgentIdentity(identity!, candidates)).toEqual(candidates[2]);
  });

  test("returns null for ambiguous non-default partial identities", () => {
    const identity = parseAgentIdentity("@arc.profile:dev-browser");
    expect(identity).not.toBeNull();
    expect(resolveAgentIdentity(identity!, candidates)).toBeNull();
  });

  test("keeps selector resolution aliases as thin compatibility exports", () => {
    const identity = parseAgentSelector("@arc.main.profile:dev-browser");
    expect(identity).not.toBeNull();
    expect(resolveAgentSelector(identity!, candidates)).toEqual(candidates[1]);
  });

  test("resolves exact human aliases before canonical matching", () => {
    const identity = parseAgentIdentity("@huddy");
    expect(identity).not.toBeNull();
    expect(resolveAgentIdentity(identity!, candidates)).toEqual(candidates[3]);
  });

  test("resolves shorthand harness and model qualifiers", () => {
    const codex = parseAgentIdentity("@lattices#codex?5.5");
    expect(codex).not.toBeNull();
    expect(resolveAgentIdentity(codex!, candidates)).toEqual(candidates[6]);

    const sonnet = parseAgentIdentity("@lattices#claude?sonnet");
    expect(sonnet).not.toBeNull();
    expect(resolveAgentIdentity(sonnet!, candidates)).toEqual(candidates[8]);
  });

  test("resolves aliases through the explicit alias table", () => {
    const identity = resolveAgentAlias("@huddy", [
      {
        alias: "huddy",
        target: {
          definitionId: "hudson",
          workspaceQualifier: "hudson-main-8012ac",
          harness: "codex",
          nodeQualifier: "arachs-mac-mini-local",
        },
      },
    ]);

    expect(identity).toEqual({
      raw: "hudson.hudson-main-8012ac.harness:codex.node:arachs-mac-mini-local",
      label: "@hudson.hudson-main-8012ac.harness:codex.node:arachs-mac-mini-local",
      definitionId: "hudson",
      workspaceQualifier: "hudson-main-8012ac",
      harness: "codex",
      nodeQualifier: "arachs-mac-mini-local",
    });
  });

  test("formats the shortest unambiguous identity for a candidate", () => {
    expect(formatMinimalAgentIdentity(candidates[0], candidates)).toBe("@arc");
    expect(formatMinimalAgentIdentity(candidates[1], candidates)).toBe("@arc.main.profile:dev-browser");
    expect(formatMinimalAgentIdentity(candidates[2], candidates)).toBe("@arc.super-refactor");
    expect(formatMinimalAgentIdentity(candidates[3], candidates)).toBe("@huddy");
    expect(formatMinimalAgentIdentity(candidates[4], candidates)).toBe(
      "@hudson.profile:dev-browser",
    );
    expect(formatMinimalAgentIdentity(candidates[5], candidates)).toBe("@hudson.node:backup-mac-mini");
  });

  test("formats compact reference identities and expands on family collisions", () => {
    const referenceCandidates = [
      {
        agentId: "hudson.branch-alpha-12345.mini",
        definitionId: "hudson",
        referenceId: "branch-alpha-12345",
      },
      {
        agentId: "hudson.branch-beta-12345.mini",
        definitionId: "hudson",
        referenceId: "branch-beta-12345",
      },
      {
        agentId: "arc.branch-alpha-12345.mini",
        definitionId: "arc",
        referenceId: "branch-alpha-12345",
      },
    ];

    expect(formatAgentReferenceIdentity(referenceCandidates[0]!, referenceCandidates)).toBe("@hudson.ha12345");
    expect(formatAgentReferenceIdentity(referenceCandidates[1]!, referenceCandidates)).toBe("@hudson.ta12345");
    expect(formatAgentReferenceIdentity(referenceCandidates[2]!, referenceCandidates)).toBe("@arc.12345");
  });

  test("resolves compact reference identities through generated aliases", () => {
    const referenceCandidates = withAgentReferenceAliases([
      {
        agentId: "hudson.branch-alpha-12345.mini",
        definitionId: "hudson",
        referenceId: "branch-alpha-12345",
      },
      {
        agentId: "hudson.branch-beta-12345.mini",
        definitionId: "hudson",
        referenceId: "branch-beta-12345",
      },
    ]);

    const identity = parseAgentIdentity("@hudson.ha12345");
    expect(identity).not.toBeNull();
    expect(resolveAgentIdentity(identity!, referenceCandidates)?.agentId).toBe("hudson.branch-alpha-12345.mini");
  });
});

describe("scout dispatcher reservation", () => {
  test("reserves the scout definition id", () => {
    expect(SCOUT_DISPATCHER_AGENT_ID).toBe("scout");
    expect(OPENSCOUT_COORDINATOR_AGENT_ID).toBe("openscout");
    expect(isReservedAgentDefinitionId("scout")).toBe(true);
    expect(isReservedAgentDefinitionId("Scout")).toBe(true);
    expect(isReservedAgentDefinitionId("SCOUT ")).toBe(true);
    expect(isReservedAgentDefinitionId("scoutie")).toBe(false);
    expect(isReservedAgentDefinitionId("scout-ie")).toBe(false);
    expect(isReservedAgentDefinitionId("")).toBe(false);
    expect(isReservedAgentDefinitionId(null)).toBe(false);
    expect(isReservedAgentDefinitionId(undefined)).toBe(false);
  });

  test("resolves @scout to the stable OpenScout coordinator", () => {
    const identity = parseAgentIdentity("@scout");
    expect(identity).not.toBeNull();
    const candidates = [
      {
        agentId: "openscout.main.mini",
        definitionId: "openscout",
        nodeQualifier: "mini",
        workspaceQualifier: "main",
      },
      {
        agentId: "ranger.main.mini",
        definitionId: "ranger",
        nodeQualifier: "mini",
        workspaceQualifier: "main",
      },
    ];
    const result = diagnoseAgentIdentity(identity!, candidates);
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.match.agentId).toBe("openscout.main.mini");
    }
    expect(formatMinimalAgentIdentity(candidates[0]!, candidates)).toBe("@scout");
  });
});

describe("agent identity diagnosis", () => {
  const scoutieMiniMain = {
    agentId: "scoutie.mini.main",
    definitionId: "scoutie",
    nodeQualifier: "mini",
    workspaceQualifier: "main",
    aliases: ["@scoutie.main.node:mini", "@scoutie"],
  };
  const scoutieMainMini = {
    agentId: "scoutie.main.mini",
    definitionId: "scoutie",
    nodeQualifier: "mini",
    workspaceQualifier: "main",
    aliases: ["@scoutie.main.node:mini", "@scoutie"],
  };
  const arachMini = {
    agentId: "arach.mini",
    definitionId: "arach",
    nodeQualifier: "mini",
    aliases: ["@arach.node:mini", "@arach"],
  };

  test("returns resolved when exactly one candidate matches", () => {
    const identity = parseAgentIdentity("@arach");
    expect(identity).not.toBeNull();
    const result = diagnoseAgentIdentity(identity!, [scoutieMiniMain, arachMini]);
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.match.agentId).toBe("arach.mini");
    }
  });

  test("returns ambiguous when multiple exact alias matches exist", () => {
    const identity = parseAgentIdentity("@scoutie");
    expect(identity).not.toBeNull();
    const result = diagnoseAgentIdentity(identity!, [scoutieMiniMain, scoutieMainMini, arachMini]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((c) => c.agentId).sort()).toEqual([
        "scoutie.main.mini",
        "scoutie.mini.main",
      ]);
    }
  });

  test("returns unknown when no candidate matches", () => {
    const identity = parseAgentIdentity("@nonexistent");
    expect(identity).not.toBeNull();
    const result = diagnoseAgentIdentity(identity!, [scoutieMiniMain, arachMini]);
    expect(result.kind).toBe("unknown");
  });

  test("resolveAgentIdentity returns null on ambiguity (back-compat)", () => {
    const identity = parseAgentIdentity("@scoutie");
    expect(resolveAgentIdentity(identity!, [scoutieMiniMain, scoutieMainMini])).toBeNull();
  });
});
