import type { SecondaryNavGroup } from "../components/SecondaryNav.tsx";
import {
  projectAgentsSecondaryNav,
  projectOpsSecondaryNav,
} from "./nav-destinations.ts";

// Agents is a top-level tab (Projects); its only remaining sub-page is the
// configuration surface. Directory (.deprecated) and Sessions left the subnav —
// the route stays alive, the nav entry does not. SCO-083 moves agent config into
// the Settings area; this strip remains until Settings Dialog conversion lands.
export const AGENTS_SECONDARY_NAV: SecondaryNavGroup[] = projectAgentsSecondaryNav();

/**
 * Ops secondary strip — Ops-area destinations only (SCO-083).
 * Dispatch/Repos/Code removed; those screens no longer render OpsSubnav.
 */
export const OPS_SECONDARY_NAV: SecondaryNavGroup[] = projectOpsSecondaryNav();
