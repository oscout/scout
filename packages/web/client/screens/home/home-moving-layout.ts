export type HomeMovingLayout = "spotlight" | "duo" | "strip" | "dense";

/** Pick a layout that matches how many live units are on screen. */
export function homeMovingLayout(count: number): HomeMovingLayout {
  if (count <= 2) return "spotlight";
  if (count <= 4) return "duo";
  if (count <= 8) return "strip";
  return "dense";
}

export function homeMovingGridClass(layout: HomeMovingLayout): string {
  return `s-now-grid s-now-grid--${layout}`;
}