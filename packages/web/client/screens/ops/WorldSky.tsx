import { useEffect, useRef } from "react";

import { SKY_CELL, starsForRegion } from "./world-sky-stars.ts";

/**
 * The deep background of the world view.
 *
 * Drawn rather than photographed. A 2K image of the Milky Way is already being
 * upscaled on a retina display before anyone touches the zoom, and the whole
 * point of a space view is travelling a long way in and out — so the sky is
 * generated at the device's real pixel density every time the camera moves, and
 * is as sharp at the floor of the zoom range as it is at the ceiling.
 *
 * Over a forty-thousand-fold range a fixed field of stars stops meaning
 * anything: scale it linearly and it flattens out within the first factor of
 * five, after which pulling back changes nothing on screen and the zoom feels
 * broken however far the number keeps falling. So each layer is drawn as a pair
 * of octaves instead. A layer's sky-space cell doubles every time the camera
 * pulls back by a factor of two, which holds the number of stars on screen
 * roughly constant while their positions keep spreading; the two octaves
 * cross-fade so the handover never pops. The field is scale-free, and zooming
 * out keeps revealing sky for as long as there is range left to spend.
 */

type Layer = {
  salt: number;
  /** Fraction of the camera pan this layer follows. Near layers move most. */
  parallax: number;
  /**
   * How strongly this layer answers the zoom, as the exponent of a power law.
   * 0 would be infinitely far away and perfectly static; 1 would be stuck to
   * the floor itself. Everything here sits near the far end, because stars are
   * supposed to be much further away than the thing you are flying away from.
   */
  depth: number;
  density: number;
  size: number;
  alpha: number;
  /**
   * Thin this layer down to the galactic band, so the band is somewhere stars
   * genuinely crowd rather than a grey wash painted over an even field. Without
   * it the haze has to carry the whole effect, and haze reads as fog.
   */
  bandBound?: boolean;
};

/**
 * Densities are set for the *thinnest* moment in the range, not the average
 * one. At a whole-numbered zoom the octave blend is zero, so a layer draws one
 * octave instead of two — and 1:1 is exactly where the view opens. Tuned on a
 * mid-blend frame, the default view is the emptiest sky the app ever shows.
 */
const LAYERS: Layer[] = [
  { salt: 11, parallax: 0.05, depth: 0.06, density: 1.7, size: 0.72, alpha: 0.6 },
  { salt: 23, parallax: 0.16, depth: 0.13, density: 1.1, size: 1.0, alpha: 0.85 },
  { salt: 37, parallax: 0.32, depth: 0.22, density: 0.55, size: 1.55, alpha: 1 },
  { salt: 53, parallax: 0.09, depth: 0.08, density: 7, size: 0.62, alpha: 0.75, bandBound: true },
];

/** Keeps one octave from drawing a scaled copy of its neighbour's stars. */
const OCTAVE_SALT = 101;

/** Tilt of the galactic band, radians. */
const BAND_ANGLE = -0.32;

/** Below this a cross-faded octave is invisible; skip the sweep entirely. */
const OCTAVE_CUTOFF = 0.004;

/** Dark clouds across the band, as fractions of its own reach and half-width. */
const DUST_LANES = [
  { along: -0.34, across: 0.10, tilt: 0.10, length: 0.42, width: 0.62, depth: 0.55 },
  { along: 0.06, across: -0.26, tilt: -0.07, length: 0.30, width: 0.44, depth: 0.42 },
  { along: 0.44, across: 0.16, tilt: 0.13, length: 0.36, width: 0.52, depth: 0.48 },
];

export type SkyBeacon = {
  /** Viewport pixels from the centre of the viewport. */
  x: number;
  y: number;
  /** On-screen radius of the thing this stands for, before any clamping. */
  spread: number;
};

/**
 * The galactic band.
 *
 * Painted as rotated ellipses, never as gradients inside a rectangle. A rotated
 * `fillRect` leaves a hard diagonal edge everywhere the gradient inside it has
 * not already reached zero, and the core glow is far wider than the band is
 * tall — so it was being sliced flat along both long edges and read as a wedge
 * cut out of space rather than as a galaxy. An ellipse has nowhere to clip.
 */
