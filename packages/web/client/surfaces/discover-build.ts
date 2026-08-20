import type { ComponentType } from "react";
import {
  defaultEmbedPath,
  type EmbedScreenProps,
  type RegisteredSurface,
  type ScoutSurfaceDefinition,
} from "./types.ts";

export type SurfaceModule = {
  scoutSurface?: ScoutSurfaceDefinition;
  [exportName: string]: unknown;
};

export type SurfaceModuleLoader = () => Promise<SurfaceModule>;

export type LazySurfaceModule = {
  modulePath: string;
  embedPaths: readonly string[];
};

function isComponentType(value: unknown): value is ComponentType<EmbedScreenProps & Record<string, unknown>> {
  return typeof value === "function";
}

function registerSurface(modulePath: string, mod: SurfaceModule): RegisteredSurface | null {
  const definition = mod.scoutSurface;
  if (!definition?.embed) return null;

  const Screen = mod[definition.screen];
  if (!isComponentType(Screen)) {
    throw new Error(
      `scoutSurface "${definition.id}" in ${modulePath} references screen "${definition.screen}" but no such component export was found.`,
    );
  }

  const embedPath = definition.embed.path ?? defaultEmbedPath(definition.id);
  const aliasPaths = definition.embed.aliases ?? [];
  const embedPaths = [embedPath, ...aliasPaths];

  return {
    ...definition,
    modulePath,
    Screen,
    embedPath,
    embedPaths,
  };
}

export function buildSurfaceRegistry(screenModules: Record<string, SurfaceModule>): {
  surfaces: RegisteredSurface[];
  embedByPath: Map<string, RegisteredSurface>;
} {
  const surfaces: RegisteredSurface[] = [];
  for (const [modulePath, mod] of Object.entries(screenModules)) {
    const registered = registerSurface(modulePath, mod);
    if (registered) surfaces.push(registered);
  }

  surfaces.sort((a, b) => a.id.localeCompare(b.id));

  const embedByPath = new Map<string, RegisteredSurface>();
  for (const surface of surfaces) {
    for (const path of surface.embedPaths) {
      if (embedByPath.has(path)) {
        throw new Error(
          `Duplicate embed path "${path}" registered by "${embedByPath.get(path)!.id}" and "${surface.id}".`,
        );
      }
      embedByPath.set(path, surface);
    }
  }

  return { surfaces, embedByPath };
}

export function buildLazySurfaceRegistry(
  screenModules: Record<string, SurfaceModuleLoader>,
  lazySurfaceModules: readonly LazySurfaceModule[],
): {
  loadAll: () => Promise<RegisteredSurface[]>;
  resolve: (pathname: string) => Promise<RegisteredSurface | null>;
} {
  const modulePathByEmbedPath = new Map<string, string>();
  const declaredPathsByModulePath = new Map<string, readonly string[]>();

  for (const entry of lazySurfaceModules) {
    if (!screenModules[entry.modulePath]) {
      throw new Error(`No screen module loader was found for "${entry.modulePath}".`);
    }
    declaredPathsByModulePath.set(entry.modulePath, entry.embedPaths);
    for (const path of entry.embedPaths) {
      const existingModulePath = modulePathByEmbedPath.get(path);
      if (existingModulePath) {
        throw new Error(
          `Duplicate lazy embed path "${path}" registered by "${existingModulePath}" and "${entry.modulePath}".`,
        );
      }
      modulePathByEmbedPath.set(path, entry.modulePath);
    }
  }

  const surfaceByModulePath = new Map<string, Promise<RegisteredSurface>>();
  const loadSurface = (modulePath: string): Promise<RegisteredSurface> => {
    const cached = surfaceByModulePath.get(modulePath);
    if (cached) return cached;

    const loader = screenModules[modulePath]!;
    const pending = loader().then((mod) => {
      const { surfaces } = buildSurfaceRegistry({ [modulePath]: mod });
      const surface = surfaces[0];
      if (!surface) {
        throw new Error(`Screen module "${modulePath}" does not export an embeddable scoutSurface.`);
      }

      const declaredPaths = declaredPathsByModulePath.get(modulePath) ?? [];
      const missingPath = declaredPaths.find((path) => !surface.embedPaths.includes(path));
      if (missingPath) {
        throw new Error(
          `Lazy embed path "${missingPath}" is not declared by scoutSurface "${surface.id}" in "${modulePath}".`,
        );
      }
      const undeclaredPath = surface.embedPaths.find((path) => !declaredPaths.includes(path));
      if (undeclaredPath) {
        throw new Error(
          `scoutSurface "${surface.id}" in "${modulePath}" declares unregistered lazy embed path "${undeclaredPath}".`,
        );
      }
      return surface;
    });
    surfaceByModulePath.set(modulePath, pending);
    return pending;
  };

  return {
    async loadAll() {
      const surfaces = await Promise.all(
        lazySurfaceModules.map((entry) => loadSurface(entry.modulePath)),
      );
      return surfaces.sort((a, b) => a.id.localeCompare(b.id));
    },
    async resolve(pathname) {
      const modulePath = modulePathByEmbedPath.get(pathname);
      if (!modulePath) return null;
      return loadSurface(modulePath);
    },
  };
}
