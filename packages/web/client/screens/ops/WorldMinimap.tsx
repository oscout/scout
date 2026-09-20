import { useEffect, useRef } from 'react';
import { projectFloorPoint, type MapProjection } from './shared-floor-camera.ts';
import { minimapGeometry, minimapZoom } from './floor-minimap.ts';
type Point={x:number;y:number};
type Props={width:number;height:number;projection:MapProjection;size:{width:number;height:number};scale:number;zoom:number;pan:Point;workspaces:{id:string;label:string;x:number;y:number}[];onPan:(pan:Point)=>void;onZoom:(zoom:number)=>void;onLocate:(pan:Point)=>void};
export function WorldMinimap({width,height,projection,size,scale,zoom,pan,workspaces,onPan,onZoom,onLocate}:Props){
 const root=useRef<HTMLElement>(null);
 const drag=useRef<{x:number;y:number;pan:Point;pointer:number}|null>(null);
 const moved=useRef(false);
 const geo=minimapGeometry(width,height,projection);
 const center=geo.point(-pan.x/scale,-pan.y/scale);
 const camera={x:center.x-size.width/scale*geo.ratio/2,y:center.y-size.height/scale*geo.ratio/2,width:size.width/scale*geo.ratio,height:size.height/scale*geo.ratio};
 useEffect(()=>{const el=root.current;if(!el)return;const wheel=(e:WheelEvent)=>{e.preventDefault();e.stopPropagation();const d=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?112:1);const next=minimapZoom(zoom,pan,d);onPan(next.pan);onZoom(next.zoom);};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[zoom,pan,onPan,onZoom]);
 const locate=(p:Point)=>onLocate({x:-p.x*scale,y:-p.y*scale});
 return <aside ref={root} className="shared-floor__minimap" aria-label="World minimap" title="Drag to move · Scroll to zoom" onPointerDown={e=>{
  if(e.button!==0||drag.current)return;e.stopPropagation();moved.current=false;
  const box=e.currentTarget.getBoundingClientRect();const x=(e.clientX-box.left)*176/box.width,y=(e.clientY-box.top)*112/box.height;
  const inside=x>=camera.x&&x<=camera.x+camera.width&&y>=camera.y&&y<=camera.y+camera.height;
  const base=inside||!!(e.target as Element).closest('button')?pan:{x:-(x-88)/geo.ratio*scale,y:-(y-56)/geo.ratio*scale};
  onPan(base);drag.current={x:e.clientX,y:e.clientY,pan:base,pointer:e.pointerId};((e.target as Element).closest('button') ?? e.currentTarget).setPointerCapture(e.pointerId);
 }} onPointerMove={e=>{const d=drag.current;if(!d||d.pointer!==e.pointerId)return;const box=e.currentTarget.getBoundingClientRect();const dx=(e.clientX-d.x)*176/box.width,dy=(e.clientY-d.y)*112/box.height;if(Math.hypot(dx,dy)>3)moved.current=true;if(!moved.current)return;onPan({x:d.pan.x-dx/geo.ratio*scale,y:d.pan.y-dy/geo.ratio*scale});}}
 onPointerUp={e=>{if(drag.current?.pointer!==e.pointerId)return;drag.current=null;const captured=(e.target as Element).closest('button') ?? e.currentTarget;if(captured.hasPointerCapture(e.pointerId))captured.releasePointerCapture(e.pointerId);}}
 onPointerCancel={()=>{drag.current=null;moved.current=true;}} onLostPointerCapture={()=>{drag.current=null;}}>
 <svg viewBox="0 0 176 112" aria-hidden="true"><polygon points={geo.corners.map(p=>{const q=geo.point(p.x,p.y);return `${q.x},${q.y}`;}).join(' ')} className="shared-floor__mini-ground"/><rect {...camera} className="shared-floor__mini-camera"/></svg>
 {workspaces.map(w=>{const p=projectFloorPoint(w.x-width/2,w.y-height/2,projection);const q=geo.point(p.x,p.y);return <button key={w.id} type="button" aria-label={w.label} style={{left:`${q.x/176*100}%`,top:`${q.y/112*100}%`}} onClick={e=>{e.stopPropagation();if(e.detail===0||!moved.current)locate(p);}}/>;})}
 </aside>;
}
