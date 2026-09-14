import type { ReactNode } from "react";

export type CharacterMood = "neutral" | "curious" | "focused" | "concerned" | "pleased";
export type CharacterAction = "idle" | "thinking" | "working" | "walking" | "communicating";
export type CharacterInteraction = { hovered?: boolean; selected?: boolean; dragged?: boolean; receivingMessage?: boolean };
export type CharacterState = { mood: CharacterMood; action: CharacterAction; interaction: CharacterInteraction };
export type CharacterPoint = { x: number; y: number };
/** World-space motion, independent of Flat/Iso camera projection. */
export type CharacterMovement = {
  position: CharacterPoint;
  destination?: CharacterPoint;
  heading: number; // radians, zero points along world +X
  speed: number; // world units per second
  phase: "stationary" | "turning" | "moving" | "arriving" | "blocked";
};
export type CharacterNavigationRequest = {
  destination: CharacterPoint;
  preferredSpeed?: number;
  arrivalRadius?: number;
};
export type CharacterRenderProps = {
  identity: string;
  state: CharacterState;
  movement?: CharacterMovement;
  motion: "normal" | "paused" | "reduced";
  size: number;
};
/** Geometry and transitions belong to the implementation, never to the world. */
export interface CharacterDefinition {
  id: string;
  render: (props: CharacterRenderProps) => ReactNode;
}
