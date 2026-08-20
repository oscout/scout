/**
 * What the Mission Control rail says a session is doing right now.
 *
 * The rail leans on the shared lane preview (`agent-lane-preview.ts`), but a
 * rail is narrower than a lane card and two of the preview's habits read badly
 * at that width: a tool-only turn degrades its headline to a bare `[assistant]`
 * marker, and its detail is usually the headline again at a longer clip. Both
 * corrections are pure, and live here rather than in the view.
 */
import { splitCdPrefix, tildeShortenPath } from "../../lib/bash-format.ts";
import type { ObserveData } from "../../lib/types.ts";
import type { AgentLanePreviewModel } from "./agent-lane-preview.ts";

/** A turn marker the tail emits in place of text — `[assistant]`, `[system]`.
 *  It names the speaker, not the action, so it is not worth a headline. */
const TURN_MARKER = /^\[[a-z][a-z-]*\]$/i;

export type MissionRailNow = {
  headline: string;
  /** The untruncated headline, for the hover title. */
  full: string;
  detail: string | null;
};

/**
 * The headline and the detail are cut from the same event text at different
 * lengths, so neither string strictly contains the other — compare on the stem
 * up to the shorter clip. One line printed twice is not a second fact.
 */
export function echoesHeadline(headline: string, detail: string): boolean {
  const strip = (value: string) => value.replace(/[…\s]+$/u, "");
  const head = strip(headline);
  const body = strip(detail);
  if (!head) return true;
  const stem = head.slice(0, Math.min(head.length, body.length));
  return body.startsWith(stem) || head.startsWith(body);
}

export function missionRailNow(
  preview: AgentLanePreviewModel | null,
  observe: ObserveData | null,
): MissionRailNow | null {
  const headline = preview?.headline.trim();
  if (headline && !TURN_MARKER.test(headline)) {
    const detail = preview?.detail?.trim();
    const full = preview?.headFull ?? headline;
    if (detail && echoesHeadline(headline, detail)) {
      // The same sentence at two clip lengths — keep the longer cut, once.
      const line = detail.length > headline.length ? detail : headline;
      return { headline: line, full, detail: null };
    }
    return { headline, full, detail: detail ?? null };
  }

  // A turn marker says who spoke, not what happened. The last tool call does.
  const lastTool = [...(observe?.events ?? [])].reverse().find((event) => event.kind === "tool");
  if (lastTool) {
    const arg = lastTool.arg
      ? splitCdPrefix(tildeShortenPath(lastTool.arg)).rest || lastTool.arg
      : null;
    const line = [lastTool.tool, arg].filter(Boolean).join(" · ").trim() || "Running tool";
    return { headline: line, full: line, detail: null };
  }

  return headline ? { headline, full: preview?.headFull ?? headline, detail: null } : null;
}
