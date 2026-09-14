import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export type SageJoints = Record<"head" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg" | "leftEye" | "rightEye", THREE.Group>;

/** Procedural Sage prototype. Feet rest on y=0, face looks along +Z. */
export function createSageModel(): { root: THREE.Group; joints: SageJoints; dispose: () => void } {
  const root = new THREE.Group();
  root.name = "Sage";
  const geometries = new Map<string, THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const physical = (parameters: THREE.MeshPhysicalMaterialParameters) => {
    const material = new THREE.MeshPhysicalMaterial(parameters); materials.add(material); return material;
  };
  const ivory = physical({ color: 0xeee3cc, roughness: .28, metalness: .06, clearcoat: .55, clearcoatRoughness: .22 });
  const sage = physical({ color: 0x81956c, roughness: .31, metalness: .15, clearcoat: .4 });
  const trim = physical({ color: 0xc4bba7, roughness: .35, metalness: .45 });
  const graphite = physical({ color: 0x272d2e, roughness: .42, metalness: .55 });
  const visor = physical({ color: 0x101a20, roughness: .16, metalness: .25, clearcoat: 1, clearcoatRoughness: .12 });
  const eyeLight = physical({ color: 0x72efab, emissive: 0x45d68e, emissiveIntensity: 1.5, roughness: .2 });
  const pupil = physical({ color: 0x06141d, roughness: .12, metalness: .2 });
  const catchlight = physical({ color: 0xffffff, emissive: 0xb8e5ff, emissiveIntensity: .6, roughness: .12 });
  const amber = physical({ color: 0xffc95e, emissive: 0xd68b14, emissiveIntensity: .7, roughness: .25 });
  function geometry(key: string, make: () => THREE.BufferGeometry) {
    let item = geometries.get(key); if (!item) { item = make(); geometries.set(key, item); } return item;
  }
  const sphere = geometry("sphere", () => new THREE.SphereGeometry(1, 40, 28));
  const cylinder = geometry("cylinder", () => new THREE.CylinderGeometry(1, 1, 1, 32));
  function mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, material: THREE.Material, name: string, position: [number, number, number], scale: [number, number, number] = [1, 1, 1]) {
    const object = new THREE.Mesh(geo, material); object.name = name; object.position.set(...position); object.scale.set(...scale); object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
  }
  function ball(parent: THREE.Object3D, name: string, material: THREE.Material, position: [number, number, number], scale: [number, number, number]) { return mesh(parent, sphere, material, name, position, scale); }
  function box(parent: THREE.Object3D, name: string, material: THREE.Material, position: [number, number, number], dimensions: [number, number, number], radius: number) {
    const key = `box:${dimensions.join(":")}:${radius}`;
    return mesh(parent, geometry(key, () => new RoundedBoxGeometry(...dimensions, 5, radius)), material, name, position);
  }
  function group(name: string, parent: THREE.Object3D, position: [number, number, number]) { const object = new THREE.Group(); object.name = name; object.position.set(...position); parent.add(object); return object; }
  function disc(parent: THREE.Object3D, name: string, material: THREE.Material, position: [number, number, number], radius: number, depth: number) {
    const object = mesh(parent, cylinder, material, name, position, [radius, depth, radius]); object.rotation.x = Math.PI / 2; return object;
  }

  // Torso keeps a darker under-shell visible between the individual ceramic plates.
  ball(root, "Torso core", graphite, [0, 1.32, 0], [.39, .48, .3]);
  ball(root, "Chest shell", ivory, [0, 1.48, .04], [.43, .37, .34]);
  box(root, "Sage abdomen plate", sage, [0, 1.12, .12], [.56, .22, .42], .09);
  disc(root, "Chest light bezel", trim, [0, 1.51, .365], .118, .045);
  disc(root, "Chest light socket", graphite, [0, 1.51, .394], .095, .022);
  ball(root, "Chest lamp", eyeLight, [0, 1.51, .414], [.071, .071, .022]);
  box(root, "Status lamp", amber, [.2, 1.51, .334], [.085, .033, .024], .012);
  mesh(root, cylinder, graphite, "Neck", [0, 1.91, 0], [.145, .25, .145]);
  for (const y of [1.85, 1.91, 1.97]) mesh(root, cylinder, trim, "Neck seam", [0, y, 0], [.151, .018, .151]);

  const head = group("head", root, [0, 2.43, 0]);
  ball(head, "Ceramic head", ivory, [0, 0, 0], [.86, .7, .62]);
  box(head, "Visor bevel", trim, [0, -.035, .491], [1.45, .93, .24], .225);
  box(head, "Dark glass visor", visor, [0, -.035, .556], [1.36, .84, .19], .21);
  box(head, "Crown inset", sage, [0, .595, -.035], [.61, .19, .57], .08);
  const eyes = group("eyes", head, [0, -.035, .659]);
  const leftEye = group("leftEye", eyes, [-.29, 0, 0]);
  const rightEye = group("rightEye", eyes, [.29, 0, 0]);
  for (const eye of [leftEye, rightEye]) {
    ball(eye, "Luminous eye", eyeLight, [0, 0, 0], [.158, .21, .032]);
    ball(eye, "Pupil", pupil, [.015, -.01, .033], [.09, .145, .024]);
    ball(eye, "Catchlight", catchlight, [-.032, .084, .058], [.037, .043, .012]);
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-.08, .275, 0), new THREE.Vector3(0, .302, .004), new THREE.Vector3(.08, .275, 0)]);
    const brow = geometry("eyebrow", () => new THREE.TubeGeometry(curve, 16, .019, 8, false));
    mesh(eye, brow, eyeLight, "Eyebrow", [0, 0, -.035]);
  }
  for (const sign of [-1, 1]) {
    const ear = group(sign < 0 ? "Left ear" : "Right ear", head, [sign * .805, .04, -.025]);
    const bezel = mesh(ear, cylinder, graphite, "Ear socket", [0, 0, 0], [.24, .12, .24]); bezel.rotation.z = Math.PI / 2;
    const cover = mesh(ear, cylinder, sage, "Ear cap", [sign * .065, 0, 0], [.215, .12, .215]); cover.rotation.z = Math.PI / 2;
    const ring = mesh(ear, cylinder, trim, "Ear ring", [sign * .134, 0, 0], [.145, .025, .145]); ring.rotation.z = Math.PI / 2;
    const lamp = mesh(ear, cylinder, eyeLight, "Ear light", [sign * .15, 0, 0], [.103, .028, .103]); lamp.rotation.z = Math.PI / 2;
    const finShape = new THREE.Shape(); finShape.moveTo(-.09, 0); finShape.quadraticCurveTo(-.06, .28, .045, .53); finShape.quadraticCurveTo(.095, .57, .11, .45); finShape.lineTo(.1, .015); finShape.closePath();
    const finGeometry = geometry("ear-fin", () => new THREE.ExtrudeGeometry(finShape, { depth: .08, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: .025, bevelThickness: .025, curveSegments: 16 }));
    const fin = mesh(head, finGeometry, sage, "Pointed ear fin", [sign * .71, .35, -.02]); fin.rotation.z = -sign * .2; fin.scale.x = sign;
  }

  function arm(side: "leftArm" | "rightArm", sign: number) {
    const joint = group(side, root, [sign * .49, 1.68, 0]);
    ball(joint, "Shoulder joint", graphite, [0, 0, 0], [.17, .17, .17]);
    ball(joint, "Shoulder plate", ivory, [sign * .035, .045, .005], [.18, .145, .19]);
    ball(joint, "Upper arm", sage, [0, -.19, 0], [.12, .22, .13]);
    ball(joint, "Elbow", graphite, [0, -.36, 0], [.115, .11, .12]);
    ball(joint, "Forearm shell", ivory, [0, -.49, .025], [.145, .21, .145]);
    box(joint, "Forearm inset", sage, [0, -.49, .151], [.15, .2, .028], .04);
    ball(joint, "Mitten palm", graphite, [0, -.7, .04], [.135, .125, .115]);
    for (const offset of [-.065, 0, .065]) ball(joint, "Finger", graphite, [offset, -.76, .1], [.037, .064, .045]);
    ball(joint, "Thumb", graphite, [-sign * .12, -.68, .065], [.055, .08, .065]);
    joint.rotation.z = sign * .11;
    return joint;
  }
  function leg(side: "leftLeg" | "rightLeg", sign: number) {
    const joint = group(side, root, [sign * .235, .94, 0]);
    ball(joint, "Hip", graphite, [0, 0, 0], [.15, .14, .16]);
    ball(joint, "Thigh shell", ivory, [0, -.18, 0], [.165, .23, .175]);
    ball(joint, "Knee joint", graphite, [0, -.36, 0], [.135, .14, .145]);
    ball(joint, "Knee plate", sage, [0, -.35, .13], [.135, .135, .055]);
    ball(joint, "Shin shell", ivory, [0, -.56, .015], [.18, .235, .17]);
    box(joint, "Boot sole", graphite, [0, -.865, .115], [.4, .14, .56], .06);
    box(joint, "Ceramic boot", ivory, [0, -.77, .12], [.38, .2, .5], .09);
    box(joint, "Boot toe cap", sage, [0, -.775, .324], [.33, .14, .11], .05);
    return joint;
  }
  const joints: SageJoints = { head, leftEye, rightEye, leftArm: arm("leftArm", -1), rightArm: arm("rightArm", 1), leftLeg: leg("leftLeg", -1), rightLeg: leg("rightLeg", 1) };
  let disposed = false;
  return { root, joints, dispose: () => { if (disposed) return; disposed = true; for (const geo of geometries.values()) geo.dispose(); for (const material of materials) material.dispose(); root.clear(); } };
}
