import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

test("every hosted workflow requires an explicit manual or callable entry point", () => {
  const directory = resolve(import.meta.dir, "../../../../.github/workflows");
  const workflows = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  expect(workflows.length).toBeGreaterThan(0);
  for (const name of workflows) {
    const workflow = Bun.YAML.parse(readFileSync(join(directory, name), "utf8")) as { on: Record<string, unknown> };
    expect(typeof workflow.on).toBe("object");
    expect(Object.keys(workflow.on).length).toBeGreaterThan(0);
    for (const trigger of Object.keys(workflow.on)) expect(["workflow_dispatch", "workflow_call"]).toContain(trigger);
  }
});
