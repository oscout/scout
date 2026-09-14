import { expect, test } from "bun:test";
import { stepCharacterSpring, type CharacterSpringState } from "./character-spring.ts";

test("settles exactly and stays settled without mutating inputs", () => {
  const initial = { x: 100, y: -40, vx: 0, vy: 0 };
  const target = { x: 5, y: 10 };
  let state = initial;
  for (let i = 0; i < 300; i++) state = stepCharacterSpring(state, target, 1 / 60);
  expect(state).toEqual({ ...target, vx: 0, vy: 0 });
  expect(stepCharacterSpring(state, target, .03)).toEqual(state);
  expect(initial).toEqual({ x: 100, y: -40, vx: 0, vy: 0 });
});

test("variable frame partitions preserve motion before settling", () => {
  const initial = { x: -30, y: 14, vx: 90, vy: -12 };
  const target = { x: 100, y: -20 };
  const whole = stepCharacterSpring(initial, target, .04);
  const split = stepCharacterSpring(stepCharacterSpring(initial, target, .013), target, .027);
  for (const key of ["x", "y", "vx", "vy"] as const) expect(split[key]).toBeCloseTo(whole[key], 10);
});

test("rest release converges without overshooting", () => {
  let state: CharacterSpringState = { x: 80, y: -80, vx: 0, vy: 0 };
  for (let i = 0; i < 200; i++) {
    const next = stepCharacterSpring(state, { x: 0, y: 0 }, .016);
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.x).toBeLessThanOrEqual(state.x);
    expect(next.y).toBeLessThanOrEqual(0);
    state = next;
  }
});

test("long frames clamp and invalid time does not advance", () => {
  const state = { x: 100, y: 0, vx: 0, vy: 2 };
  const target = { x: 0, y: 0 };
  expect(stepCharacterSpring(state, target, 10)).toEqual(stepCharacterSpring(state, target, .05));
  for (const dt of [0, -1, NaN, Infinity]) expect(stepCharacterSpring(state, target, dt)).toEqual(state);
});

test("large release velocity remains finite and settles", () => {
  let state = { x: 0, y: 0, vx: 20_000, vy: -10_000 };
  for (let i = 0; i < 300; i++) state = stepCharacterSpring(state, { x: 0, y: 0 }, i % 2 ? .01 : .04);
  expect(state).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
});
