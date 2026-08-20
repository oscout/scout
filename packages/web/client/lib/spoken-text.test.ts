import { describe, expect, test } from "bun:test";

import { toSpokenScoutText } from "./spoken-text.ts";

describe("toSpokenScoutText", () => {
  test("shortens Scout session ids for speech", () => {
    expect(toSpokenScoutText("Open session 4f777cde-f47a-4700-8f51-347a60278df6."))
      .toBe("Open session ending in 8 d f 6.");
  });

  test("keeps written precision out of spoken agent ids", () => {
    expect(toSpokenScoutText("Ask @openscout.codex-scoutbot-server-credentials.air-local next."))
      .toBe("Ask openscout, codex scoutbot server credentials next.");
  });

  test("drops default branch and local node qualifiers", () => {
    expect(toSpokenScoutText("Hudson is hudson.main.air-local."))
      .toBe("Hudson is hudson.");
  });

  test("does not rewrite ordinary web domains as agent names", () => {
    expect(toSpokenScoutText("See https://openscout.app/docs for details."))
      .toBe("See openscout dot app for details.");
  });

  test("omits code blocks at the TTS boundary", () => {
    expect(toSpokenScoutText("Run this: ```bash\nscout who\n``` then continue."))
      .toBe("Run this: code omitted then continue.");
  });

  test("drops bold and italic markdown markers", () => {
    expect(toSpokenScoutText("I recommend **joining** the *font-studio* channel."))
      .toBe("I recommend joining the font-studio channel.");
  });

  test("drops underscore italic markers", () => {
    expect(toSpokenScoutText("Mark _this_ as done."))
      .toBe("Mark this as done.");
  });

  test("leaves arithmetic asterisks alone", () => {
    expect(toSpokenScoutText("Math: 3 * 4 stays plain."))
      .toBe("Math: 3 * 4 stays plain.");
  });

  test("strips leading bullet markers before reading", () => {
    expect(toSpokenScoutText("- Improving integration\n- Addressing prompts"))
      .toBe("Improving integration Addressing prompts");
  });
});
