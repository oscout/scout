/**
 * Types shared between the web and mobile DB query surfaces.
 *
 * Web-specific shapes live in `./web.ts`, mobile-specific shapes in
 * `./mobile.ts`. Internal-only SQL helper types stay in
 * `../internal/sql-helpers.ts`.
 */

export type HeartrateBucket = { ts: number; count: number; value: number };

/** Attention level a work item carries — drives UI badges and alerts. */
export type WorkAttention = "silent" | "badge" | "interrupt";

/** High-level rollup of an agent's runtime state for list/detail surfaces. */
export type AgentSummaryState = "offline" | "available" | "in_flight" | "working";
