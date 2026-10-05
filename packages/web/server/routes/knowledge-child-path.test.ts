import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { knowledgeIndexChildPath } from "./knowledge.ts";

describe("knowledgeIndexChildPath", () => {
  test("finds the TS child from the routes directory in dev", () => {
    const path = knowledgeIndexChildPath();
    expect(path).not.toBeNull();
    expect(path!.endsWith("server/knowledge-index-child.ts")).toBe(true);
    expect(existsSync(path!)).toBe(true);
  });

  test("finds the bundled .mjs beside the server bundle", () => {
    const bundle = new URL("../../dist/openscout-web-server.mjs", import.meta.url);
    const path = knowledgeIndexChildPath(bundle);
    if (existsSync(new URL("../../dist/knowledge-index-child.mjs", import.meta.url))) {
      expect(path!.endsWith("dist/knowledge-index-child.mjs")).toBe(true);
    } else {
      expect(path).toBeNull();
    }
  });
});
