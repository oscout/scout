import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cachedRepoKeysByRoot,
  normalizeGitRemoteUrl,
  resolveRepoKeyForRoot,
} from "./repo-identity.ts";

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
    expect(normalizeGitRemoteUrl("/Users/art/dev/openscout")).toBeNull();
    expect(normalizeGitRemoteUrl("../relative/clone")).toBeNull();
    expect(normalizeGitRemoteUrl("")).toBeNull();
    expect(normalizeGitRemoteUrl(null)).toBeNull();
  });

  test("serves cached repo keys while background enrichment warms", async () => {
    const root = mkdtempSync(join(tmpdir(), "openscout-repo-key-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:oscout/scout.git"]);

      expect(cachedRepoKeysByRoot([root]).get(root)).toBeNull();
      await expect(resolveRepoKeyForRoot(root)).resolves.toBe("github.com/oscout/scout");
      expect(cachedRepoKeysByRoot([root]).get(root)).toBe("github.com/oscout/scout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
