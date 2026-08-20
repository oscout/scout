import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Browser-safety guard for the `./client` subpath. Web and mobile trace
// consumers import from "@openscout/agent-sessions/client" and must never pull
// Node/Bun runtime code into their bundle. This walks the RUNTIME import graph
// from client.ts — statement-level type-only imports are erased by the compiler,
// so they are intentionally not followed — and asserts every reached module is
// browser-safe. It mirrors the boundary-enforcement style of local.test.ts.

const SRC = import.meta.dir;

// The runtime modules reachable from client.ts, as paths relative to src/.
// Adding a value import to client.ts (or anything it pulls in) fails this test
// until the module is listed here — that is the point: entering the browser
// surface must be a conscious decision, not an accident.
const ALLOWLIST = new Set([
  "client.ts",
  "protocol/primitives.ts",
  "protocol/approval-normalization.ts",
  "model-context-window.ts",
  "adapters/codex/context-window.ts",
  "model-catalog.ts",
  "model-windows.generated.ts",
  "runtime-model-windows.generated.ts",
  "model-window-registry.ts",
]);

const BROWSER_UNSAFE: RegExp[] = [
  /(?:from|import)\s*["']node:/, // a node: builtin import (bare or named)
  /\brequire\s*\(/, // CommonJS require
  /\bBun\./, // the Bun global
];

// Remove statement-level `import type` / `export type … from "…"` — erased at
// runtime, so part of neither the browser bundle graph nor its runtime surface.
function stripTypeOnlyImports(source: string): string {
  return source.replace(
    /\b(?:import|export)\s+type\s*(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*from\s*["'][^"']+["']/gs,
    "",
  );
}

function runtimeRelativeImports(source: string): string[] {
  const runtime = stripTypeOnlyImports(source);
  const specs: string[] = [];
  const re = /from\s*["'](\.[^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(runtime)) !== null) {
    specs.push(match[1]!);
  }
  return specs;
}

function walkRuntimeGraph(entry: string): Set<string> {
  const reached = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    if (reached.has(rel)) continue;
    reached.add(rel);
    const abs = join(SRC, rel);
    for (const spec of runtimeRelativeImports(readFileSync(abs, "utf8"))) {
      const resolvedAbs = resolve(dirname(abs), spec).replace(/\.js$/, ".ts");
      stack.push(resolvedAbs.slice(SRC.length + 1));
    }
  }
  return reached;
}

describe("@openscout/agent-sessions/client browser-safety", () => {
  const reached = walkRuntimeGraph("client.ts");

  test("runtime graph stays within the browser-safe allowlist", () => {
    const unexpected = [...reached].filter((file) => !ALLOWLIST.has(file)).sort();
    expect(unexpected).toEqual([]);
  });

  test("no reached module uses Node/Bun runtime APIs", () => {
    const offenders: string[] = [];
    for (const rel of reached) {
      // Scan the runtime surface: type-only imports are erased, so a type-only
      // node: import would not ship to the browser and must not false-positive.
      const source = stripTypeOnlyImports(readFileSync(join(SRC, rel), "utf8"));
      for (const pattern of BROWSER_UNSAFE) {
        if (pattern.test(source)) offenders.push(`${rel} matched ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
