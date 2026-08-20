import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, "..");

// These files use process-wide module mocks or service roots; keep them out of
// the shared Bun process so cached mocks and env changes cannot leak.
const isolatedServerTests = new Set([
  "./server/core/agents/service.test.ts",
  "./server/core/conversations/service.test.ts",
  "./server/core/observe/service.sources.test.ts",
  "./server/core/pairing/service.test.ts",
  "./server/create-openscout-web-server.test.ts",
  "./server/service-budgets.test.ts",
  "./server/work-materials.test.ts",
]);

function findTests(root, predicate) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!predicate(path)) continue;
      files.push(`./${relative(packageRoot, path).split(sep).join("/")}`);
    }
  };
  visit(join(packageRoot, root));
  return files.sort();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const serverTests = findTests("server", (path) => /\.test\.tsx?$/u.test(path));
const regularServerTests = serverTests.filter((path) => !isolatedServerTests.has(path));

run("bun", ["test", "--isolate", "./client", ...regularServerTests]);

for (const testFile of isolatedServerTests) {
  run("bun", ["test", "--isolate", testFile]);
}

const nodeTests = findTests("test", (path) => /\.test\.mjs$/u.test(path));
if (nodeTests.length > 0) {
  run("node", ["--test", ...nodeTests]);
}
