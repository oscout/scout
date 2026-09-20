import { describe, expect, test } from "bun:test";
import {
  createGazeTracker,
  currentAttentionTarget,
  gazeRadius,
  gazeRole,
  glanceToward,
  quantizeGaze,
  setAttentionTarget,
  subscribeAttention,
} from "./crew-gaze.ts";

describe("quantizeGaze", () => {
  test("rests inside the dead zone", () => {
    expect(quantizeGaze(0, 0)).toBe("rest");
    expect(quantizeGaze(20, -20)).toBe("rest");
    expect(quantizeGaze(39, 0)).toBe("rest");
  });

  test("cardinals (screen coordinates, y down)", () => {
    expect(quantizeGaze(100, 0)).toBe("right");
    expect(quantizeGaze(-100, 0)).toBe("left");
    expect(quantizeGaze(0, -100)).toBe("up");
    expect(quantizeGaze(0, 100)).toBe("down");
  });

  test("diagonals get a full 45° sector each", () => {
    expect(quantizeGaze(100, -100)).toBe("up-right");
    expect(quantizeGaze(-100, -100)).toBe("up-left");
    expect(quantizeGaze(100, 100)).toBe("down-right");
    expect(quantizeGaze(-100, 100)).toBe("down-left");
    // 20° above the horizontal is still right; 30° is up-right.
    expect(quantizeGaze(100, -Math.tan((20 * Math.PI) / 180) * 100)).toBe("right");
    expect(quantizeGaze(100, -Math.tan((30 * Math.PI) / 180) * 100)).toBe("up-right");
  });
});

describe("gazeRole", () => {
  const shipped = ["blink-half", "blink-shut", "look-left", "look-right", "look-up"];
  const full = [...shipped, "look-down", "look-up-left", "look-up-right", "look-down-left", "look-down-right"];

  test("rest draws no patch", () => {
    expect(gazeRole("rest", full)).toBeUndefined();
    expect(gazeRole("left", undefined)).toBeUndefined();
    expect(gazeRole("left", [])).toBeUndefined();
  });

  test("exact roles win when the sheet has them", () => {
    expect(gazeRole("down", full)).toBe("look-down");
    expect(gazeRole("up-left", full)).toBe("look-up-left");
  });

  test("a sheet without the frame rests rather than guessing a cardinal", () => {
    expect(gazeRole("down", shipped)).toBeUndefined();
  });

  test("diagonals fall back to their horizontal half, then vertical", () => {
    expect(gazeRole("up-left", shipped)).toBe("look-left");
    expect(gazeRole("down-right", shipped)).toBe("look-right");
    expect(gazeRole("down-left", ["look-down"])).toBe("look-down");
  });
});

describe("createGazeTracker", () => {
  const rect = (x: number, y: number, size: number) =>
    ({ left: x, top: y, width: size, height: size, right: x + size, bottom: y + size, x, y, toJSON() {} }) as DOMRect;

  test("follows within the radius, rests beyond it or when the pointer is gone", () => {
    const t = createGazeTracker(44);
    const measure = () => rect(100, 100, 44);
    expect(t.sample({ x: 122, y: 60, at: 1, gone: false }, measure)).toBe("up");
    expect(t.sample({ x: 122 + gazeRadius(44) + 5, y: 122, at: 2, gone: false }, measure)).toBe("rest");
    expect(t.sample({ x: 122, y: 60, at: 3, gone: true }, measure)).toBe("rest");
  });

  test("measures the rect lazily and re-measures after the ttl", () => {
    let calls = 0;
    const t = createGazeTracker(44);
    const measure = () => {
      calls += 1;
      return rect(0, 0, 44);
    };
    t.sample({ x: 200, y: 22, at: 0, gone: false }, measure);
    t.sample({ x: 200, y: 22, at: 100, gone: false }, measure);
    expect(calls).toBe(1);
    t.sample({ x: 200, y: 22, at: 400, gone: false }, measure);
    expect(calls).toBe(2);
  });

  test("the radius scales with the coin but never drops below 160px", () => {
    expect(gazeRadius(28)).toBe(160);
    expect(gazeRadius(96)).toBe(384);
  });
});

describe("attention", () => {
  const rect = (x: number, y: number, size: number) =>
    ({ left: x, top: y, width: size, height: size, right: x + size, bottom: y + size, x, y, toJSON() {} }) as DOMRect;
  const el = (x: number, y: number, w: number, h: number) =>
    ({ getBoundingClientRect: () => ({ left: x, top: y, width: w, height: h }) }) as unknown as Element;

  test("a glance has no radius: the composer at the foot of the page still turns a coin at the top", () => {
    expect(glanceToward({ x: 122, y: 900 }, rect(100, 100, 44))).toBe("down");
    expect(glanceToward({ x: 122, y: 122 }, rect(100, 100, 44))).toBe("rest");
    expect(glanceToward({ x: 0, y: 0 }, null)).toBe("rest");
  });

  test("every subscriber hears the same target at the same moment; null clears it", () => {
    const heard: Array<{ x: number; y: number } | null> = [];
    const off1 = subscribeAttention((t) => heard.push(t && { x: t.x, y: t.y }));
    const off2 = subscribeAttention((t) => heard.push(t && { x: t.x, y: t.y }));
    setAttentionTarget(el(100, 700, 400, 40));
    expect(heard).toEqual([{ x: 300, y: 720 }, { x: 300, y: 720 }]);
    expect(currentAttentionTarget()?.x).toBe(300);
    setAttentionTarget(null);
    expect(heard.slice(2)).toEqual([null, null]);
    expect(currentAttentionTarget()).toBeNull();
    off1();
    off2();
    setAttentionTarget(el(0, 0, 10, 10));
    expect(heard.length).toBe(4);
    setAttentionTarget(null);
  });
});
