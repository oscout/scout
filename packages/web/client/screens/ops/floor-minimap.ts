import { projectFloorPoint, type MapProjection } from './shared-floor-camera.ts';
export function minimapGeometry(width: number, height: number, projection: MapProjection) {
  const corners = [[-width/2,-height/2],[width/2,-height/2],[width/2,height/2],[-width/2,height/2]].map(([x,y]) => projectFloorPoint(x,y,projection));
  const halfWidth = Math.max(...corners.map(p=>Math.abs(p.x)));
  const halfHeight = Math.max(...corners.map(p=>Math.abs(p.y)));
  const ratio = Math.min(156 / Math.max(1,halfWidth*2), 88 / Math.max(1,halfHeight*2));
  return { ratio, corners, point: (x:number,y:number) => ({x:88+x*ratio,y:56+y*ratio}) };
}
export function scaleFloorZoom(zoom: number, factor: number) {
  const next = zoom * factor;
  return Number.isFinite(next) && next > 0 ? Math.max(.6, next) : zoom;
}
export function minimapZoom(zoom:number, pan:{x:number;y:number}, delta:number) {
  const next = scaleFloorZoom(zoom, Math.exp(-delta*.002));
  return {zoom:next,pan:{x:pan.x*next/zoom,y:pan.y*next/zoom}};
}
