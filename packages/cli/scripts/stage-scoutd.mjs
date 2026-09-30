import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Keep the prior executable until signing the replacement has succeeded. */
export function stageScoutd({ sourceBinary, packagedBinary, sign, requireSignature }) {
  mkdirSync(dirname(packagedBinary), { recursive: true });
  const stagingDirectory = resolve(dirname(packagedBinary), `.scoutd-staging-${process.pid}`);
  const stagedBinary = resolve(stagingDirectory, "scoutd");
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  try {
    copyFileSync(sourceBinary, stagedBinary);
    chmodSync(stagedBinary, 0o755);
    const signed = sign(stagedBinary);
    if (!signed && requireSignature) return false;
    renameSync(stagedBinary, packagedBinary);
    return true;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
