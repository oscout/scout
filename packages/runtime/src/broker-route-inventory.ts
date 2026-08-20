/**
 * Source-level extraction of the broker HTTP route inventory ("METHOD path"),
 * shared by broker-daemon-route-inventory.test.ts (the checked-in snapshot)
 * and mesh-route-matrix.test.ts (the deny-by-default tier cross-check). Pure
 * string-in/string-out so tests supply the router sources.
 */

export type LiteralRouteBranch = {
  method: string;
  path: string;
  line: number;
};

export function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

export function literalRouteBranches(source: string): LiteralRouteBranch[] {
  const branches: LiteralRouteBranch[] = [];
  const patterns = [
    /method\s*===\s*"([A-Z]+)"\s*&&\s*url\.pathname\s*===\s*"([^"]+)"/g,
    /url\.pathname\s*===\s*"([^"]+)"\s*&&\s*method\s*===\s*"([A-Z]+)"/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const method = pattern === patterns[0] ? match[1] : match[2];
      const path = pattern === patterns[0] ? match[2] : match[1];
      if (!method || !path) continue;
      branches.push({
        method,
        path,
        line: lineNumberAt(source, match.index ?? 0),
      });
    }
  }

  return branches;
}

function routePatternFromRegexSource(pattern: string): string {
  return pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replaceAll("([^/]+)", ":id")
    .replaceAll("\\/", "/")
    .replaceAll("\\.", ".");
}

// Extracts every "METHOD path" route the router dispatches on, covering the
// dispatch shapes used in broker-http-router.ts and
// broker-http-entity-write-routes.ts:
//   - method === "M" && url.pathname === "P" (and the flipped order)
//   - method === "M" && (url.pathname === "P1" || url.pathname === "P2" || …)
//   - (url.pathname === "P1" || url.pathname === "P2") && method === "M"
//   - (method === "M1" || method === "M2") && url.pathname === "P"
//   - const xMatch = method === "M" [|| method === "M2"] ? url.pathname.match(/…/) : null
//   - method === "M" && url.pathname.startsWith("P")
// Param captures ([^/]+) are rendered as ":id".
export function extractRouteInventory(source: string): Set<string> {
  const text = source.replace(/\s+/g, " ");
  const routes = new Set<string>();

  // const xMatch = method === "M" [|| method === "M2"] ? url.pathname.match(/…/) : null
  for (const match of text.matchAll(
    /method === "([A-Z]+)"(?: \|\| method === "([A-Z]+)")? \? url\.pathname\.match\(\/([^ ]+?)\/\) : null/g,
  )) {
    const path = routePatternFromRegexSource(match[3] ?? "");
    for (const method of [match[1], match[2]]) {
      if (method) routes.add(`${method} ${path}`);
    }
  }

  // method === "M" && (url.pathname === "P1" || url.pathname === "P2" || …)
  for (const match of text.matchAll(
    /method === "([A-Z]+)" && \(([^()]*url\.pathname === [^()]*)\)/g,
  )) {
    for (const path of (match[2] ?? "").matchAll(/url\.pathname === "([^"]+)"/g)) {
      routes.add(`${match[1]} ${path[1]}`);
    }
  }

  // (url.pathname === "P1" || url.pathname === "P2") && method === "M"
  for (const match of text.matchAll(
    /\((url\.pathname === "[^"]+"(?: \|\| url\.pathname === "[^"]+")*)\) && method === "([A-Z]+)"/g,
  )) {
    for (const path of (match[1] ?? "").matchAll(/url\.pathname === "([^"]+)"/g)) {
      routes.add(`${match[2]} ${path[1]}`);
    }
  }

  // (method === "M1" || method === "M2") && url.pathname === "P"
  for (const match of text.matchAll(
    /\(method === "([A-Z]+)" \|\| method === "([A-Z]+)"\) && url\.pathname === "([^"]+)"/g,
  )) {
    routes.add(`${match[1]} ${match[3]}`);
    routes.add(`${match[2]} ${match[3]}`);
  }

  // method === "M" && url.pathname === "P" (and the flipped order)
  for (const match of text.matchAll(/method === "([A-Z]+)" && url\.pathname === "([^"]+)"/g)) {
    routes.add(`${match[1]} ${match[2]}`);
  }
  for (const match of text.matchAll(/url\.pathname === "([^"]+)" && method === "([A-Z]+)"/g)) {
    routes.add(`${match[2]} ${match[1]}`);
  }

  // method === "M" && url.pathname.startsWith("P")
  for (const match of text.matchAll(
    /method === "([A-Z]+)" && url\.pathname\.startsWith\("([^"]+)"\)/g,
  )) {
    routes.add(`${match[1]} ${match[2]}:id`);
  }

  return routes;
}
