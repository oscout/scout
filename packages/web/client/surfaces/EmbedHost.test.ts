import { describe, expect, test } from "bun:test";
import type { Route } from "../lib/types.ts";
import { routeEmbeddedNavigation } from "./embed-navigation.ts";

describe("embedded navigation ownership", () => {
  const destination: Route = {
    view: "sessions",
    flightId: "flight-1",
  };

  test("hands product navigation to the native host", () => {
    const localRoutes: Route[] = [];
    const nativeActions: unknown[] = [];

    routeEmbeddedNavigation(
      destination,
      (route) => localRoutes.push(route),
      (action) => {
        nativeActions.push(action);
        return true;
      },
    );

    expect(nativeActions).toEqual([{ type: "navigate", route: destination }]);
    expect(localRoutes).toEqual([]);
  });

  test("uses the local router in the standalone web app", () => {
    const localRoutes: Route[] = [];

    routeEmbeddedNavigation(
      destination,
      (route) => localRoutes.push(route),
      () => false,
    );

    expect(localRoutes).toEqual([destination]);
  });

  test("keeps routes owned by the embedded surface in its local router", () => {
    const projectProfile: Route = { view: "agents-v2", agentId: "agent-1" };
    const localRoutes: Route[] = [];
    const nativeActions: unknown[] = [];

    routeEmbeddedNavigation(
      projectProfile,
      (route) => localRoutes.push(route),
      (action) => {
        nativeActions.push(action);
        return true;
      },
      (route) => route.view === "agents-v2",
    );

    expect(localRoutes).toEqual([projectProfile]);
    expect(nativeActions).toEqual([]);
  });
});
