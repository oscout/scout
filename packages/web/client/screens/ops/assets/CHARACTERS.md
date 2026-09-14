# Worker character family

The first character, Sage, has four transparent rendered poses: idle, thinking,
working, and waiting. These are individual rendered images with shared CSS motion,
not a frame-by-frame walk cycle or a realtime 3D rig.

`worker-characters.ts` defines the reusable character contract. Add a character
with an ID, display name and idle image; optionally add thinking, working and
waiting images. Missing poses fall back to idle. `RenderedWorkerSprite` accepts
that character definition and reuses pose transitions, motion, pause, offscreen
suspension and reduced-motion handling. Artwork identity stays separate from the
agent nickname and session identity.

For a consistent new friend, use the original character as an image reference.
Keep the camera, body proportions, framing, soft materials and upper-left light.
Vary a small number of identity details. Generate each pose against that friend's
idle reference, preserve actual transparency, and inspect at map scale before
adding the definition. Do not regenerate the whole cast for a new pose.

The live caller selects thinking only from an observed thinking event. Working
follows recent observed work; attention or blocked activity selects waiting.
