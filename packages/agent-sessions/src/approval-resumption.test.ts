import { expect, test } from "bun:test";
import { EchoAdapter } from "./adapters/echo/adapter.ts";
import { SessionRegistry } from "./registry.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for adapter evidence");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const decision of ["approve", "deny"] as const) {
  test(`observed adapter execution after ${decision} is distinct from submission`, async () => {
    const registry = new SessionRegistry({ adapters: { echo: config => new EchoAdapter(config) } });
    const session = await registry.createSession("echo", { sessionId: `approval-${decision}`, options: { requireApproval: true, stepDelay: 1 } });
    const snapshot = () => registry.getSessionSnapshot(session.id)!;
    try {
      registry.send({ sessionId: session.id, text: "Controlled resumption evidence" });
      await until(() => snapshot().turns.some(turn => turn.blocks.some(({ block }) => block.type === "action" && block.action.status === "awaiting_approval")));
      const turn = snapshot().turns.at(-1)!;
      const block = turn.blocks.find(({ block }) => block.type === "action")!.block;
      if (block.type !== "action") throw new Error("Expected action block");
      expect(turn.status).not.toBe("completed");
      expect(block.action.output).toBe("");
      const input = { sessionId: session.id, turnId: turn.id, blockId: block.id, version: block.action.approval!.version, decision };
      registry.decide(input);
      // Submission does not optimistically mutate the observed snapshot.
      expect(snapshot().turns.at(-1)!.blocks.find(item => item.block.id === block.id)?.block).toMatchObject({ action: { status: "awaiting_approval" } });
      expect(() => registry.decide(input)).toThrow("already submitted");
      await until(() => snapshot().turns.at(-1)?.status === "completed");
      const observed = snapshot().turns.at(-1)!.blocks.find(item => item.block.id === block.id)?.block!;
      expect(observed).toMatchObject({ action: { status: decision === "approve" ? "completed" : "failed", output: decision === "approve" ? "Controlled resumption evidence" : "" } });
    } finally { await registry.closeSession(session.id); }
  });
}
