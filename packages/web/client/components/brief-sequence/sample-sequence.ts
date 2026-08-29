/**
 * Placeholder step sequence driving the Home BRIEFING panel's
 * brief-generation animation while real scoutbot-scan events aren't yet
 * wired through. The narrative is illustrative — when a live brief lands,
 * the timing/labels read as a plausible sequence of work.
 *
 * Replace with a real-event-driven sequence (or pull the animation
 * entirely) once Scoutbot emits per-phase progress on the broker.
 */

import type { BriefStep } from "./types.ts";

export const briefGenerationSequence: BriefStep[] = [
  {
    id: "fleet",
    kind: "scan",
    label: "scan fleet snapshot",
    duration: 3200,
    result: "47 agents · 8 projects",
    sample: {
      type: "fleet",
      more: 43,
      agents: [
        { id: "a1", name: "hero-codex", project: "hero", tone: "active" },
        { id: "a2", name: "hudson-claude", project: "hudson", tone: "active" },
        { id: "a3", name: "openscout", project: "openscout", tone: "active" },
        { id: "a4", name: "hkshell", project: "hkshell", tone: "idle" },
      ],
    },
  },
  {
    id: "sessions",
    kind: "collect",
    label: "read recent sessions",
    duration: 3800,
    result: "7 sessions · 6h window",
    sample: {
      type: "sessions",
      more: 4,
      sessions: [
        {
          id: "019e32c6",
          project: "openscout",
          lastActive: "16h ago",
          summary: "consolidating ops modes — Plan + Mission",
        },
        {
          id: "019e32b3",
          project: "hero",
          lastActive: "16h ago",
          summary: "reviewing broker delivery sync code paths",
        },
        {
          id: "019e32ac",
          project: "openscout",
          lastActive: "16h ago",
          summary: "GlobalJumpDock + Atop drawer fix landed",
        },
      ],
    },
  },
  {
    id: "broker",
    kind: "inspect",
    label: "inspect broker queue",
    duration: 4200,
    result: "20 msgs · 3 errors",
    countTone: "warn",
    sample: {
      type: "broker",
      more: 17,
      messages: [
        {
          from: "hudson-claude",
          to: "arach",
          body: "PR #114 ready — 30 commits consolidating ops modes",
          ago: "2h",
        },
        {
          from: "hero-codex",
          to: "openscout",
          body: "broker delivery sync failing on flight 401 — needs ack",
          ago: "4h",
          tone: "err",
        },
        {
          from: "hkshell",
          to: "arach",
          body: "tail discovery missed 12 sessions in last hour",
          ago: "6h",
          tone: "warn",
        },
      ],
    },
  },
  {
    id: "tail",
    kind: "collect",
    label: "pull tail events",
    duration: 4200,
    result: "4,891 events · 6h window",
    sample: {
      type: "tail",
      more: 4884,
      events: [
        {
          ts: "11:24:08",
          source: "claude",
          kind: "tool",
          body: "bash(\"git status\")",
        },
        {
          ts: "11:24:11",
          source: "claude",
          kind: "tool-result",
          body: "On branch ux-maximalists",
        },
        {
          ts: "11:24:14",
          source: "codex",
          kind: "assistant",
          body: "verifying tape-advance variant lands cleanly…",
        },
        {
          ts: "11:24:20",
          source: "claude",
          kind: "error",
          body: "tool failure: ENOENT openscout/packages/web/null",
        },
      ],
    },
  },
  {
    id: "plans",
    kind: "analyze",
    label: "analyze plans in motion",
    duration: 3200,
    result: "2 plans · 12 associated files",
    sample: {
      type: "plans",
      plans: [
        {
          title: "UX maximalists — Scoutbot consolidation",
          owner: "arach",
          status: "in motion",
          files: 8,
        },
        {
          title: "Broker delivery sync rewrite",
          owner: "hero-codex",
          status: "awaiting review",
          files: 4,
        },
      ],
    },
  },
  {
    id: "anomalies",
    kind: "analyze",
    label: "identify anomalies",
    duration: 3200,
    result: "1 idle · 3 errors",
    countTone: "warn",
    sample: {
      type: "anomalies",
      items: [
        {
          kind: "idle",
          label: "hkshell quiet for 6h",
          detail: "last tail event was a tool-result at 05:24",
          resource: "hkshell · /Users/arach/dev/hkshell",
          suggested: "send a wake-up ping or dismiss the agent",
        },
        {
          kind: "error",
          label: "broker delivery sync failing",
          detail: "flight 401 unacked, 3 retries exhausted",
          resource: "broker · workspace-hero",
          suggested: "open flight 401 in broker · investigate ack chain",
        },
      ],
    },
  },
  {
    id: "synthesize",
    kind: "synthesize",
    label: "synthesize observations",
    duration: 2200,
    result: "4 observations · brief ready",
    sample: { type: "synthesize", lines: 4 },
  },
];
