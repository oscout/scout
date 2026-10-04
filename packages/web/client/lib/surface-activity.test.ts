import { describe, expect, test } from "bun:test";

import {
  isScoutSurfaceActive,
  isScoutSurfaceVisible,
  onScoutSurfaceActivated,
} from "./surface-activity.ts";

describe("isScoutSurfaceActive", () => {
  test("pauses hidden browser tabs", () => {
    expect(isScoutSurfaceActive({
      visibilityState: "hidden",
      hasFocus: () => false,
    })).toBe(false);
  });

  test("pauses visible surfaces when their browser or native host is inactive", () => {
    expect(isScoutSurfaceActive({
      visibilityState: "visible",
      hasFocus: () => false,
    })).toBe(false);
  });

  test("allows work only for a visible focused surface", () => {
    expect(isScoutSurfaceActive({
      visibilityState: "visible",
      hasFocus: () => true,
    })).toBe(true);
  });

  test("keeps non-DOM callers active", () => {
    expect(isScoutSurfaceActive(undefined)).toBe(true);
  });
});

describe("isScoutSurfaceVisible", () => {
  test("keeps a watch surface live while on screen but unfocused", () => {
    expect(isScoutSurfaceVisible({ visibilityState: "visible" })).toBe(true);
  });

  test("still pauses hidden surfaces", () => {
    expect(isScoutSurfaceVisible({ visibilityState: "hidden" })).toBe(false);
  });
});

describe("onScoutSurfaceActivated", () => {
  test("notifies once for each inactive-to-active transition", () => {
    const targetDocument = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
      hasFocus: () => boolean;
    };
    const targetWindow = new EventTarget();
    let focused = false;
    targetDocument.visibilityState = "hidden";
    targetDocument.hasFocus = () => focused;

    let activations = 0;
    const stop = onScoutSurfaceActivated(() => {
      activations += 1;
    }, {
      document: targetDocument,
      window: targetWindow,
    });

    targetDocument.visibilityState = "visible";
    targetDocument.dispatchEvent(new Event("visibilitychange"));
    expect(activations).toBe(0);

    focused = true;
    targetWindow.dispatchEvent(new Event("focus"));
    targetDocument.dispatchEvent(new Event("visibilitychange"));
    expect(activations).toBe(1);

    focused = false;
    targetWindow.dispatchEvent(new Event("blur"));
    focused = true;
    targetWindow.dispatchEvent(new Event("focus"));
    targetWindow.dispatchEvent(new Event("focus"));
    expect(activations).toBe(2);

    stop();
    focused = false;
    targetWindow.dispatchEvent(new Event("blur"));
    focused = true;
    targetWindow.dispatchEvent(new Event("focus"));
    expect(activations).toBe(2);
  });
});
