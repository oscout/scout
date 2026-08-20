// Headless fixture generation: the agents model transitively imports router.ts,
// which pulls in React hooks at module load. The model only needs the trivial
// `conversationForAgent` from router, so replace router.ts with a pure stub and
// React is never touched.
import { plugin } from "bun";

plugin({
  name: "stub-router",
  setup(build) {
    build.onLoad({ filter: /client\/lib\/router\.ts$/ }, () => ({
      loader: "ts",
      contents: `export function conversationForAgent(agentId) { return "dm.operator." + agentId; }`,
    }));
  },
});
