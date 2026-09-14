import { expect, test } from "bun:test";
import { handleDiagnosticCommand } from "./report.ts";
import { prefilterHandle } from "./prefilter.ts";
import { parseScoutbotDirectives } from "./directives.ts";

test("reports are recognized before model invocation", () => {
  expect(parseScoutbotDirectives("/report broken UI").command?.name).toBe("report");
  expect(prefilterHandle("/report broken UI", {} as any)?.metadata.matched_rule).toBe("slash.report");
});
test("only explicit leading commands upload; feedback is note-only by default", async () => {
  const calls: any[] = [];
  const submit = async (options: any) => { calls.push(options); return { id: "id", status: "uploaded" as const, localPath: "/local/report.json" }; };
  await handleDiagnosticCommand("what does /report do?", submit);
  await handleDiagnosticCommand("/feedback", submit);
  expect(calls).toHaveLength(0);
  expect(await handleDiagnosticCommand("/feedback useful app", submit)).toContain("Report uploaded");
  expect(calls[0].diagnostics).toBe(false);
  await handleDiagnosticCommand("/report broke --local-only", submit);
  expect(calls[1]).toEqual({ message: "broke", diagnostics: true, localOnly: true });
  await handleDiagnosticCommand("/feedback broke --diagnostics", submit);
  expect(calls[2].diagnostics).toBe(true);
});
