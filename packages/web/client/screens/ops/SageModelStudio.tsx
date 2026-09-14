import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import "./sage-model-studio.css";

type Pose = "idle" | "thinking" | "working" | "walking";
export default function SageModelStudio({ onClose }: { onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const model = useRef<THREE.Group | null>(null);
  const poseRef = useRef<Pose>("idle");
  const [pose, setPose] = useState<Pose>("idle");
  const [paused, setPaused] = useState(false);
  const pauseRef = useRef(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const clips = useRef<THREE.AnimationClip[]>([]);
  useEffect(() => { poseRef.current = pose; }, [pose]);
  useEffect(() => { pauseRef.current = paused; }, [paused]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch { setError("WebGL is unavailable in this browser."); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    node.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#202a29");
    const camera = new THREE.PerspectiveCamera(34, 1, .1, 100); camera.position.set(4, 2.8, 7);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 1.5, 0); controls.enableDamping = true; controls.minDistance = 3.5; controls.maxDistance = 12; controls.maxPolarAngle = Math.PI * .52; controls.update();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment(); const env = pmrem.fromScene(room, .04); scene.environment = env.texture; scene.environmentIntensity = .65; room.dispose();
    const hemi = new THREE.HemisphereLight(0xeaf7ff, 0x343326, 1.3); scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffebd0, 2.5); key.position.set(-3, 6, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -4; key.shadow.camera.right = 4; key.shadow.camera.top = 5; key.shadow.camera.bottom = -3; key.shadow.normalBias = .025; scene.add(key);
    const rim = new THREE.DirectionalLight(0xbedfee, 1.5); rim.position.set(3, 4, -3); scene.add(rim);
    const floorGeometry = new THREE.CircleGeometry(6, 64); const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x2b3833, roughness: .9 });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial); floor.rotation.x = -Math.PI / 2; floor.position.y = -.03; floor.receiveShadow = true; scene.add(floor);
    let actor: THREE.Group | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    let active: THREE.AnimationAction | null = null;
    let lastPose = "";
    let disposed = false;
    const release = (root: THREE.Group) => {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      root.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
    };
    new GLTFLoader().load("/characters/sage/sage.glb", gltf => {
      if (disposed) { release(gltf.scene); return; }
      actor = gltf.scene; model.current = actor; clips.current = gltf.animations;
      actor.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } });
      const bounds = new THREE.Box3().setFromObject(actor);
      const height = bounds.max.y - bounds.min.y;
      actor.scale.setScalar(3.36 / Math.max(.01, height));
      const center = bounds.getCenter(new THREE.Vector3());
      actor.position.set(-center.x * actor.scale.x, -bounds.min.y * actor.scale.y, -center.z * actor.scale.z);
      scene.add(actor); mixer = new THREE.AnimationMixer(actor); setLoading(false);
    }, undefined, () => { if (!disposed) { setLoading(false); setError("Sage’s model could not load. Close and reopen the studio to retry."); } });
    const resize = () => { const w = node.clientWidth, h = Math.max(1,node.clientHeight); renderer.setSize(w,h); camera.aspect=w/h; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, last = performance.now();
    const draw = (at: number) => {
      const dt = Math.min(.05, (at-last)/1000); last=at;
      if (!document.hidden) {
        if (mixer && actor) {
          const requested = poseRef.current;
          if (requested !== lastPose) {
            const clip = clips.current.find(c => c.name.toLowerCase() === requested);
            if (clip) {
              const next = mixer.clipAction(clip); next.reset().play();
              if (active && active !== next) { next.fadeIn(.25); active.fadeOut(.25); }
              active = next; lastPose = requested;
              if (reduced.matches) mixer.update(1 / 30);
            }
          }
          if (!pauseRef.current && !reduced.matches) mixer.update(dt);
        }
        controls.update(); renderer.render(scene,camera);
      }
      frame=requestAnimationFrame(draw);
    }; frame=requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); disposed=true; if (actor) { mixer?.stopAllAction(); mixer?.uncacheRoot(actor); release(actor); } model.current=null; clips.current=[]; key.shadow.dispose(); floorGeometry.dispose(); floorMaterial.dispose(); env.dispose(); pmrem.dispose(); renderer.dispose(); renderer.domElement.remove(); };
  }, []);
  const download = async () => {
    if (!model.current) return;
    try {
      const data = await new GLTFExporter().parseAsync(model.current, { binary: true, animations: clips.current });
      const url=URL.createObjectURL(new Blob([data as ArrayBuffer],{type:"model/gltf-binary"}));
      const a=document.createElement("a"); a.href=url; a.download="sage-animated.glb"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch { setError("Model export failed. Try again after the preview has loaded."); }
  };
  return <section className="sage-studio" aria-label="Sage 3D model studio"><header><div><strong>Sage · Blender character</strong><small>Drag to orbit · scroll to zoom</small></div><button type="button" onClick={onClose} aria-label="Close 3D studio">×</button></header><div className="sage-studio__canvas" ref={host} />{loading ? <p role="status">Loading Sage…</p> : null}{error ? <p role="alert">{error}</p> : null}<footer><div>{(["idle","thinking","working","walking"] as Pose[]).map(p=><button type="button" key={p} aria-pressed={p===pose} onClick={()=>setPose(p)}>{p}</button>)}</div><button type="button" onClick={()=>setPaused(!paused)}>{paused?"Resume":"Pause"}</button><button type="button" onClick={download} disabled={loading || !!error}>Export GLB</button></footer></section>;
}
