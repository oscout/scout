# Sprout authored action proof v1

Original reference: `public/crew/sprout-bust.webp`. That approved art is untouched.
The new atlas was generated with the built-in image tool, then corrected through
that tool for stride/passing frames and actual background removal. No CSS body
rotation or translation is used to simulate running in the renderer.

Rows: run, jump, land, idle. Four frames each. Actual leg/arm poses, airborne tuck,
and landing crouch are present. This is an exploratory four-frame proof, not a
finished animation pack: run repeats a stride/passing pair, idle contains hand
movement rather than a clean breathing-only loop, framing and small costume
lettering vary slightly, and alpha has residual low-opacity edge specks.
Do not replace the approved Crew renderer by default without visual review.

PNG: 1262×1246, true RGBA alpha (0–255), no baked checkerboard. Renderer uses
explicit row/column boundaries to avoid neighboring frames. Pose geometry is
image-authored, while map travel remains caller-owned.

Use `SproutActionSprite` with action `run | jump | land | idle`, size (pixels),
and paused. `SproutActionProof` supplies local action controls for a preview.
Playback freezes for paused, hidden, offscreen and reduced-motion conditions.

Generation intent: preserve Sprout's leaf-topped yellow head, orange padded suit,
bolted collar, camera and green patches; right-facing three-quarter camera;
separate run gait / jump phases / landing recovery / idle poses in a 4×4 atlas.
Accepted background-removal output: exec-5b35ac5c-f690-47a1-b54b-2d3e94c21328.png.
