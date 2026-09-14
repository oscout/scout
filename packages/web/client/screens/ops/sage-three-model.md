# Sage procedural model prototype

`createSageModel()` creates actual Three.js geometry, with +Z facing forward,
boots at approximately y=0, and a total height around 3.4 units. This is a procedural
interpretation of the original cream-and-sage character, not a reconstructed mesh
from the PNG. Rounded ceramic volumes, beveled visor, ear fins, sage panels,
graphite joints, and mint eye assemblies carry that identity.

The viewer owns renderer, camera, environment lighting, shadows, pose animation,
and export. Add the returned `root` to a scene. `joints` exposes head, leftArm,
rightArm, leftLeg, rightLeg, leftEye, and rightEye groups. Capture original joint
transforms before applying offsets. Head and eyes rotate around their own centers;
arms pivot at shoulders and legs at hips. A named `eyes` parent group sits inside
head. Eye scaling can blink without moving the visor; pupils/catchlights remain
separate meshes. Idle arms have a small outward splay. Left means negative X.

Materials are standard Three.js physical materials. All artwork is mesh geometry;
no raster textures, SVGs, custom shaders, or network requests. Shared primitive
geometries reduce duplicate resources. Call the idempotent `dispose()` when the
viewer unmounts; it releases every owned geometry/material and clears the root.
Remove root from its scene first. This is a rigid-joint prototype, not a skinned
production rig; it has no IK, elbow articulation, or collision system.
