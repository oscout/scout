import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
// Only the pure placement helper is exercised; the portal is never rendered.
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));

const { resolvePanelPlacement } = await import("./RuntimePicker.tsx");

const GAP = 8;

// The 880×336 regression: a live-catalog panel is ~410px, and an 8px gapped
// room read leaves far less headroom than the old raw rect.top estimate.
describe("resolvePanelPlacement", () => {
  test("opens upward when the panel fits above", () => {
    const result = resolvePanelPlacement({
      rectTop: 600,
      rectBottom: 628,
      viewportHeight: 800,
      panelHeight: 410,
      gap: GAP,
    });
    expect(result.placement).toBe("up");
    expect(result.maxHeight).toBe(600 - GAP * 2);
  });

  test("opens downward when the panel only fits below", () => {
    const result = resolvePanelPlacement({
      rectTop: 40,
      rectBottom: 68,
      viewportHeight: 800,
      panelHeight: 410,
      gap: GAP,
    });
    // roomAbove = 24 < 410; roomBelow = 716 >= 410.
    expect(result.placement).toBe("down");
    expect(result.maxHeight).toBe(800 - 68 - GAP * 2);
  });

  test("opens upward on the larger side when it fits neither", () => {
    // 880×336 short viewport, chip near the middle: 134 above vs 120 below.
    const result = resolvePanelPlacement({
      rectTop: 150,
      rectBottom: 200,
      viewportHeight: 336,
      panelHeight: 410,
      gap: GAP,
    });
    expect(result.placement).toBe("up");
    expect(result.maxHeight).toBe(160); // roomAbove clamps to the floor
  });

  test("opens downward on the larger side when it fits neither", () => {
    const result = resolvePanelPlacement({
      rectTop: 100,
      rectBottom: 120,
      viewportHeight: 336,
      panelHeight: 410,
      gap: GAP,
    });
    // roomAbove = 84, roomBelow = 200 → down, capped to the room it has.
    expect(result.placement).toBe("down");
    expect(result.maxHeight).toBe(200);
  });

  test("maxHeight never drops below 160", () => {
    for (const rectTop of [0, GAP * 2, 60]) {
      const result = resolvePanelPlacement({
        rectTop,
        rectBottom: rectTop + 28,
        viewportHeight: 120,
        panelHeight: 410,
        gap: GAP,
      });
      expect(result.maxHeight).toBe(160);
    }
  });
});
