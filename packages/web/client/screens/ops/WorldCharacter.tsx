import { RiggedWorkerCharacter } from "./RiggedWorkerCharacter.tsx";
import type { CharacterDefinition, CharacterRenderProps } from "./character-contract.ts";

export const ceramicWorker: CharacterDefinition = {
  id: "ceramic-worker",
  render: ({ identity, state, motion, size }) => <RiggedWorkerCharacter
    identity={identity}
    posture={state.mood === "concerned" ? "waiting" : state.action === "thinking" ? "thinking" : state.action === "working" || state.action === "communicating" ? "working" : "idle"}
    paused={motion !== "normal"}
    size={size}
  />,
};

/** The map supplies behavior; swapping definitions never exposes geometry to it. */
export function WorldCharacter({ definition = ceramicWorker, ...props }: CharacterRenderProps & { definition?: CharacterDefinition }) {
  const Renderer = definition.render;
  return <Renderer {...props} />;
}
