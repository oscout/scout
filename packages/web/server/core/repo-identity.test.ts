import { describe, expect, test } from "bun:test";

import { normalizeGitRemoteUrl } from "./repo-identity.ts";

describe("normalizeGitRemoteUrl", () => {
  test("collapses ssh and https remotes to one canonical key", () => {
    const ssh = normalizeGitRemoteUrl("git@github.com:oscout/scout.git");
    expect(normalizeGitRemoteUrl("https://github.com/oscout/scout")).toBe(ssh);
    expect(normalizeGitRemoteUrl("https://github.com/oscout/scout.git")).toBe(ssh);
    expect(ssh).toBe("github.com/oscout/scout");
  });

  test("normalizes hosts while preserving nested owner paths", () => {
    expect(normalizeGitRemoteUrl("git@GitHub.COM:ExampleOrg/ExampleRepo.git")).toBe(
      "github.com/ExampleOrg/ExampleRepo",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/org/team/repo.git")).toBe(
      "gitlab.com/org/team/repo",
    );
  });

  test("handles explicit ssh URLs", () => {
    expect(normalizeGitRemoteUrl("ssh://git@github.com/oscout/scout.git")).toBe(
      "github.com/oscout/scout",
    );
  });

  test("rejects local paths and empty input", () => {
    expect(normalizeGitRemoteUrl("/Users/example/dev/openscout")).toBeNull();
    expect(normalizeGitRemoteUrl("../relative/clone")).toBeNull();
    expect(normalizeGitRemoteUrl("")).toBeNull();
    expect(normalizeGitRemoteUrl(null)).toBeNull();
  });
});
