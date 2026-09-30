import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageScoutd } from "../scripts/stage-scoutd.mjs";

for (const scenario of ["failure", "success", "throw"]) {
  test(`scoutd staging preserves the prior binary until signing: ${scenario}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "scoutd-stage-test-"));
    const sourceBinary = join(directory, "release-scoutd");
    const packagedBinary = join(directory, "scoutd");
    writeFileSync(sourceBinary, "new binary");
    writeFileSync(packagedBinary, "prior binary");
    try {
      const install = () => stageScoutd({ sourceBinary, packagedBinary, requireSignature: true,
        sign: staged => {
          assert.equal(readFileSync(packagedBinary, "utf8"), "prior binary");
          assert.equal(readFileSync(staged, "utf8"), "new binary");
          if (scenario === "throw") throw new Error("signer unavailable");
          if (scenario === "success") writeFileSync(staged, "signed new binary");
          return scenario === "success";
        },
      });
      if (scenario === "throw") assert.throws(install, /signer unavailable/);
      else assert.equal(install(), scenario === "success");
      assert.equal(readFileSync(packagedBinary, "utf8"), scenario === "success" ? "signed new binary" : "prior binary");
      assert.deepEqual(readdirSync(directory).sort(), ["release-scoutd", "scoutd"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
