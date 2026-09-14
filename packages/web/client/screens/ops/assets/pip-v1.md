# Pip — companion pose pack v1

Pip is a separate visual identity in Sage's rendered robot family, not an agent
nickname. The compact body, rounded-square head, circular side sensors without
fins, ochre panels, and blue eyes distinguish Pip from Sage. Ivory ceramic,
charcoal joints, front three-quarter camera, and soft studio lighting connect them.

Use `pipWorker` from `worker-characters.ts` with the existing
`RenderedWorkerSprite` character prop. The same posture, pause, offscreen and
reduced-motion behavior applies. No per-character state logic or color filter.

## Assets

| Pose | File | Expression |
| --- | --- | --- |
| Idle | pip-idle-v1.png | Relaxed hands, feet planted |
| Thinking | pip-thinking-v1.png | Hand on chin, tilted head |
| Working | pip-working-v1.png | Focused on a small tablet |
| Waiting | pip-waiting-v1.png | Hands clasped, patient stance |

These are four individual pose illustrations, not a rig or frame animation.
Caller must use actual observed thinking evidence for the thinking posture.

## Generation recipe

Generated through the built-in image tool, using `worker-rendered-v1.png` as the
initial style reference. After establishing Pip, all final pose requests used
Pip's own idle cutout as their reference. No image editing or color replacement
scripts were used; only original generated PNGs were copied into this directory.

Initial character brief:

> A new compact, short robot with a softly squared oversized head, circular side
> sensor discs without tall fins, stout legs and rounded boots, mitten hands.
> Ivory ceramic shell, golden ochre panels, charcoal joints and luminous blue
> eyes on a black face screen. Match Sage's polished 3D materials, lighting and
> front three-quarter camera. Full body, centered, no text or scenery.

Pose invariants:

> Preserve identical identity, head and side sensors, blue eyes, ivory/ochre
> armor, short legs, camera and lighting. Change only pose and expression.
> Full body, feet visible. Transparent PNG alpha background; never render a
> checkerboard. No floor, external shadow, text or symbols.

Gesture additions: thinking uses one hand at chin and the other supporting its
elbow; working taps a charcoal tablet; waiting clasps hands at waist level.

## QA

All accepted images inspected visually and checked with `sips` plus a read-only
Pillow alpha histogram. All four contain actual zero-alpha background pixels
and more than 500,000 pixels with alpha at least 250. Initial checkerboard-painted
outputs were rejected. The idle cutout is 1225×1284; other poses are 1254×1254.
The shared contain sizing handles those dimensions. Small edge/framing variation
remains typical of generated poses; this is a prototype pack, not a locked rig.

Accepted generation receipts (original outputs retained under Codex generated images):
- Idle: exec-44e66c92-09b6-4909-a8f2-b47251f749ae.png
- Thinking: exec-30de85a9-17cb-4334-8822-47147de0f3b6.png
- Working: exec-c9e0f8f8-d575-487c-86eb-1a394e5fab8d.png
- Waiting: exec-394b03fa-e1bf-4e12-8734-61d131af2269.png
