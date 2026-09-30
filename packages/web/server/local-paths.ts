import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function resolveExplorablePath(
  targetPath: string,
  basePath: string | null | undefined,
  currentDirectory: string,
): string {
  const expandedTarget = expandHomePath(targetPath.trim());
  const expandedBase = basePath?.trim()
    ? expandHomePath(basePath.trim())
    : currentDirectory;
  return resolve(expandedBase, expandedTarget);
}