function drawBand(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  zoom: number,
): void {
  const reach = Math.max(width, height) * 1.5;
  // The band widens as you pull back, the way a distant galaxy resolves from a
  // stripe into a spread of light — then settles, because a galaxy is the sky
  // rather than something you can retreat from.
  const half = Math.max(width, height) * (0.17 + 0.1 / Math.max(zoom, 0.2));

  const ellipse = (radiusX: number, radiusY: number, stops: [number, string][]) => {
    ctx.save();
    ctx.scale(1, radiusY / radiusX);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radiusX);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, radiusX, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  ctx.save();
  ctx.translate(width / 2, height * 0.46);
  ctx.rotate(BAND_ANGLE);
  // The diffuse sweep, kept faint on purpose: it is the glow between the stars,
  // not the band itself. Turned up far enough to read on its own it becomes fog.
  ellipse(reach, half, [
    [0, "rgba(96, 116, 156, 0.15)"],
    [0.42, "rgba(54, 70, 108, 0.09)"],
    [0.75, "rgba(28, 42, 72, 0.03)"],
    [1, "rgba(20, 32, 56, 0)"],
  ]);
  // A warmer, shorter bulge, so the band is not one flat tone end to end.
  ellipse(reach * 0.4, half * 0.62, [
    [0, "rgba(178, 162, 138, 0.11)"],
    [0.45, "rgba(116, 114, 138, 0.05)"],
    [1, "rgba(40, 48, 76, 0)"],
  ]);
  // Dust lanes. A galaxy is mottled and interrupted; an unbroken gradient is
  // the single strongest tell that a sky was painted by a computer.
  for (const lane of DUST_LANES) {
    ctx.save();
    ctx.translate(reach * lane.along, half * lane.across);
    ctx.rotate(lane.tilt);
    ellipse(reach * lane.length, half * lane.width, [
      [0, `rgba(5, 7, 13, ${lane.depth})`],
      [0.5, `rgba(5, 7, 13, ${lane.depth * 0.55})`],
      [1, "rgba(5, 7, 13, 0)"],
    ]);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * The workspaces, once they are too far away to draw as themselves.
 *
 * Drawn behind the floor rather than instead of it, so an island that is still
 * legible picks up a halo and the handover reads as one thing receding rather
 * than two things swapping.
 */
function drawBeacons(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  beacons: readonly SkyBeacon[],
  strength: number,
): void {
  if (strength <= 0) return;
  const centerX = width / 2;
  const centerY = height / 2;
  for (const beacon of beacons) {
    const x = centerX + beacon.x;
    const y = centerY + beacon.y;
    if (x < -40 || y < -40 || x > width + 40 || y > height + 40) continue;
    // Never smaller than a visible dot: at the floor of the range every
    // workspace has collapsed to the same point and this is all that is left.
    const radius = Math.min(7, Math.max(1.1, beacon.spread * 0.5));
    const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 6);
    halo.addColorStop(0, `rgba(150, 226, 214, ${0.5 * strength})`);
    halo.addColorStop(0.4, `rgba(120, 196, 200, ${0.16 * strength})`);
    halo.addColorStop(1, "rgba(80, 150, 170, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, radius * 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = strength;
    ctx.fillStyle = "#e8fffb";
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function draw(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  zoom: number,
  pan: { x: number; y: number },
  beacons: readonly SkyBeacon[],
  beaconStrength: number,
): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, width, height);
  drawBand(ctx, width, height, zoom);

  const centerX = width / 2;
  const centerY = height * 0.46;
  const bandHalf = Math.max(width, height) * (0.2 + 0.12 / Math.max(zoom, 0.2));
  const bandCos = Math.cos(BAND_ANGLE);
  const bandSin = Math.sin(BAND_ANGLE);
  const safeZoom = Math.max(zoom, 1e-6);

  ctx.fillStyle = "#dbe6f2";
  for (const layer of LAYERS) {
    // Sky → screen. A power law rather than a subtraction: it has no bottom to
    // hit, so the layer keeps answering the camera however far back it goes.
    const span = Math.pow(safeZoom, layer.depth);
    const offsetX = pan.x * layer.parallax;
    const offsetY = pan.y * layer.parallax;
    // Which octave currently lands one cell on roughly one screen cell, and how
    // far through the handover to the next one we are.
    const detail = Math.log2(1 / span);
    const base = Math.floor(detail);
    const blend = detail - base;

    for (const [octave, weight] of [[base, 1 - blend], [base + 1, blend]] as const) {
      if (weight <= OCTAVE_CUTOFF) continue;
      const cell = SKY_CELL * Math.pow(2, octave);
      const stars = starsForRegion(
        {
          minX: -offsetX / span,
          minY: -offsetY / span,
          maxX: (width - offsetX) / span,
          maxY: (height - offsetY) / span,
        },
        {
          salt: layer.salt + octave * OCTAVE_SALT,
          density: layer.density,
          size: layer.size,
          cell,
        },
      );

      for (const star of stars) {
        const screenX = star.x * span + offsetX;
        const screenY = star.y * span + offsetY;
        // Stars inside the band read brighter — the density gradient is what
        // makes a painted band look like it is made of stars.
        const acrossBand = Math.abs(
          -(screenX - centerX) * bandSin + (screenY - centerY) * bandCos,
        );
        const inBand = Math.max(0, 1 - acrossBand / bandHalf);
        // Squared, so the crowd falls away from the spine quickly instead of
        // fading to a rectangle of slightly-more-stars.
        if (layer.bandBound && star.roll > inBand * inBand) continue;
        // A wide swing, so the band reads as somewhere the stars crowd together
        // rather than as a grey stripe painted over an even field.
        ctx.globalAlpha = Math.min(
          1,
          star.alpha * layer.alpha * weight * (0.55 + inBand * 1.05),
        );
        ctx.beginPath();
        // Never below a device pixel: a sub-pixel arc renders as grey mush,
        // which is the exact failure the photograph had.
        ctx.arc(screenX, screenY, Math.max(star.radius, 0.5 / ratio), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  drawBeacons(ctx, width, height, beacons, beaconStrength);
}

export function WorldSky({ zoom, pan, beacons, beaconStrength }: {
  zoom: number;
  pan: { x: number; y: number };
  beacons: readonly SkyBeacon[];
  beaconStrength: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const node = canvas.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const paint = () => {
      const { width, height } = size.current;
      if (width > 0 && height > 0) {
        draw(node, width, height, zoom, pan, beacons, beaconStrength);
      }
    };
    const observer = new ResizeObserver(([entry]) => {
      size.current = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      paint();
    });
    observer.observe(parent);
    paint();
    return () => observer.disconnect();
  }, [zoom, pan, beacons, beaconStrength]);

  return <canvas className="shared-floor__sky-canvas" ref={canvas} aria-hidden="true" />;
}
