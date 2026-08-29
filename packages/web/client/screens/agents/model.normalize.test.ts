import { describe, expect, test } from "bun:test";

import {
  canonicalProjectRoot,
  disambiguateProjectSlugs,
  projectIdentity,
  projectKeyFrom,
  projectSlug,
  reconcileRootlessSlices,
  type ReconcilableSlice,
} from "./project-identity.ts";

/* Regression guard for the directory's identity-normalization layer: the live
   broker feed fragments one project into many (cwd vs agent-identity titles,
   node qualifiers, case, null-cwd ghosts). These assertions lock the collapse. */

describe("canonicalProjectRoot", () => {
  // Canonical form is "~"-relative: the broker reports one repo two ways — an
  // agent's "~/dev/x" projectRoot and a session's absolute "/Users/art/dev/x"
  // workspaceRoot — and both must converge so the project doesn't split in two.
  test("keeps a repo root, canonicalized to ~-relative", () => {
    expect(canonicalProjectRoot("/Users/art/dev/openscout")).toBe("~/dev/openscout");
  });
  test("an absolute path and its ~-relative twin resolve identically", () => {
    expect(canonicalProjectRoot("/Users/art/dev/openscout")).toBe(
      canonicalProjectRoot("~/dev/openscout"),
    );
    expect(canonicalProjectRoot("/Users/art/dev/openscout/packages/web")).toBe(
      canonicalProjectRoot("~/dev/openscout"),
    );
  });
  test("collapses a worktree family to its repo root", () => {
    expect(canonicalProjectRoot("/Users/art/dev/openscout-c2")).toBe("~/dev/openscout");
  });
  test("collapses common worktree container paths to the base checkout", () => {
    expect(canonicalProjectRoot("/Users/art/dev/openscout-worktrees/feature-a")).toBe("~/dev/openscout");
    expect(canonicalProjectRoot("/Users/art/dev/openscout/.worktrees/feature-a")).toBe("~/dev/openscout");
    expect(canonicalProjectRoot("/Users/art/dev/openscout/worktrees/feature-a/packages/web")).toBe("~/dev/openscout");
  });
  test("keeps a standalone worktrees-named checkout distinct", () => {
    expect(canonicalProjectRoot("/Users/art/dev/openscout-worktrees")).toBe("~/dev/openscout-worktrees");
  });
  test("collapses a numbered node/clone sibling onto its base", () => {
    expect(canonicalProjectRoot("/Users/art/dev/openscout-185")).toBe("~/dev/openscout");
  });
  test("keeps real variant siblings distinct (non-numeric suffix)", () => {
    expect(canonicalProjectRoot("/Users/art/dev/pomo-native")).toBe("~/dev/pomo-native");
    expect(canonicalProjectRoot("/Users/art/dev/pomo-tauri")).toBe("~/dev/pomo-tauri");
  });
  test("collapses a deep cwd to the repo root", () => {
    expect(canonicalProjectRoot("/Users/art/dev/openscout/packages/web")).toBe("~/dev/openscout");
  });
  test("rejects a bare home dir (not a project)", () => {
    expect(canonicalProjectRoot("/Users/art")).toBeNull();
    expect(canonicalProjectRoot("~")).toBeNull();
  });
  test("rejects empty input", () => {
    expect(canonicalProjectRoot(null)).toBeNull();
    expect(canonicalProjectRoot("")).toBeNull();
  });
});

describe("projectSlug", () => {
  test("strips a trailing node/number qualifier", () => {
    expect(projectSlug("Openscout 185")).toBe("openscout");
    expect(projectSlug("openscout-185")).toBe("openscout");
  });
  test("is case/punctuation insensitive", () => {
    expect(projectSlug("Pi Scout")).toBe(projectSlug("pi-scout"));
    expect(projectSlug("Usetalkie Com")).toBe(projectSlug("usetalkie.com"));
  });
});

describe("projectKeyFrom", () => {
  test("same root, different titles → same key", () => {
    const a = projectKeyFrom("/Users/art/dev/openscout", "Openscout");
    const b = projectKeyFrom("/Users/art/dev/openscout", "openscout-185");
    expect(a).toBe(b);
    expect(a).toBe("root:~/dev/openscout");
  });
  test("absolute and ~-relative roots of one repo share a key", () => {
    expect(projectKeyFrom("/Users/art/dev/openscout", "Openscout")).toBe(
      projectKeyFrom("~/dev/openscout", "Openscout"),
    );
  });
  test("a numbered clone sibling shares the base project's key", () => {
    expect(projectKeyFrom("/Users/art/dev/openscout-185", "Openscout 185")).toBe(
      "root:~/dev/openscout",
    );
  });
});

