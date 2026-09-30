import { describe, expect, test } from "bun:test";

import { renderTellCommandHelp } from "./tell.ts";
import { parseTellCommandOptions } from "../options.ts";

describe("renderTellCommandHelp", () => {
  test("documents message-only semantics", () => {
    const help = renderTellCommandHelp();

    expect(help).toContain("Tell never creates new owned work.");
    expect(help).toContain("--to <agent>");
    expect(help).toContain("body @mentions stay text");
    expect(help).toContain("no target + no channel             -> error");
    expect(help).toContain("multiple targets + no channel      -> error");
    expect(help).toContain("use `scout ask` (or `scout send --tracked --to`)");
    expect(help).toContain("explicit spelling of a plain `scout send`");
    expect(help).toContain("--message-file <path>");
  });
});

describe("parseTellCommandOptions", () => {
  test("parses the message-only option surface", () => {
    const options = parseTellCommandOptions(
      ["--to", "hudson", "--speak", "review completed"],
      "/tmp",
    );
    expect(options.targetLabel).toBe("hudson");
    expect(options.shouldSpeak).toBe(true);
    expect(options.message).toBe("review completed");
  });

  test("rejects tracked-send flags instead of swallowing them into the body", () => {
    for (const flag of ["--tracked", "--no-notifs", "--wait", "--timeout=30"]) {
      expect(() =>
        parseTellCommandOptions(["--to", "hudson", flag, "hello"], "/tmp"),
      ).toThrow(/scout send/);
    }
  });

  test("rejects --wake because tell never launches a target", () => {
    expect(() =>
      parseTellCommandOptions(["--to", "hudson", "--wake", "hello"], "/tmp"),
    ).toThrow(/never wakes/);
  });

  test("rejects repeated destinations instead of keeping the last one", () => {
    expect(() =>
      parseTellCommandOptions(
        ["--to", "hudson", "--to", "vox", "hello"],
        "/tmp",
      ),
    ).toThrow(/exactly one destination/);
  });
});
