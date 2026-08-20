import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { indexPlanDocuments } from "./plan-documents.ts";

describe("indexPlanDocuments", () => {
  test("indexes plan documents from known plan roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "openscout-plan-docs-"));
    try {
      await mkdir(join(root, "plans"), { recursive: true });
      await mkdir(join(root, ".openscout", "plans"), { recursive: true });
      await mkdir(join(root, ".claude", "plans"), { recursive: true });
      await mkdir(join(root, ".codex", "plans"), { recursive: true });

      await writeFile(
        join(root, "plans", "ship-widget.md"),
        [
          "---",
          "title: Ship Widget",
          "status: active",
          "tags: ui, release",
          "---",
          "# Ship Widget",
          "Get the widget ready to ship.",
          "- [x] Inspect existing UI",
          "- [ ] Build inventory",
        ].join("\n"),
      );
      await writeFile(
        join(root, ".openscout", "plans", "broker.plan.md"),
        "# Broker Plan\n\n1. Trace records\n2. Patch model\n",
      );
      await writeFile(
        join(root, ".claude", "plans", "claude-plan.md"),
        "# Claude Plan\n\n- [!] Resolve blocker\n",
      );
      await writeFile(
        join(root, ".codex", "plans", "codex-plan.md"),
        "# Codex Plan\n\n- [~] Implement route\n",
      );

      const result = await indexPlanDocuments({ currentDirectory: root, includeHome: false });

      expect(result.documents.map((document) => document.title).sort()).toEqual([
        "Broker Plan",
        "Claude Plan",
        "Codex Plan",
        "Ship Widget",
      ]);
      expect(result.totals).toEqual(expect.objectContaining({
        documents: 4,
        claude: 1,
        codex: 1,
        openscout: 1,
        workspace: 1,
      }));

      const ship = result.documents.find((document) => document.title === "Ship Widget");
      expect(ship?.steps).toHaveLength(2);
      expect(ship?.steps[0]?.status).toBe("completed");
      expect(ship?.steps[1]?.status).toBe("pending");
      expect(ship?.status).toBe("active");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