describe("projectIdentity slug", () => {
  test("is a short, URL-clean basename — not the root: key", () => {
    expect(projectIdentity("Talkie", "/Users/art/dev/talkie").slug).toBe("talkie");
    expect(projectIdentity("Pi Scout", "/Users/art/dev/pi-scout").slug).toBe("pi-scout");
  });
  test("collapses node-qualified titles and worktree families", () => {
    expect(projectIdentity("openscout-185", "/Users/art/dev/openscout-c2").slug).toBe("openscout");
  });
  test("uses the base project slug for worktree container checkouts", () => {
    expect(projectIdentity("feature-a", "/Users/art/dev/openscout-worktrees/feature-a").slug).toBe("openscout");
  });
  test("rootless junk falls back to a usable slug", () => {
    expect(projectIdentity("Usetalkie.com", null).slug).toBe("usetalkie-com");
    expect(projectIdentity("", null).slug).toBe("unscoped");
  });
});

describe("disambiguateProjectSlugs", () => {
  test("same basename, different roots stay distinct while the preferred project keeps the clean slug", () => {
    const a = projectIdentity("Talkie", "/Users/art/dev/talkie");
    const b = projectIdentity("Talkie", "/Users/art/work/talkie");
    expect(a.slug).toBe(b.slug); // both bare "talkie" before disambiguation
    disambiguateProjectSlugs([a, b]);
    expect(a.slug).not.toBe(b.slug);
    expect(a.slug).toBe("talkie");
    expect(b.slug.startsWith("talkie-")).toBe(true);
  });
  test("macOS temp-project collisions do not force the real checkout onto a noisy route", () => {
    const primary = projectIdentity("Openscout", "/Users/art/dev/openscout");
    const temp = projectIdentity(
      "Openscout",
      "/var/folders/gq/hhq6lhks2dn7_s4j_f25hj040000gn/T/openscout-runtime-test-iKqB29/projects/openscout",
    );
    disambiguateProjectSlugs([primary, temp]);
    expect(primary.slug).toBe("openscout");
    expect(temp.slug).toMatch(/^openscout-/);
  });
  test("unique basename keeps its clean one-word slug", () => {
    const a = projectIdentity("Talkie", "/Users/art/dev/talkie");
    const b = projectIdentity("Hudson", "/Users/art/dev/hudson");
    disambiguateProjectSlugs([a, b]);
    expect(a.slug).toBe("talkie");
    expect(b.slug).toBe("hudson");
  });
  test("the discriminator is stable for a given root", () => {
    const first = projectIdentity("Talkie", "/Users/art/work/talkie");
    const second = projectIdentity("Talkie", "/Users/art/work/talkie");
    const collider = () => projectIdentity("Talkie", "/Users/art/dev/talkie");
    disambiguateProjectSlugs([first, collider()]);
    disambiguateProjectSlugs([second, collider()]);
    expect(first.slug).toBe(second.slug);
  });
});

function makeSlice(
  title: string,
  root: string | null,
  counts: { agents?: number; scout?: number; native?: number } = {},
): ReconcilableSlice {
  const id = projectIdentity(title, root);
  return {
    ...id,
    agents: Array.from({ length: counts.agents ?? 0 }, () => ({})),
    scoutSessions: Array.from({ length: counts.scout ?? 0 }, () => ({})),
    nativeSessions: Array.from({ length: counts.native ?? 0 }, () => ({})),
    workflows: [],
  };
}

function intoMap(slices: ReconcilableSlice[]): Map<string, ReconcilableSlice> {
  const map = new Map<string, ReconcilableSlice>();
  for (const s of slices) {
    const existing = map.get(s.key);
    if (existing) {
      existing.agents.push(...s.agents);
      existing.scoutSessions.push(...s.scoutSessions);
      existing.nativeSessions.push(...s.nativeSessions);
    } else {
      map.set(s.key, s);
    }
  }
  return map;
}

describe("reconcileRootlessSlices", () => {
  test("folds rootless variants into their rooted project and drops ghosts", () => {
    const map = intoMap([
      makeSlice("openscout", "/Users/art/dev/openscout", { agents: 1 }),
      makeSlice("Openscout 185", null, { agents: 1 }),
      makeSlice("openscout-185", null, { agents: 1 }),
      makeSlice("pi-scout", "/Users/art/dev/pi-scout", { agents: 1 }),
      makeSlice("Pi Scout", null, { scout: 1 }),
      makeSlice("empty", null, { native: 1 }),
      makeSlice("unknown", null, { native: 2 }),
      makeSlice("Arach Dev", null, { agents: 1 }),
    ]);

    reconcileRootlessSlices(map);

    const titles = [...map.values()].map((s) => s.title).sort();
    expect(titles).toEqual(["Arach Dev", "Openscout", "Pi Scout"]);

    const openscout = [...map.values()].find((s) => s.title === "Openscout")!;
    // 1 rooted + 2 folded node-qualified variants
    expect(openscout.agents.length).toBe(3);

    const piScout = [...map.values()].find((s) => s.title === "Pi Scout")!;
    expect(piScout.scoutSessions.length).toBe(1);

    // empty / unknown were unplaceable ghosts (no agent, no conversation)
    expect([...map.values()].some((s) => /empty|unknown/i.test(s.title))).toBe(false);
  });
});
