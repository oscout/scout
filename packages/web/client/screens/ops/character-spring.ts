export type CharacterSpringState = { x: number; y: number; vx: number; vy: number };
export type CharacterSpringTarget = { x: number; y: number };

// Exact critically damped solution avoids Euler instability at variable refresh rates.
const FREQUENCY = 16;
const MAX_FRAME_SECONDS = .05;
const POSITION_EPSILON = .01;
const VELOCITY_EPSILON = .01;

function axis(position: number, velocity: number, target: number, dt: number): [number, number] {
  const displacement = position - target;
  const coefficient = velocity + FREQUENCY * displacement;
  const decay = Math.exp(-FREQUENCY * dt);
  const nextPosition = target + (displacement + coefficient * dt) * decay;
  const nextVelocity = (velocity - FREQUENCY * coefficient * dt) * decay;
  return Math.abs(nextPosition - target) < POSITION_EPSILON && Math.abs(nextVelocity) < VELOCITY_EPSILON
    ? [target, 0] : [nextPosition, nextVelocity];
}

/** Coordinates are pixels and velocity is pixels/second. Rotation stays caller-owned.
 * Frames above 50ms advance only 50ms, avoiding a jump after a hidden tab resumes.
 * Zero/negative/non-finite time freezes the state. This function never mutates input.
 */
export function stepCharacterSpring(state: CharacterSpringState, target: CharacterSpringTarget, dtSeconds: number): CharacterSpringState {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { ...state };
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return { ...state };
  if (![state.x, state.y, state.vx, state.vy].every(Number.isFinite)) return { ...target, vx: 0, vy: 0 };
  const dt = Math.min(dtSeconds, MAX_FRAME_SECONDS);
  const [x, vx] = axis(state.x, state.vx, target.x, dt);
  const [y, vy] = axis(state.y, state.vy, target.y, dt);
  return { x, y, vx, vy };
}
