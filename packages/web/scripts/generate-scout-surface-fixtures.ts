import { resolve } from "node:path";
import { SCOUT_SURFACE_V1_GOLDEN_FIXTURES } from "../client/surface-contract/scout-surface-contract.fixtures.ts";

const output = resolve(
  import.meta.dir,
  "../client/surface-contract/fixtures/scout-surface-contract-v1.json",
);

await Bun.write(output, `${JSON.stringify(SCOUT_SURFACE_V1_GOLDEN_FIXTURES, null, 2)}\n`);
console.log(output);
