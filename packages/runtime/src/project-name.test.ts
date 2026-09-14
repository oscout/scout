import { describe, expect, test } from "bun:test";
import { projectNameForRoot } from "./project-name.ts";

describe("projectNameForRoot", () => {
  test("an ordinary project is named after its folder", () => {
    expect(projectNameForRoot("/Users/art/dev/openscout", "/Users/art")).toBe("openscout");
  });

  test("the home directory is never named after the user", () => {
    // The exact shape that produced `art.arts-mac-mini-local` / "Art".
    expect(projectNameForRoot("/Users/art", "/Users/art")).toBe("home");
    expect(projectNameForRoot("/Users/arach", "/Users/arach")).toBe("home");
  });

  test("a trailing slash or a relative hop is still home", () => {
    expect(projectNameForRoot("/Users/art/", "/Users/art")).toBe("home");
    expect(projectNameForRoot("/Users/art/dev/..", "/Users/art")).toBe("home");
  });

  test("a folder that merely shares the username is a real project", () => {
    // ~/art is a project called "art"; $HOME itself is not.
    expect(projectNameForRoot("/Users/art/art", "/Users/art")).toBe("art");
  });

  test("another user's home is not this operator's home", () => {
    expect(projectNameForRoot("/Users/arach", "/Users/art")).toBe("arach");
  });

  test("the filesystem root stays empty so callers fall back to \"agent\"", () => {
    expect(projectNameForRoot("/", "/Users/art")).toBe("");
  });

  test("empty in, empty out", () => {
    expect(projectNameForRoot("", "/Users/art")).toBe("");
    expect(projectNameForRoot("   ", "/Users/art")).toBe("");
  });

  test("a missing home never swallows a real project", () => {
    expect(projectNameForRoot("/Users/art/dev/openscout", "")).toBe("openscout");
  });
});
