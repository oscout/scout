#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const packageDir = path.resolve(process.argv[2] ?? ".");
const pkgPath = path.join(packageDir, "package.json");
const backupPath = path.join(packageDir, ".package.json.publish-backup");

if (existsSync(backupPath)) {
  await fs.copyFile(backupPath, pkgPath);
  await fs.unlink(backupPath);
}
