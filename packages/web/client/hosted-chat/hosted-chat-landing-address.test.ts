import { describe, expect, test } from "bun:test";

import { displayAddress } from "./hosted-chat-landing-address.ts";

describe("displayAddress", () => {
  test("drops presentation parameters a native host adds", () => {
    expect(
      displayAddress("/my-space?theme=dark&themeVars=eyJhIjoxfQ&embed=app&profile=macos.spaces&_cb=123"),
    ).toBe("/my-space");
  });

  test("keeps the address grammar, in space → channel → message order", () => {
    expect(
      displayAddress("/chat?message=m-1&theme=dark&channel=chn-1&space=home"),
    ).toBe("/chat?space=home&channel=chn-1&message=m-1");
  });

  test("the front door is not a room", () => {
    expect(displayAddress("/")).toBeNull();
    expect(displayAddress("/chat")).toBeNull();
    expect(displayAddress("/chat/")).toBeNull();
    expect(displayAddress("/chat?theme=dark&themeVars=xyz")).toBeNull();
  });

  test("a room stays a room once the noise is gone", () => {
    expect(displayAddress("/my-space?theme=dark")).toBe("/my-space");
    expect(displayAddress("/chat?channel=chn-1")).toBe("/chat?channel=chn-1");
  });

  test("a full URL reduces to its path and kept query", () => {
    expect(
      displayAddress("https://chat.openscout.app/my-space?channel=chn-1&themeVars=abc"),
    ).toBe("/my-space?channel=chn-1");
  });

  test("empty or relative input is nothing to print", () => {
    expect(displayAddress("")).toBeNull();
    expect(displayAddress(null)).toBeNull();
    expect(displayAddress(undefined)).toBeNull();
    expect(displayAddress("my-space")).toBeNull();
  });
});
