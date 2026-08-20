import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export type ScoutDesktopHostServices = {
  pickDirectory?: () => Promise<string | null>;
  reloadWindow?: () => void;
  requestQuit?: () => void;
  openPath?: (targetPath: string) => Promise<string> | string;
  showItemInFolder?: (targetPath: string) => void;
};

export type ScoutHostNativeServices = ScoutDesktopHostServices;

function expandHomePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

export async function pickScoutHostDirectory(
  host: ScoutHostNativeServices = {},
): Promise<string | null> {
  if (!host.pickDirectory) {
    throw new Error("Scout directory picker is unavailable.");
  }

  return host.pickDirectory();
}

export async function quitScoutHostApp(
  host: ScoutHostNativeServices = {},
): Promise<boolean> {
  if (!host.requestQuit) {
    throw new Error("Scout app quit is unavailable.");
  }

  host.requestQuit();
  return true;
}

export async function reloadScoutHostApp(
  host: ScoutHostNativeServices = {},
): Promise<boolean> {
  if (!host.reloadWindow) {
    throw new Error("Scout app reload is unavailable.");
  }

  host.reloadWindow();
  return true;
}

export async function revealScoutHostPath(
  filePath: string,
  host: ScoutHostNativeServices = {},
): Promise<boolean> {
  const targetPath = expandHomePath(filePath);
  if (!targetPath) {
    return false;
  }

  if (existsSync(targetPath)) {
    try {
      const targetStats = await stat(targetPath);
      if (targetStats.isDirectory()) {
        if (!host.openPath) {
          throw new Error("Scout path opening is unavailable.");
        }
        const errorMessage = await host.openPath(targetPath);
        if (errorMessage) {
          throw new Error(errorMessage);
        }
        return true;
      }
    } catch {
      // Fall through to folder reveal for files or stat failures.
    }
  }

  if (!host.showItemInFolder) {
    throw new Error("Scout folder reveal is unavailable.");
  }

  host.showItemInFolder(targetPath);
  return true;
}
