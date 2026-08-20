import { describe, expect, test } from "bun:test";

import { formatScoutSendRoutingError, renderSendCommandHelp } from "./send.ts";

describe("renderSendCommandHelp", () => {
  test("documents tell semantics and closed routing choices", () => {
    const help = renderSendCommandHelp();

    expect(help).toContain("Tell or update another agent or an explicit channel.");
    expect(help).toContain("--to <agent>");
    expect(help).toContain("body @mentions stay text");
    expect(help).toContain("one explicit @agent + no channel   -> DM");
    expect(help).toContain("multiple targets + no channel      -> error");
    expect(help).toContain("Use `scout ask` when the meaning is \"do this and get back to me.\"");
    expect(help).toContain("When in doubt, use ask.");
    expect(help).toContain("scout ask --notify");
    expect(help).toContain("--message-file <path>");
  });
});

describe("formatScoutSendRoutingError", () => {
  test("says plainly when there is no such target", () => {
    expect(formatScoutSendRoutingError({
      unresolvedTargets: ["@mars"],
      targetDiagnostic: {
        agentId: "@mars",
        state: "unknown",
        registrationKind: null,
        projectRoot: null,
      },
    })).toBe("there is no @mars; nothing was sent.");
  });

  test("does not decorate unresolved refs as agent handles", () => {
    expect(formatScoutSendRoutingError({
      unresolvedTargets: ["ref:msg-missing"],
      targetDiagnostic: {
        agentId: "ref:msg-missing",
        state: "unknown",
        registrationKind: null,
        projectRoot: null,
      },
    })).toBe("there is no ref:msg-missing; nothing was sent.");
  });

  test("lists candidates when a short handle is ambiguous", () => {
    const message = formatScoutSendRoutingError({
      unresolvedTargets: ["@vox"],
      targetDiagnostic: {
        state: "ambiguous",
        candidates: [
          { agentId: "vox.mini.codex", label: "@vox.harness:codex" },
          { agentId: "vox.mini.claude", label: "@vox.harness:claude" },
        ],
      },
    });

    expect(message).toContain("target @vox matches multiple agents");
    expect(message).toContain("@vox.harness:codex");
    expect(message).toContain("@vox.harness:claude");
    expect(message).toContain("scout send");
  });

  test("preserves harness-qualified recovery for a native session collision", () => {
    expect(formatScoutSendRoutingError({
      unresolvedTargets: ["session:native-shared"],
      targetDiagnostic: {
        state: "ambiguous",
        candidates: [],
        detail: "session:native-shared exists in multiple harnesses (claude, codex); use session:<harness>:native-shared",
      },
    })).toBe(
      "session:native-shared exists in multiple harnesses (claude, codex); use session:<harness>:native-shared Nothing was sent.",
    );
  });
});
