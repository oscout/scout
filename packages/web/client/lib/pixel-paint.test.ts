import { describe, expect, it } from "bun:test";
import {
  ASTRONAUT_KEY_BLUE_PROFILE,
  paintRgbaPixels,
  rgbToHsl,
} from "./pixel-paint.ts";

describe("paintRgbaPixels", () => {
  it("changes only the declared enamel hue family", () => {
    const source = new Uint8ClampedArray([
      20, 92, 230, 255, // saturated key blue
      245, 174, 18, 255, // amber fastener
      55, 58, 62, 255, // graphite joint
      20, 92, 230, 0, // transparent blue payload
    ]);
    const painted = paintRgbaPixels(source, ASTRONAUT_KEY_BLUE_PROFILE, { primary: "#e64778" });

    expect(rgbToHsl(painted[0], painted[1], painted[2]).h).toBeGreaterThan(330);
    expect(Array.from(painted.slice(4, 12))).toEqual(Array.from(source.slice(4, 12)));
    expect(Array.from(painted.slice(12, 16))).toEqual(Array.from(source.slice(12, 16)));
    expect(Array.from(source.slice(0, 4))).toEqual([20, 92, 230, 255]);
  });

  it("preserves authored lightness differences and alpha", () => {
    const source = new Uint8ClampedArray([
      6, 42, 116, 240,
      112, 177, 255, 128,
    ]);
    const beforeDark = rgbToHsl(source[0], source[1], source[2]);
    const beforeLight = rgbToHsl(source[4], source[5], source[6]);
    const painted = paintRgbaPixels(source, ASTRONAUT_KEY_BLUE_PROFILE, { primary: "#63d28d" });
    const afterDark = rgbToHsl(painted[0], painted[1], painted[2]);
    const afterLight = rgbToHsl(painted[4], painted[5], painted[6]);

    expect(afterDark.l).toBeCloseTo(beforeDark.l, 2);
    expect(afterLight.l).toBeCloseTo(beforeLight.l, 2);
    expect(afterLight.l).toBeGreaterThan(afterDark.l);
    expect([painted[3], painted[7]]).toEqual([240, 128]);
  });

  it("supports neutral paint without touching fixed metal", () => {
    const source = new Uint8ClampedArray([20, 92, 230, 255, 160, 164, 170, 255]);
    const painted = paintRgbaPixels(source, ASTRONAUT_KEY_BLUE_PROFILE, { primary: "#b8b8b8" });
    const enamel = rgbToHsl(painted[0], painted[1], painted[2]);

    expect(enamel.s).toBe(0);
    expect(Array.from(painted.slice(4))).toEqual(Array.from(source.slice(4)));
  });
});
