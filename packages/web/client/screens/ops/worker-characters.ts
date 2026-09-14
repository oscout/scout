import idle from "./assets/worker-rendered-v1.png?url";
import thinking from "./assets/worker-thinking-v1.png?url";
import working from "./assets/worker-working-v1.png?url";
import waiting from "./assets/worker-waiting-v1.png?url";

import pipIdle from "./assets/pip-idle-v1.png?url";
import pipThinking from "./assets/pip-thinking-v1.png?url";
import pipWorking from "./assets/pip-working-v1.png?url";
import pipWaiting from "./assets/pip-waiting-v1.png?url";

export type RenderedWorkerPosture = "idle" | "thinking" | "working" | "waiting";
/** A new friend supplies artwork; state interpretation and animation remain shared. */
export type WorkerCharacter = {
  id: string;
  name: string;
  poses: { idle: string } & Partial<Record<Exclude<RenderedWorkerPosture, "idle">, string>>;
};
export const sageWorker: WorkerCharacter = {
  id: "sage-worker", name: "Sage", poses: { idle, thinking, working, waiting },
};
export const pipWorker: WorkerCharacter = {
  id: "pip-worker", name: "Pip",
  poses: { idle: pipIdle, thinking: pipThinking, working: pipWorking, waiting: pipWaiting },
};
export const workerCharacters: readonly WorkerCharacter[] = [sageWorker, pipWorker];
