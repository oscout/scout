import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { AnimationMixer, Bone, SkinnedMesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

test("Blender export retains a working skeleton and four distinct animated actions", async () => {
  const bytes = await readFile(new URL("../../public/characters/sage/sage.glb", import.meta.url));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(data, "");
  const names = gltf.animations.map(clip => clip.name.toLowerCase());
  for (const name of ["idle", "thinking", "working", "walking"]) expect(names).toContain(name);
  let skinned = 0;
  gltf.scene.traverse(node => { if (node instanceof SkinnedMesh) { skinned++; expect(node.skeleton.bones.length).toBeGreaterThan(6); } });
  expect(skinned).toBeGreaterThan(0);
  const mixer = new AnimationMixer(gltf.scene);
  const pose = () => {
    const values: number[] = [];
    gltf.scene.traverse(node => { if (node instanceof Bone) values.push(...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()); });
    return values;
  };
  for (const clip of gltf.animations) {
    expect(clip.duration).toBeGreaterThan(0);
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play(); mixer.update(0);
    const start = pose(); mixer.update(clip.duration * .37);
    expect(pose().some((value, index) => Math.abs(value - start[index]!) > .0001)).toBe(true);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
});
