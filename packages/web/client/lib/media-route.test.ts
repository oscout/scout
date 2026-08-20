import { describe, expect, test } from "bun:test";

import { resolveCaptureRouteContext } from "./media-route.ts";

describe("capture route context", () => {
  test("does not invent a target for a fresh task from ambient fleet state", () => {
    const context = resolveCaptureRouteContext({ view: "inbox" }, []);

    expect(context).toEqual({
      agentId: null,
      conversationId: null,
      label: "Pick a project",
      canUseExistingChat: false,
    });
  });

  test("uses agent context only on an explicit agent route", () => {
    const context = resolveCaptureRouteContext({
      view: "agents-v2",
      agentId: "agent:visible",
      conversationId: "chn-visible",
    }, []);

    expect(context).toEqual({
      agentId: "agent:visible",
      conversationId: "chn-visible",
      label: "agent:visible",
      canUseExistingChat: true,
    });
  });
});
