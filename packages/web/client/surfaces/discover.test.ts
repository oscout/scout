import { describe, expect, test } from "bun:test";
import { buildLazySurfaceRegistry, buildSurfaceRegistry } from "./discover-build.ts";
import { defineSurface } from "./types.ts";

function mockScreen() {
  return null;
}

const brokerSurface = defineSurface({
  id: "dispatch",
  label: "Dispatch",
  route: { view: "broker" },
  webPath: "/dispatch",
  screen: "BrokerScreen",
  embed: {
    path: "/embed/dispatch",
    profile: "macos.dispatch",
  },
});

const lanesSurface = defineSurface({
  id: "lanes",
  label: "Lanes",
  route: { view: "ops", mode: "lanes" },
  webPath: "/ops/lanes",
  screen: "AgentLanesView",
  embed: {
    path: "/embed/agent-lanes",
    aliases: ["/ops/lanes/embed", "/embed/lanes", "/embed/traces"],
    profile: "macos.lanes",
  },
});

const projectsSurface = defineSurface({
  id: "projects",
  label: "Projects",
  route: { view: "agents-v2" },
  webPath: "/projects",
  screen: "ProjectsEmbedScreen",
  embed: {
    path: "/embed/projects",
    profile: "macos.projects",
  },
});

describe("embeddable surface discovery", () => {
  const { surfaces, embedByPath } = buildSurfaceRegistry({
    "../screens/broker/BrokerScreen.tsx": {
      scoutSurface: brokerSurface,
      BrokerScreen: mockScreen,
    },
    "../screens/ops/AgentLanesView.tsx": {
      scoutSurface: lanesSurface,
      AgentLanesView: mockScreen,
    },
    "../screens/projects/ProjectsScreen.tsx": {
      scoutSurface: projectsSurface,
      ProjectsEmbedScreen: mockScreen,
    },
  });

  test("discovers dispatch, lanes, and projects from screen modules", () => {
    const ids = surfaces.map((surface) => surface.id).sort();
    expect(ids).toEqual(["dispatch", "lanes", "projects"]);
    expect(surfaces.find((surface) => surface.id === "dispatch")?.webPath).toBe("/dispatch");
  });

  test("embed paths and aliases are unique", () => {
    const paths = surfaces.flatMap((surface) => surface.embedPaths);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("resolves canonical and legacy embed paths", () => {
    expect(embedByPath.get("/embed/dispatch")?.id).toBe("dispatch");
    expect(embedByPath.get("/embed/agent-lanes")?.id).toBe("lanes");
    expect(embedByPath.get("/ops/lanes/embed")?.id).toBe("lanes");
    expect(embedByPath.get("/embed/traces")?.id).toBe("lanes");
    expect(embedByPath.get("/embed/projects")?.id).toBe("projects");
  });
});

describe("lazy embeddable surface discovery", () => {
  test("loads only the screen module selected by the embed path", async () => {
    const loadedModules: string[] = [];
    const registry = buildLazySurfaceRegistry(
      {
        "../screens/broker/BrokerScreen.tsx": async () => {
          loadedModules.push("broker");
          return { scoutSurface: brokerSurface, BrokerScreen: mockScreen };
        },
        "../screens/projects/ProjectsScreen.tsx": async () => {
          loadedModules.push("projects");
          return { scoutSurface: projectsSurface, ProjectsEmbedScreen: mockScreen };
        },
      },
      [
        {
          modulePath: "../screens/broker/BrokerScreen.tsx",
          embedPaths: ["/embed/dispatch"],
        },
        {
          modulePath: "../screens/projects/ProjectsScreen.tsx",
          embedPaths: ["/embed/projects"],
        },
      ],
    );

    await expect(registry.resolve("/embed/projects")).resolves.toMatchObject({
      id: "projects",
      Screen: mockScreen,
    });
    expect(loadedModules).toEqual(["projects"]);
    await expect(registry.resolve("/embed/missing")).resolves.toBeNull();
    expect(loadedModules).toEqual(["projects"]);
  });

  test("resolves every canonical and alias path without reloading its module", async () => {
    let loads = 0;
    const registry = buildLazySurfaceRegistry(
      {
        "../screens/ops/AgentLanesView.tsx": async () => {
          loads += 1;
          return { scoutSurface: lanesSurface, AgentLanesView: mockScreen };
        },
      },
      [{
        modulePath: "../screens/ops/AgentLanesView.tsx",
        embedPaths: ["/embed/agent-lanes", "/ops/lanes/embed", "/embed/lanes", "/embed/traces"],
      }],
    );

    for (const path of ["/embed/agent-lanes", "/ops/lanes/embed", "/embed/lanes", "/embed/traces"]) {
      await expect(registry.resolve(path)).resolves.toMatchObject({ id: "lanes" });
    }
    expect(loads).toBe(1);
  });

  test("rejects a stale lazy path index", async () => {
    const registry = buildLazySurfaceRegistry(
      {
        "../screens/projects/ProjectsScreen.tsx": async () => ({
          scoutSurface: projectsSurface,
          ProjectsEmbedScreen: mockScreen,
        }),
      },
      [{
        modulePath: "../screens/projects/ProjectsScreen.tsx",
        embedPaths: ["/embed/stale-projects"],
      }],
    );

    await expect(registry.resolve("/embed/stale-projects")).rejects.toThrow(
      'Lazy embed path "/embed/stale-projects" is not declared',
    );
  });
});
