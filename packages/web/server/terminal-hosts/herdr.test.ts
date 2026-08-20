import { describe, expect, test } from "bun:test";

import { herdrTerminalHost, unwrapHerdrPaneRead } from "./herdr.ts";

/** An environment where no `herdr` binary can be found. */
const NO_HERDR = { ...process.env, PATH: "/nonexistent-scout-probe", OPENSCOUT_HERDR_BIN: "" };

describe("herdr create", () => {
  test("a missing binary is a refusal, not a crashed web process", async () => {
    // `spawn()` does not throw for a missing binary: it reports ENOENT
    // asynchronously through the child's `error` event, and an EventEmitter
    // `error` with no listener is re-thrown on the event loop where the
    // surrounding try/catch cannot reach it. With herdr absent — or uninstalled
    // between the availability probe and this call — that took the whole server
    // down. This test passing at all is most of the point: an unhandled error
    // here fails the run.
    const result = await herdrTerminalHost.create!(
      { sessionName: "scout-herdr-create-test" },
      { env: NO_HERDR },
    );

    expect(result.created).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test("refuses to create the default session, which is not Scout's", async () => {
    expect(await herdrTerminalHost.create!({ sessionName: "default" }, { env: NO_HERDR }))
      .toEqual({ created: false, reason: "the default herdr session is not Scout's to create" });
  });

  test("says plainly that it did not resume a harness", async () => {
    // Scout creates the herdr session and its first workspace; herdr owns what
    // runs inside. Reporting a resume it did not perform is how an operator
    // ends up staring at a shell where their agent used to be.
    const result = await herdrTerminalHost.create!(
      { sessionName: "scout-herdr-create-test", resumeCommand: "claude --resume abc" },
      { env: NO_HERDR },
    );
    // The binary is missing here, so creation fails first; the contract that
    // matters is that `resumed` is never silently true.
    expect(result.resumed ?? false).toBe(false);
  });
});

describe("unwrapHerdrPaneRead", () => {
  test("peels the CLI JSON envelope off `agent read --format text`", () => {
    // herdr 0.7.3 answers even --format text reads in the {id, result} envelope.
    const envelope = JSON.stringify({
      id: "cli:agent:read",
      result: {
        type: "pane_read",
        read: { format: "text", pane_id: "w2:p6", text: "$ echo hi\nhi\n", truncated: false },
      },
    });
    expect(unwrapHerdrPaneRead(envelope)).toBe("$ echo hi\nhi\n");
  });

  test("passes plain text and unparseable output through untouched", () => {
    expect(unwrapHerdrPaneRead("$ echo hi\n")).toBe("$ echo hi\n");
    expect(unwrapHerdrPaneRead("")).toBe("");
  });
});
