/**
 * Deterministic palette replacement for paintable pixel characters.
 *
 * A generated paint master keeps each semantic material in a distinct hue
 * family. We replace only pixels inside a declared family and retain their
 * original lightness and alpha, so authored highlights and shadows survive.
 */

export type PixelPaintRole = "primary" | "secondary";

export interface PixelPaintRegion {
  /** Source hue in degrees (0–360). */
  sourceHue: number;
  /** Maximum circular hue distance from sourceHue. */
  hueTolerance: number;
  minSaturation?: number;
  minLightness?: number;
  maxLightness?: number;
}

export interface PixelPaintProfile {
  regions: Partial<Record<PixelPaintRole, PixelPaintRegion>>;
}

export type PixelPaintPalette = Partial<Record<PixelPaintRole, string>>;

export interface HslColor {
  h: number;
  s: number;
  l: number;
}

const PAINT_ROLES: readonly PixelPaintRole[] = ["primary", "secondary"];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function hueDistance(a: number, b: number): number {
  const distance = Math.abs(a - b) % 360;
  return Math.min(distance, 360 - distance);
}

export function rgbToHsl(r: number, g: number, b: number): HslColor {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l: lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) hue = 60 * (((green - blue) / delta) % 6);
  else if (max === green) hue = 60 * ((blue - red) / delta + 2);
  else hue = 60 * ((red - green) / delta + 4);

  return { h: hue < 0 ? hue + 360 : hue, s: saturation, l: lightness };
}

export function hslToRgb({ h, s, l }: HslColor): [number, number, number] {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  let rgb: [number, number, number];

  if (segment < 1) rgb = [chroma, x, 0];
  else if (segment < 2) rgb = [x, chroma, 0];
  else if (segment < 3) rgb = [0, chroma, x];
  else if (segment < 4) rgb = [0, x, chroma];
  else if (segment < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];

  const match = l - chroma / 2;
  return rgb.map((channel) => Math.round((channel + match) * 255)) as [number, number, number];
}

function parseHexColor(value: string): HslColor {
  const normalized = value.trim().replace(/^#/, "");
  const expanded = normalized.length === 3
    ? normalized.split("").map((digit) => digit + digit).join("")
    : normalized;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) {
    throw new Error(`Pixel paint colors must be #rgb or #rrggbb; received ${JSON.stringify(value)}`);
  }
  return rgbToHsl(
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  );
}

function matchesRegion(color: HslColor, region: PixelPaintRegion): boolean {
  return color.s >= (region.minSaturation ?? 0.3)
    && color.l >= (region.minLightness ?? 0.04)
    && color.l <= (region.maxLightness ?? 0.96)
    && hueDistance(color.h, region.sourceHue) <= region.hueTolerance;
}

/**
 * Repaints RGBA pixels without changing the input buffer.
 *
 * Target paint contributes hue and saturation only. Source lightness is kept
 * exactly, which preserves the master's pixel-authored lighting and volume.
 */
export function paintRgbaPixels(
  source: Uint8Array | Uint8ClampedArray,
  profile: PixelPaintProfile,
  palette: PixelPaintPalette,
): Uint8ClampedArray {
  if (source.length % 4 !== 0) throw new Error("RGBA pixel buffer length must be divisible by four");

  const output = new Uint8ClampedArray(source);
  const prepared = PAINT_ROLES.flatMap((role) => {
    const region = profile.regions[role];
    const target = palette[role];
    return region && target ? [{ region, target: parseHexColor(target) }] : [];
  });

  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3] === 0) continue;
    const sourceColor = rgbToHsl(output[offset], output[offset + 1], output[offset + 2]);
    const paint = prepared.find(({ region }) => matchesRegion(sourceColor, region));
    if (!paint) continue;

    // Keep lower-chroma edge and wear pixels quieter than core enamel while
    // adopting the requested paint's saturation.
    const saturationWeight = 0.65 + 0.35 * sourceColor.s;
    const [red, green, blue] = hslToRgb({
      h: paint.target.h,
      s: clamp01(paint.target.s * saturationWeight),
      l: sourceColor.l,
    });
    output[offset] = red;
    output[offset + 1] = green;
    output[offset + 2] = blue;
  }

  return output;
}

/** Shared key-blue contract for the new astronaut paint masters. */
export const ASTRONAUT_KEY_BLUE_PROFILE: PixelPaintProfile = {
  regions: {
    primary: {
      sourceHue: 216,
      hueTolerance: 34,
      minSaturation: 0.36,
      minLightness: 0.045,
      maxLightness: 0.96,
    },
  },
};
