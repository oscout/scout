import { projectFloorPoint, type MapProjection } from './shared-floor-camera.ts';
export function minimapGeometry(width: number, height: number, projection: MapProjection) {
  const corners = [[-width/2,-height/2],[width/2,-height/2],[width/2,height/2],[-width/2,height/2]].map(([x,y]) => projectFloorPoint(x,y,projection));
  const halfWidth = Math.max(...corners.map(p=>Math.abs(p.x)));
  const halfHeight = Math.max(...corners.map(p=>Math.abs(p.y)));
  const ratio = Math.min(156 / Math.max(1,halfWidth*2), 88 / Math.max(1,halfHeight*2));
  return { ratio, corners, point: (x:number,y:number) => ({x:88+x*ratio,y:56+y*ratio}) };
}
/**
 * Zoom bounds for the world view.
 *
 * Forty thousand to one. Pulling back until the entire floor is one point of
 * light among stars is the point of a space view, not an edge case, so the
 * floor is set where a world several thousand units across renders sub-pixel
 * and there is genuinely nothing further to go. The ceiling exists only so one
 * fast trackpad flick cannot strand the camera inside a single actor.
 *
 * A range this wide is not just a wider clamp — it changes what has to be true
 * of everything downstream. See `worldDetailFade` for what gets drawn out
 * there, and `starsForRegion`'s `cell` for why the sky survives the trip.
 */
export const MIN_FLOOR_ZOOM = .0002;
export const MAX_FLOOR_ZOOM = 8;

/** One press of the zoom buttons. A doubling, the way map zoom has always worked. */
export const ZOOM_STEP = 2;

/**
 * Cross-fade between the two ways the world can be drawn.
 *
 * Past a certain distance the DOM floor is sub-pixel — islands narrower than
 * their own borders, labels below a device pixel — and drawing it yields grey
 * mush rather than detail. Beacons take over there: the sky canvas paints each
 * workspace as a point of light, so the far end of the range is a constellation
 * where your world is rather than an empty screen. The two overlap on purpose,
 * so a shrinking island picks up a halo before it goes.
 */
export function worldDetailFade(zoom: number) {
  const ramp = (from: number, to: number) => Math.min(1, Math.max(0, (zoom - from) / (to - from)));
  return { world: ramp(.05, .18), beacons: 1 - ramp(.14, .34) };
}

export function scaleFloorZoom(zoom: number, factor: number) {
  const next = zoom * factor;
  if (!Number.isFinite(next) || next <= 0) return zoom;
  return Math.min(MAX_FLOOR_ZOOM, Math.max(MIN_FLOOR_ZOOM, next));
}

/**
 * Wheel deltas are not comparable across devices — a mouse reports a few lines,
 * a trackpad reports many pixels — so normalise to pixels before turning them
 * into a zoom factor. Without this, crossing the range takes hundreds of notches
 * on a mouse and one careless flick on a trackpad.
 *
 * The rate is set so the full forty-thousand-fold journey is about half a dozen
 * unhurried trackpad flicks: far enough to feel like travelling, short enough
 * that reaching the far end does not become a chore.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0) {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-600, Math.min(600, pixels)) * .003);
}
/**
 * Zoom while holding one point of the world still under the pointer.
 *
 * `focus` is in viewport pixels measured from the centre of the viewport, which
 * is where the world origin sits before panning; the default therefore zooms
 * about the middle of the screen. Anchoring barely showed over the old .6-2x
 * range and is the whole experience over this one: unanchored, every step
 * expands away from the world origin, so aiming at an outpost and pulling in
 * throws it off screen long before you arrive.
 */
export function zoomAboutPoint(
  zoom: number,
  pan: { x: number; y: number },
  factor: number,
  focus: { x: number; y: number } = { x: 0, y: 0 },
) {
  const next = scaleFloorZoom(zoom, factor);
  const ratio = next / zoom;
  return {
    zoom: next,
    pan: { x: focus.x + (pan.x - focus.x) * ratio, y: focus.y + (pan.y - focus.y) * ratio },
  };
}

/**
 * Keep some of the world on screen.
 *
 * Over a forty-thousand-fold range, across a floor that is mostly empty space
 * between islands, an unclamped camera can be pointed somewhere with no
 * landmark in any direction and no cue for how to get back — the view is
 * indistinguishable from a broken one. Every map does this; here it is the
 * difference between "far away" and "lost".
 *
 * `keep` is how many pixels of world must stay in frame. All values are screen
 * pixels, with `pan` measured from the centre of the viewport.
 */
export function clampFloorPan(
  pan: { x: number; y: number },
  world: { width: number; height: number },
  view: { width: number; height: number },
  keep = 96,
) {
  const limit = (value: number, worldSize: number, viewSize: number) => {
    if (!Number.isFinite(value)) return 0;
    // A world narrower than `keep`, or a viewport barely larger, must not
    // invert the bound and pin the camera to a point it cannot leave.
    const margin = Math.min(keep, worldSize, Math.max(0, viewSize / 2));
    const reach = Math.max(0, viewSize / 2 - margin + worldSize / 2);
    return Math.min(reach, Math.max(-reach, value));
  };
  return {
    x: limit(pan.x, world.width, view.width),
    y: limit(pan.y, world.height, view.height),
  };
}

export function minimapZoom(zoom:number, pan:{x:number;y:number}, delta:number) {
  return zoomAboutPoint(zoom, pan, Math.exp(-delta*.002));
}

/** How long a guided camera glide takes. Continuous gestures stay 1:1 and never use this. */
export const CAMERA_TRAVEL_MS = 420;

/** Camera travel easing: fast departure, gentle arrival. */
export function easeTravel(t: number) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

/**
 * Interpolate one camera toward another. Zoom travels in log space — zoom is
 * multiplicative, so a linear midpoint between 1:1 and 1:16 would spend most of
 * the journey visually arrived; the log midpoint is 1:4, which is what halfway
 * looks like on a map.
 */
export function travelCamera(
  from: { zoom: number; pan: { x: number; y: number } },
  to: { zoom: number; pan: { x: number; y: number } },
  amount: number,
) {
  // Endpoints land exactly — a gliding zoom must finish at 1:1, not 1:0.999…
  if (amount <= 0) return { zoom: from.zoom, pan: { ...from.pan } };
  if (amount >= 1) return { zoom: to.zoom, pan: { ...to.pan } };
  const t = easeTravel(amount);
  return {
    zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * t),
    pan: {
      x: from.pan.x + (to.pan.x - from.pan.x) * t,
      y: from.pan.y + (to.pan.y - from.pan.y) * t,
    },
  };
}
