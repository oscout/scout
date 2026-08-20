/**
 * Exhaustive sidebar context resolver (SCO-083).
 *
 * Unlike resolveLeftPane, there is NO HomeLeft fallback. Every view maps to
 * an intentional context component or null so "Recent agents/activity" never
 * masquerades as contextual navigation for unrelated areas.
 */
import type { ReactNode } from "react";
import type { Route } from "../lib/types.ts";
import type { useScout } from "../scout/Provider.tsx";
import { AgentsLeft } from "./agents/index.ts";
import { ProjectsRail } from "./projects/index.ts";
import { ChatLeft } from "./chat/index.ts";
import { HomeLeft } from "./home/index.ts";
import { MeshLeft } from "./mesh/index.ts";
import { MeshOpsLeft } from "./mesh-ops/index.ts";
import { OpsLeft } from "./ops/index.ts";
import { TerminalLeft } from "./terminal/index.ts";
import { MeshCanvasMinimap } from "../scout/slots/MeshCanvasMinimap.tsx";

type Navigate = ReturnType<typeof useScout>["navigate"];

export type SidebarContextResult = {
  /** Scrollable context body (or null when the area has no context). */
  body: ReactNode;
  /** Optional pinned footer inside the context region (e.g. Mesh rack/map). */
  footer: ReactNode;
};

/**
 * Resolve per-area sidebar context for the current route.
 * Exhaustive on Route["view"] — intentional null is allowed.
 */
export function resolveSidebarContext(
  route: Route,
  navigate: Navigate,
): SidebarContextResult {
  switch (route.view) {
    // ── Home area: intentional HomeLeft (not a fallback) ───────────────
    case "inbox":
    case "activity":
    case "briefings":
      return { body: <HomeLeft />, footer: null };

    // ── Projects ───────────────────────────────────────────────────────
    case "agents-v2":
      return {
        body: <ProjectsRail route={route} navigate={navigate} />,
        footer: null,
      };
    case "agent-info":
      return { body: <AgentsLeft />, footer: null };
    case "repos":
    case "repo-diff":
    case "code":
      // No custom context yet; Projects area destination rail is enough.
      return { body: null, footer: null };

    // ── Sessions ───────────────────────────────────────────────────────
    case "sessions":
      return { body: null, footer: null };
    case "terminal":
      return { body: <TerminalLeft />, footer: null };

    // ── Chat ───────────────────────────────────────────────────────────
    case "messages":
    case "conversation":
      return { body: <ChatLeft />, footer: null };

    // ── Dispatch ───────────────────────────────────────────────────────
    case "broker":
    case "work":
    case "follow":
      return { body: null, footer: null };

    // ── Search ─────────────────────────────────────────────────────────
    case "search":
      return { body: null, footer: null };

    // ── Ops ────────────────────────────────────────────────────────────
    case "ops":
      return { body: <OpsLeft />, footer: null };
    case "mesh":
      // Mesh rack/map preserved from GlobalJumpDock before jump-dock deletion.
      return { body: <MeshLeft />, footer: <MeshCanvasMinimap /> };
    case "mesh-ops":
      return { body: <MeshOpsLeft />, footer: null };
    case "harnesses":
      return { body: null, footer: null };

    // ── Settings ───────────────────────────────────────────────────────
    case "settings":
    case "voice":
      return { body: null, footer: null };

    default: {
      // Exhaustiveness guard — TypeScript errors if a view is missing above.
      const _exhaustive: never = route;
      void _exhaustive;
      return { body: null, footer: null };
    }
  }
}
