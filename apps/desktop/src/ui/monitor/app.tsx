/** @jsxImportSource @opentui/react */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextareaOptions, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  SCOUT_RESERVED_RUNTIME_PROFILE_IDS,
  normalizeReservedRuntimeProfileId,
} from "@openscout/protocol";
import { resolveOperatorName } from "@openscout/runtime/user-config";
import { stripVTControlCharacters } from "node:util";

import {
  type ScoutMonitorActivity,
  type ScoutMonitorAgent,
  type ScoutMonitorSnapshot,
  SCOUT_MONITOR_ASSISTANT_ID,
  loadScoutMonitorHarness,
  loadScoutMonitorRuntimes,
  loadScoutMonitorSnapshot,
  sendScoutMonitorAssistantMessage,
} from "../../core/monitor/service.ts";
import type { ScoutBrokerMessageRecord } from "../../core/broker/service.ts";
import { resolveScoutBrokerUrl, scoutConversationIdForChannel } from "../../core/broker/service.ts";
import { scoutBrokerPaths } from "../../core/broker/paths.ts";
import { normalizeUnixTimestamp } from "../../core/broker/view.ts";
import { scoutAskHandler } from "../../core/broker/ask.ts";
import {
  resolveHumanAskSenderName,
  resolveScoutSenderId,
} from "../../core/broker/sender.ts";
import {
  clampScoutTuiSelection,
  filterScoutTuiCommands,
  findScoutHarnessCommandDefinition,
  findScoutHarnessAgent,
  moveScoutTuiSelection,
  parseScoutHarnessCommand,
  parseScoutHarnessRuntime,
  SCOUT_HARNESS_COMMANDS,
  type ScoutHarnessCommandDefinition,
  type ScoutTuiCommand,
} from "./model.ts";

export type ScoutMonitorAppProps = {
  currentDirectory: string;
  channel?: string;
  limit: number;
  refreshIntervalMs: number;
  onQuit: () => void;
};

type MonitorTab = "home" | "harness" | "tail" | "new";
type MonitorOverlay = "palette" | "ask" | null;
type HarnessView = "conversation" | "help" | "profiles" | "runtimes" | "agents" | "status";

const C = {
  accent: "#34d399",
  bg: "#09090b",
  border: "#28282c",
  borderStrong: "#44444c",
  dim: "#6b7280",
  muted: "#9ca3af",
  red: "#f87171",
  selected: "#14231d",
  surface: "#111114",
  text: "#e5e7eb",
  yellow: "#fbbf24",
};

const MONITOR_TABS: MonitorTab[] = ["home", "harness", "tail", "new"];
const operatorName = resolveOperatorName();

function monitorTabLabel(tab: MonitorTab): string {
  return tab === "home" ? "fleet" : tab;
}

type AgentRow = {
  key: string;
  title: string;
  meta: string;
  project: string;
  runtime: string;
  status: string;
  age: string;
  state: ScoutMonitorAgent["state"];
  timestamp: number | null;
};

type HarnessLocalEntry = {
  id: string;
  actor: string;
  body: string;
  color: string;
  createdAt: number;
};

type ComposerDraft = {
  current: string;
};

const MESSAGE_COMPOSER_KEY_BINDINGS: NonNullable<TextareaOptions["keyBindings"]> = [
  { name: "return", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "linefeed", meta: true, action: "newline" },
];

const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/g;

function cleanText(value: string): string {
  return stripVTControlCharacters(value).replace(CONTROL_PATTERN, "").trim();
}

function composerLineCount(value: string): number {
  return value.length === 0 ? 1 : value.split("\n").length;
}

const MessageComposer = React.memo(function MessageComposer({
  draft,
  prefix,
  placeholder,
  sending,
  disabled = false,
  active = true,
  error,
  width,
  submitLabel,
  idleHint,
  onSubmit,
}: {
  draft: ComposerDraft;
  prefix: string;
  placeholder: string;
  sending: boolean;
  disabled?: boolean;
  active?: boolean;
  error: string | null;
  width: number;
  submitLabel: string;
  idleHint: string;
  onSubmit: (value: string) => boolean | Promise<boolean>;
}) {
  const editor = useRef<TextareaRenderable>(null);
  const submitting = useRef(false);
  const [lineCount, setLineCount] = useState(() => composerLineCount(draft.current));
  const lineCountRef = useRef(lineCount);
  const ready = active && !sending && !disabled;

  useEffect(() => {
    editor.current?.gotoBufferEnd();
  }, []);

  const syncDraft = useCallback(() => {
    const value = editor.current?.plainText ?? draft.current;
    draft.current = value;
    const nextLineCount = editor.current?.lineCount ?? composerLineCount(value);
    if (lineCountRef.current !== nextLineCount) {
      lineCountRef.current = nextLineCount;
      setLineCount(nextLineCount);
    }
    return value;
  }, [draft]);

  const submit = useCallback(async () => {
    if (!ready || submitting.current) return;
    const value = syncDraft();
    if (!value.trim()) return;

    submitting.current = true;
    try {
      if (await onSubmit(value)) {
        draft.current = "";
        editor.current?.clear();
        lineCountRef.current = 1;
        setLineCount(1);
      }
    } finally {
      submitting.current = false;
    }
  }, [draft, onSubmit, ready, syncDraft]);

  const shortcut = width >= 64
    ? `${lineCount > 1 ? `${lineCount} lines` : "single line"}  ·  ⇧/⌥↵ newline  ·  ↵ ${submitLabel}`
    : `⇧/⌥↵ newline  ·  ↵ ${submitLabel}`;
  const status = error ?? (sending ? "Dispatching through Scout…" : idleHint);

  return (
    <>
      <box
        height={5}
        flexDirection="row"
        border
        borderStyle="single"
        borderColor={error ? C.red : sending ? C.yellow : ready ? C.accent : C.borderStrong}
        backgroundColor={C.bg}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={sending ? C.yellow : ready ? C.accent : C.dim}>{sending ? "… " : prefix}</text>
        <textarea
          ref={editor}
          width={Math.max(10, width - prefix.length - 4)}
          height={3}
          initialValue={draft.current}
          placeholder={sending ? "Dispatching through Scout…" : placeholder}
          placeholderColor={C.dim}
          textColor={C.text}
          focusedTextColor={C.text}
          backgroundColor={C.bg}
          focusedBackgroundColor={C.bg}
          cursorColor={C.accent}
          cursorStyle={{ style: "line", blinking: true }}
          wrapMode="word"
          scrollMargin={1}
          keyBindings={MESSAGE_COMPOSER_KEY_BINDINGS}
          focused={ready}
          onContentChange={syncDraft}
          onSubmit={() => void submit()}
        />
      </box>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={error ? C.red : C.dim}>
          {truncate(status, Math.max(10, width - shortcut.length - 2))}
        </text>
        <text fg={ready ? C.accent : C.dim}>{shortcut}</text>
      </box>
    </>
  );
});

function sourceText(value: string | null | undefined): string {
  return cleanText(value ?? "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function displayName(actorId: string | null | undefined): string {
  const trimmed = actorId?.trim();
  if (!trimmed) return "unknown";
  if (trimmed === "operator") return operatorName;
  return cleanText(trimmed.split(".")[0] || trimmed);
}

function normalizeTimestamp(value: unknown): number | null {
  return normalizeUnixTimestamp(value);
}

function formatClock(value: unknown): string {
  const timestamp = normalizeTimestamp(value);
  if (timestamp === null) return "--:--:--";
  const date = new Date(timestamp * 1000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((entry) => String(entry).padStart(2, "0"))
    .join(":");
}

function formatRelative(value: unknown): string {
  const timestamp = normalizeTimestamp(value);
  if (timestamp === null) return "not seen";
  const age = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (age < 60) return `${age}s ago`;
  if (age < 3_600) return `${Math.floor(age / 60)}m ago`;
  if (age < 86_400) return `${Math.floor(age / 3_600)}h ago`;
  return `${Math.floor(age / 86_400)}d ago`;
}

function truncate(value: string, width: number): string {
  const clean = cleanText(value);
  if (width <= 0) return "";
  if (clean.length <= width) return clean;
  if (width === 1) return clean.slice(0, 1);
  return `${clean.slice(0, width - 1)}…`;
}

function fitLine(value: string, width: number): string {
  const fitted = truncate(value, width);
  return fitted.padEnd(Math.max(0, width), " ");
}

function wrapText(value: string, width: number): string[] {
  if (width <= 0) return [];
  const normalized = cleanText(value).replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of normalized.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word.length > width ? truncate(word, width) : word;
  }
  if (current) lines.push(current);
  return lines;
}

function compactPath(value: string | null): string | null {
  if (!value) return null;
  const clean = cleanText(value);
  const home = process.env.HOME;
  if (home && clean.startsWith(home)) {
    return `~${clean.slice(home.length)}`;
  }
  return clean;
}

function projectLabel(value: string | null): string {
  const compact = compactPath(value);
  if (!compact) return "unknown";
  if (compact === "~") return "home";
  const parts = compact.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? compact;
  return last === "~" ? "home" : last;
}

function runtimeLabel(value: string | null): string {
  const parts = cleanText(value ?? "")
    .split("·")
    .map((part) => sourceText(part))
    .filter(Boolean)
    .map((part) => part
      .replace(/claude_stream_json/g, "stream")
      .replace(/codex_app_server/g, "app")
      .replace(/claude_channel/g, "channel")
      .replace(/pi_rpc/g, "rpc"));
  return parts.length > 0 ? parts.join("/") : "unknown";
}

function stateRank(state: ScoutMonitorAgent["state"]): number {
  switch (state) {
    case "working":
      return 0;
    case "available":
      return 1;
    case "offline":
    default:
      return 2;
  }
}

function statusRank(status: string, state: ScoutMonitorAgent["state"]): number {
  const clean = status.toLowerCase();
  if (state === "offline" || clean.includes("offline")) return 4;
  if (clean.includes("waiting") || clean.includes("blocked") || clean.includes("approval")) return 0;
  if (state === "working" || clean.includes("working") || clean.includes("running")) return 1;
  if (state === "available" || clean.includes("available")) return 2;
  return 3;
}

function stateColor(state: ScoutMonitorAgent["state"]): string {
  switch (state) {
    case "working":
      return C.accent;
    case "available":
      return C.muted;
    case "offline":
    default:
      return C.dim;
  }
}

function agentTone(row: AgentRow): string {
  const status = row.status.toLowerCase();
  if (row.state === "offline" || status.includes("offline")) return C.dim;
  if (status.includes("waiting") || status.includes("blocked") || status.includes("approval")) return C.yellow;
  if (row.state === "working" || status.includes("working") || status.includes("running")) return C.accent;
  if (row.state === "available" || status.includes("available")) return C.muted;
  return C.text;
}

function statusSummary(agents: ScoutMonitorAgent[]): string {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const label = sourceText(agent.statusLabel || agent.state).toLowerCase() || agent.state;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
}

function buildAgentRows(agents: ScoutMonitorAgent[]): AgentRow[] {
  return agents
    .map((agent) => {
      const timestamp = normalizeTimestamp(agent.lastSeenAt);
      const project = compactPath(agent.projectRoot);
      const status = sourceText(agent.statusLabel) || agent.state;
      const meta = [
        agent.role,
        project,
        agent.statusDetail,
      ].filter((item): item is string => Boolean(item && item.trim())).join(" · ");

      return {
        key: agent.id,
        title: agent.title || displayName(agent.id),
        meta: meta || agent.summary || agent.id,
        project: projectLabel(agent.projectRoot),
        runtime: runtimeLabel(agent.statusDetail),
        status,
        age: timestamp === null ? "not seen" : formatRelative(timestamp),
        state: agent.state,
        timestamp,
      };
    })
    .sort((left, right) => (
      statusRank(left.status, left.state) - statusRank(right.status, right.state)
      || stateRank(left.state) - stateRank(right.state)
      || (right.timestamp ?? 0) - (left.timestamp ?? 0)
      || left.title.localeCompare(right.title)
    ));
}

function messageTone(message: ScoutBrokerMessageRecord): string {
  if (message.actorId === "operator") return C.accent;
  if (message.class === "status") return C.yellow;
  if (message.class === "system") return C.dim;
  return C.text;
}

function activityTone(item: ScoutMonitorActivity): string {
  if (item.kind === "system") return C.yellow;
  return C.text;
}

function Header({
  snapshot,
  loading,
  tab,
  width,
}: {
  snapshot: ScoutMonitorSnapshot | null;
  loading: boolean;
  tab: MonitorTab;
  width: number;
}) {
  const counts = snapshot?.brokerHealth.counts;
  const online = snapshot?.brokerHealth.ok === true;
  const status = snapshot ? (online ? "online" : "offline") : "starting";

  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} paddingTop={1} height={3}>
      <box flexDirection="row" gap={1}>
        <text fg={online ? C.accent : C.yellow}>◆</text>
        <text fg={C.text}>SCOUT</text>
        <text fg={C.dim}>control</text>
        <text fg={C.dim}>|</text>
        {MONITOR_TABS.map((entry) => (
          <text key={entry} fg={entry === tab ? C.text : C.dim}>
            {entry === tab
              ? `[${monitorTabLabel(entry)}]`
              : ` ${monitorTabLabel(entry)} `}
          </text>
        ))}
        <text fg={online ? C.accent : C.yellow}>{loading ? "refreshing" : status}</text>
      </box>
      <box flexDirection="row" gap={2}>
        {counts && width >= 96 ? <text fg={C.dim}>{counts.agents} agents</text> : null}
        {counts && width >= 112 ? <text fg={C.dim}>{counts.messages} msgs</text> : null}
        <text fg={C.dim}>{snapshot ? formatClock(snapshot.refreshedAt) : "--:--:--"}</text>
      </box>
    </box>
  );
}

function AgentListPanel({
  agents,
  selectedIndex,
  onSelect,
  width,
  height,
}: {
  agents: ScoutMonitorAgent[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  width: number;
  height: number;
}) {
  const rows = buildAgentRows(agents);
  const tableMode = width >= 76;
  const lineWidth = Math.max(18, width - 4);
  const statusWidth = tableMode ? Math.min(12, Math.max(8, Math.floor(lineWidth * 0.16))) : 0;
  const projectWidth = tableMode ? Math.min(22, Math.max(10, Math.floor(lineWidth * 0.22))) : 0;
  const runtimeWidth = tableMode ? Math.min(18, Math.max(9, Math.floor(lineWidth * 0.18))) : 0;
  const nameWidth = tableMode
    ? Math.max(16, lineWidth - statusWidth - projectWidth - runtimeWidth - 8)
    : lineWidth;
  const visibleCount = tableMode
    ? Math.max(1, Math.min(rows.length, height - 5))
    : Math.max(1, Math.min(rows.length, Math.floor(Math.max(2, height - 3) / 2)));
  const windowStart = Math.min(
    Math.max(0, rows.length - visibleCount),
    Math.max(0, selectedIndex - visibleCount + 1),
  );
  const visible = rows.slice(windowStart, windowStart + visibleCount);
  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, rows.length - windowStart - visible.length);

  return (
    <box flexDirection="column" width={width} height={height} border borderStyle="rounded" borderColor={C.border} padding={1} title={`Fleet · ${rows.length} shown${rows.length > 0 ? ` · ${statusSummary(agents)}` : ""}`}>
      {visible.length === 0 ? (
        <box flexDirection="column">
          <text fg={C.dim}>{fitLine("No active agents in broker home.", lineWidth)}</text>
          <text fg={C.dim}>{fitLine("scout up . --harness claude", lineWidth)}</text>
        </box>
      ) : tableMode ? (
        <>
          <box height={1}>
            <text fg={C.dim}>
              {fitLine(`  ${fitLine("agent", nameWidth)} ${fitLine("status", statusWidth)} ${fitLine("project", projectWidth)} ${fitLine("runtime", runtimeWidth)}`, lineWidth)}
            </text>
          </box>
          {visible.map((row, index) => {
            const rowIndex = windowStart + index;
            return (
            <box
              key={row.key}
              height={1}
              backgroundColor={rowIndex === selectedIndex ? C.selected : C.surface}
              onMouseDown={() => onSelect(rowIndex)}
            >
              <text fg={agentTone(row)}>
                {fitLine(`${rowIndex === selectedIndex ? "›" : " "}${row.state === "offline" ? "○" : "●"} ${fitLine(row.title, nameWidth - 1)} ${fitLine(row.status, statusWidth)} ${fitLine(row.project, projectWidth)} ${fitLine(row.runtime, runtimeWidth)}`, lineWidth)}
              </text>
            </box>
            );
          })}
          {hiddenAbove > 0 || hiddenBelow > 0 ? (
            <box height={1}>
              <text fg={C.dim}>{fitLine(`${hiddenAbove} above · ${hiddenBelow} below`, lineWidth)}</text>
            </box>
          ) : null}
        </>
      ) : (
        visible.map((row, index) => {
          const rowIndex = windowStart + index;
          return (
          <box
            key={row.key}
            flexDirection="column"
            height={2}
            backgroundColor={rowIndex === selectedIndex ? C.selected : C.surface}
            onMouseDown={() => onSelect(rowIndex)}
          >
            <text fg={stateColor(row.state)}>
              {fitLine(`${rowIndex === selectedIndex ? "›" : " "}${row.state === "offline" ? "○" : "●"} ${row.title} · ${row.status} · ${row.age}`, lineWidth)}
            </text>
            <text fg={C.dim}>{fitLine(row.meta, lineWidth)}</text>
          </box>
          );
        })
      )}
    </box>
  );
}

type NewCommandTarget =
  | {
      key: "scoutbot";
      kind: "scoutbot";
      label: string;
      detail: string;
    }
  | {
      key: `profile:${string}`;
      kind: "profile";
      profile: string;
      label: string;
      detail: string;
    }
  | {
      key: `agent:${string}`;
      kind: "agent";
      agentId: string;
      label: string;
      detail: string;
    };

function NewCommandPanel({
  snapshot,
  targets,
  selectedIndex,
  choosingTarget,
  draft,
  active,
  sending,
  error,
  width,
  height,
  onSelect,
  onChooseTarget,
  onSubmit,
}: {
  snapshot: ScoutMonitorSnapshot;
  targets: NewCommandTarget[];
  selectedIndex: number;
  choosingTarget: boolean;
  draft: ComposerDraft;
  active: boolean;
  sending: boolean;
  error: string | null;
  width: number;
  height: number;
  onSelect: (index: number) => void;
  onChooseTarget: () => void;
  onSubmit: (value: string) => Promise<boolean>;
}) {
  const brokerOk = snapshot.brokerHealth.ok;
  const lineWidth = Math.max(24, width - 4);
  const target = targets[clampScoutTuiSelection(selectedIndex, targets.length)] ?? targets[0];
  const availableRows = Math.max(1, height - 7);
  const windowStart = Math.min(
    Math.max(0, targets.length - availableRows),
    Math.max(0, selectedIndex - availableRows + 1),
  );
  const visibleTargets = targets.slice(windowStart, windowStart + availableRows);

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={error ? C.red : brokerOk ? C.borderStrong : C.red}
      backgroundColor={C.surface}
      padding={1}
      title={choosingTarget ? "New command · Choose target" : "New command"}
    >
      {!brokerOk ? (
        <box height={1}>
          <text fg={C.red}>{fitLine("Broker offline · run scout doctor before dispatching", lineWidth)}</text>
        </box>
      ) : choosingTarget ? (
        <>
          <box height={1}>
            <text fg={C.dim}>{fitLine("Choose the identity or fresh runtime that should own this command.", lineWidth)}</text>
          </box>
          <box height={1}><text fg={C.dim}>{fitLine("", lineWidth)}</text></box>
          {visibleTargets.map((entry, index) => {
            const entryIndex = windowStart + index;
            const selected = entryIndex === selectedIndex;
            return (
              <box
                key={entry.key}
                height={1}
                backgroundColor={selected ? C.selected : C.surface}
                onMouseDown={() => {
                  onSelect(entryIndex);
                  onChooseTarget();
                }}
              >
                <text fg={selected ? C.accent : C.text}>
                  {fitLine(`${selected ? "›" : " "} ${entry.label}  ·  ${entry.detail}`, lineWidth)}
                </text>
              </box>
            );
          })}
          <box flexGrow={1} />
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={C.accent}>↑↓ choose · enter write command</text>
            <text fg={C.dim}>{targets.length === 0 ? "0 targets" : `${selectedIndex + 1} / ${targets.length}`}</text>
          </box>
        </>
      ) : (
        <>
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={C.accent}>{truncate(`TARGET  ${target?.label ?? "Unavailable"}`, Math.max(18, Math.floor(lineWidth * 0.55)))}</text>
            <text fg={C.dim}>^t change target</text>
          </box>
          <box height={1}>
            <text fg={C.dim}>{fitLine(target?.detail ?? "No dispatch target is available.", lineWidth)}</text>
          </box>
          <box height={1}>
            <text fg={C.dim}>{fitLine(`PROJECT  ${compactPath(snapshot.currentDirectory) ?? snapshot.currentDirectory}`, lineWidth)}</text>
          </box>
          <box flexGrow={1} />
          <MessageComposer
            draft={draft}
            prefix="run› "
            placeholder="Describe the work to run"
            sending={sending}
            disabled={!brokerOk}
            active={active}
            error={error}
            width={lineWidth}
            submitLabel="run"
            idleHint="Dispatch opens the broker conversation; the draft survives errors and navigation."
            onSubmit={onSubmit}
          />
        </>
      )}
    </box>
  );
}

function AgentDetailPanel({
  agent,
  activity,
  width,
  height,
}: {
  agent: ScoutMonitorAgent | null;
  activity: ScoutMonitorActivity[];
  width: number;
  height: number;
}) {
  const lineWidth = Math.max(24, width - 4);
  if (!agent) {
    return (
      <box flexDirection="column" width={width} height={height} border borderStyle="rounded" borderColor={C.border} padding={1} title="Agent signal">
        <text fg={C.dim}>{fitLine("Select an agent to inspect its live broker signal.", lineWidth)}</text>
      </box>
    );
  }

  const status = sourceText(agent.statusLabel || agent.state);
  const needsAttention = /waiting|blocked|approval|permission/i.test(status);
  const compact = height <= 10;
  const relatedActivity = activity
    .filter((item) => item.actorId === agent.id || item.actorName === agent.title)
    .slice(0, Math.max(0, height - 12));
  const detailLines = [
    ["STATE", status],
    ["PROJECT", compactPath(agent.projectRoot) ?? "unknown"],
    ["ROLE", sourceText(agent.role) || "unassigned"],
    ["LAST SIGNAL", formatRelative(agent.lastSeenAt)],
  ] as const;

  if (compact) {
    return (
      <box
        flexDirection="column"
        width={width}
        height={height}
        border
        borderStyle="rounded"
        borderColor={needsAttention ? C.yellow : C.borderStrong}
        backgroundColor={C.surface}
        paddingLeft={1}
        paddingRight={1}
        title={needsAttention ? "Attention required" : "Agent signal"}
      >
        <box height={1}>
          <text fg={needsAttention ? C.yellow : stateColor(agent.state)}>
            {fitLine(`${agent.reachable ? "●" : "○"} ${agent.title} · ${status}`, lineWidth)}
          </text>
        </box>
        <box height={1}>
          <text fg={C.dim}>
            {fitLine(`${compactPath(agent.projectRoot) ?? "unknown project"} · ${formatRelative(agent.lastSeenAt)}`, lineWidth)}
          </text>
        </box>
        {height >= 7 ? (
          <box height={1}>
            <text fg={agent.activeTask ? C.text : C.dim}>
              {fitLine(agent.activeTask ? `Now · ${sourceText(agent.activeTask)}` : sourceText(agent.summary) || "No active task reported", lineWidth)}
            </text>
          </box>
        ) : null}
        <box flexGrow={1} />
        <box height={1}>
          <text fg={agent.state === "offline" ? C.dim : C.accent}>
            {fitLine(agent.state === "offline" ? "a  ask (queues until routable)" : "a / enter  ask this agent", lineWidth)}
          </text>
        </box>
      </box>
    );
  }

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={needsAttention ? C.yellow : C.borderStrong}
      backgroundColor={C.surface}
      padding={1}
      title={needsAttention ? "Attention required" : "Agent signal"}
    >
      <box height={1}>
        <text fg={needsAttention ? C.yellow : stateColor(agent.state)}>
          {fitLine(`${agent.reachable ? "●" : "○"} ${agent.title}`, lineWidth)}
        </text>
      </box>
      {agent.summary ? (
        <box height={1}>
          <text fg={C.muted}>{fitLine(sourceText(agent.summary), lineWidth)}</text>
        </box>
      ) : null}
      <box height={1}><text fg={C.dim}>{fitLine("", lineWidth)}</text></box>
      {detailLines.map(([label, value]) => (
        <box key={label} height={1}>
          <text fg={C.dim}>{fitLine(`${label.padEnd(12, " ")} ${value}`, lineWidth)}</text>
        </box>
      ))}
      <box height={1}><text fg={C.dim}>{fitLine("", lineWidth)}</text></box>
      <box height={1}>
        <text fg={agent.activeTask ? C.text : C.dim}>
          {fitLine(agent.activeTask ? `NOW  ${sourceText(agent.activeTask)}` : "NOW  No active task reported", lineWidth)}
        </text>
      </box>
      {relatedActivity.length > 0 ? (
        <>
          <box height={1}><text fg={C.dim}>{fitLine("RECENT SIGNAL", lineWidth)}</text></box>
          {relatedActivity.map((item) => (
            <box key={item.id} height={1}>
              <text fg={C.muted}>
                {fitLine(`${formatClock(item.timestamp)}  ${sourceText(item.title || item.detail)}`, lineWidth)}
              </text>
            </box>
          ))}
        </>
      ) : null}
      <box flexGrow={1} />
      <box height={1}>
        <text fg={agent.state === "offline" ? C.dim : C.accent}>
          {fitLine(agent.state === "offline" ? "a  ask (queues until routable)" : "a / enter  ask this agent", lineWidth)}
        </text>
      </box>
    </box>
  );
}

function HomeSummaryStrip({
  snapshot,
  width,
}: {
  snapshot: ScoutMonitorSnapshot;
  width: number;
}) {
  const counts = snapshot.brokerHealth.counts;
  const parts = [
    snapshot.brokerHealth.ok ? "broker online" : "broker offline",
    `${snapshot.agents.length} shown`,
    statusSummary(snapshot.agents),
    `${snapshot.activity.length} recent`,
    counts ? `${counts.messages} msgs` : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <box
      width={width}
      height={3}
      border
      borderStyle="rounded"
      borderColor={snapshot.brokerHealth.ok ? C.border : C.red}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={snapshot.brokerHealth.ok ? C.accent : C.red}>
        {fitLine(parts.join("  ·  "), Math.max(24, width - 4))}
      </text>
    </box>
  );
}

function HomePanel({
  snapshot,
  selectedIndex,
  onSelect,
  width,
  height,
}: {
  snapshot: ScoutMonitorSnapshot;
  selectedIndex: number;
  onSelect: (index: number) => void;
  width: number;
  height: number;
}) {
  const contentHeight = Math.max(10, height - 5);
  const summaryHeight = 3;
  const bodyHeight = Math.max(6, contentHeight - summaryHeight - 1);
  const wide = width >= 112;
  const detailHeight = wide ? bodyHeight : Math.max(4, Math.floor(bodyHeight * 0.46));
  const agentsHeight = wide ? bodyHeight : Math.max(3, bodyHeight - detailHeight - 1);
  const agentWidth = wide ? Math.max(56, Math.floor(width * 0.58)) : Math.max(32, width - 2);
  const sideWidth = wide ? Math.max(36, width - agentWidth - 5) : Math.max(32, width - 2);
  const fullWidth = Math.max(32, width - 2);
  const selectedRow = buildAgentRows(snapshot.agents)[selectedIndex];
  const selectedAgent = selectedRow
    ? snapshot.agents.find((agent) => agent.id === selectedRow.key) ?? null
    : null;

  return (
    <box flexDirection="column" flexGrow={1} gap={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
      <HomeSummaryStrip snapshot={snapshot} width={fullWidth} />
      {wide ? (
        <box flexDirection="row" height={bodyHeight} gap={1}>
          <AgentListPanel agents={snapshot.agents} selectedIndex={selectedIndex} onSelect={onSelect} width={agentWidth} height={agentsHeight} />
          <AgentDetailPanel agent={selectedAgent} activity={snapshot.activity} width={sideWidth} height={detailHeight} />
        </box>
      ) : (
        <box flexDirection="column" height={bodyHeight} gap={1}>
          <AgentListPanel agents={snapshot.agents} selectedIndex={selectedIndex} onSelect={onSelect} width={agentWidth} height={agentsHeight} />
          <AgentDetailPanel agent={selectedAgent} activity={snapshot.activity} width={sideWidth} height={detailHeight} />
        </box>
      )}
    </box>
  );
}

type TailLine = {
  key: string;
  timestamp: number;
  color: string;
  text: string;
  selected?: boolean;
};

type TailContextField = {
  label: string;
  value: string;
};

type TailEntry = {
  key: string;
  timestamp: number;
  color: string;
  kind: string;
  actor: string;
  headline: string;
  body: string;
  context: TailContextField[];
};

function formatContextValue(value: unknown): string {
  if (typeof value === "string") return sourceText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return sourceText(JSON.stringify(value));
  } catch {
    return sourceText(String(value));
  }
}

function formatDateTime(value: unknown): string {
  const timestamp = normalizeTimestamp(value);
  if (timestamp === null) return "unknown";
  return new Date(timestamp * 1000).toLocaleString();
}

function messageContext(message: ScoutBrokerMessageRecord): TailContextField[] {
  return [
    { label: "TIME", value: formatDateTime(message.createdAt) },
    { label: "ACTOR", value: message.actorId },
    { label: "CLASS", value: message.class },
    { label: "CONVERSATION", value: message.conversationId },
    { label: "MESSAGE", value: message.id },
    { label: "ORIGIN", value: message.originNodeId },
    { label: "VISIBILITY", value: formatContextValue(message.visibility) },
    { label: "POLICY", value: formatContextValue(message.policy) },
    ...(message.replyToMessageId ? [{ label: "REPLY TO", value: message.replyToMessageId }] : []),
    ...(message.threadConversationId ? [{ label: "THREAD", value: message.threadConversationId }] : []),
    ...(message.mentions?.length ? [{ label: "MENTIONS", value: message.mentions.map((mention) => mention.label ?? mention.actorId).join(", ") }] : []),
    ...(message.attachments?.length ? [{ label: "ATTACHMENTS", value: message.attachments.map((attachment) => attachment.fileName ?? attachment.id).join(", ") }] : []),
  ].filter((field) => Boolean(field.value));
}

function buildTailEntries(snapshot: ScoutMonitorSnapshot): TailEntry[] {
  const messagesById = new Map(snapshot.recentMessages.map((message) => [message.id, message]));
  const representedMessages = new Set<string>();
  const activityEntries = snapshot.activity.map((item): TailEntry => {
    const message = messagesById.get(item.id);
    if (message) representedMessages.add(message.id);
    const actor = sourceText(item.actorName || displayName(item.actorId));
    const body = sourceText(message?.body ?? item.detail ?? item.title);
    return {
      key: `activity:${item.id}`,
      timestamp: normalizeTimestamp(item.timestamp) ?? 0,
      color: activityTone(item),
      kind: message?.class ?? item.kind,
      actor,
      headline: sourceText(item.title || body),
      body,
      context: message
        ? [
            ...(item.channel ? [{ label: "CHANNEL", value: item.channel }] : []),
            ...messageContext(message),
          ]
        : [
            { label: "TIME", value: formatDateTime(item.timestamp) },
            { label: "ACTOR", value: `${actor} · ${item.actorId}` },
            ...(item.channel ? [{ label: "CHANNEL", value: item.channel }] : []),
            ...(item.conversationId ? [{ label: "CONVERSATION", value: item.conversationId }] : []),
            { label: "EVENT", value: item.id },
          ],
    };
  });
  const messageEntries = snapshot.recentMessages
    .filter((message) => !representedMessages.has(message.id))
    .map((message): TailEntry => ({
      key: `message:${message.id}`,
      timestamp: normalizeTimestamp(message.createdAt) ?? 0,
      color: messageTone(message),
      kind: message.class,
      actor: sourceText(displayName(message.actorId)),
      headline: sourceText(message.body),
      body: sourceText(message.body),
      context: messageContext(message),
    }));

  return [...activityEntries, ...messageEntries]
    .sort((left, right) => left.timestamp - right.timestamp || left.key.localeCompare(right.key));
}

function buildTailDetailLines(entry: TailEntry, width: number): TailLine[] {
  return [
    ...wrapText(entry.body || entry.headline, Math.max(16, width - 2)).map((text, index): TailLine => ({
      key: `body:${index}`,
      timestamp: entry.timestamp,
      color: C.text,
      text,
    })),
    { key: "spacer", timestamp: entry.timestamp, color: C.dim, text: "" },
    ...entry.context.flatMap((field): TailLine[] => wrapText(
      `${field.label.padEnd(14, " ")} ${field.value}`,
      Math.max(16, width - 2),
    ).map((text, index) => ({
      key: `context:${field.label}:${index}`,
      timestamp: entry.timestamp,
      color: C.dim,
      text,
    }))),
  ];
}

function TailPanel({
  entries,
  channel,
  selectionOffset,
  detailOpen,
  detailScrollOffset,
  width,
  height,
  onSelectOffset,
}: {
  entries: TailEntry[];
  channel: string;
  selectionOffset: number;
  detailOpen: boolean;
  detailScrollOffset: number;
  width: number;
  height: number;
  onSelectOffset: (offset: number) => void;
}) {
  const panelHeight = Math.max(6, height);
  const lineWidth = Math.max(24, width - 4);
  const selectedIndex = entries.length === 0
    ? 0
    : clampScoutTuiSelection(entries.length - 1 - selectionOffset, entries.length);
  const selectedEntry = entries[selectedIndex] ?? null;
  const availableRows = Math.max(3, panelHeight - 5);
  const windowStart = Math.min(
    Math.max(0, entries.length - availableRows),
    Math.max(0, selectedIndex - availableRows + 1),
  );
  const visible = entries.slice(windowStart, windowStart + availableRows);
  const detailLines = selectedEntry ? buildTailDetailLines(selectedEntry, lineWidth) : [];
  const detailStart = Math.min(
    Math.max(0, detailLines.length - availableRows),
    Math.max(0, detailScrollOffset),
  );
  const visibleDetail = detailLines.slice(detailStart, detailStart + availableRows);

  return (
    <box flexDirection="column" width={width} height={panelHeight} border borderStyle="rounded" borderColor={detailOpen ? C.borderStrong : C.border} padding={1} title={`Tail · #${channel}${detailOpen ? " · Context" : ""}`}>
      {selectedEntry && detailOpen ? (
        <box flexDirection="column" flexGrow={1} backgroundColor={C.bg}>
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={selectedEntry.color}>{truncate(`${selectedEntry.kind} · ${selectedEntry.actor}`, Math.max(16, lineWidth - 20))}</text>
            <text fg={C.dim}>{formatClock(selectedEntry.timestamp)}</text>
          </box>
          <box flexDirection="column" flexGrow={1} backgroundColor={C.bg} paddingLeft={1} paddingRight={1}>
            {visibleDetail.map((line) => (
              <box key={line.key} height={1}>
                <text fg={line.color}>{fitLine(line.text, Math.max(12, lineWidth - 2))}</text>
              </box>
            ))}
          </box>
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={C.accent}>↑↓ scroll · enter / esc back</text>
            <text fg={C.dim}>{detailLines.length === 0 ? "0 lines" : `${detailStart + 1}–${Math.min(detailLines.length, detailStart + visibleDetail.length)} / ${detailLines.length}`}</text>
          </box>
        </box>
      ) : visible.length === 0 ? (
        <text fg={C.dim}>{fitLine("No tail events yet.", width - 4)}</text>
      ) : (
        visible.map((entry, index) => {
          const entryIndex = windowStart + index;
          const selected = entryIndex === selectedIndex;
          const offset = Math.max(0, entries.length - 1 - entryIndex);
          return (
          <box
            key={entry.key}
            height={1}
            backgroundColor={selected ? C.selected : C.surface}
            onMouseDown={() => onSelectOffset(offset)}
          >
            <text fg={selected ? C.accent : entry.color}>
              {fitLine(`${selected ? "›" : " "} ${formatClock(entry.timestamp)}  ${entry.kind.padEnd(7, " ")}  ${truncate(entry.actor, 12).padEnd(12, " ")}  ${entry.headline}`, lineWidth)}
            </text>
          </box>
          );
        })
      )}
      {!detailOpen && entries.length > 0 ? (
        <box height={1} flexDirection="row" justifyContent="space-between">
          <text fg={C.accent}>↑↓ choose · enter context · pgup/pgdn jump</text>
          <text fg={C.dim}>{selectedIndex + 1} / {entries.length}</text>
        </box>
      ) : null}
    </box>
  );
}

function HarnessPanel({
  snapshot,
  view,
  viewIndex,
  viewScrollOffset,
  helpDefinition,
  runtimeReport,
  runtimeLoading,
  runtimeError,
  agents,
  currentDirectory,
  activeProfile,
  activeRuntime,
  activeAgentId,
  targetLabel,
  targetDetail,
  senderId,
  conversationId,
  messages,
  localEntries,
  draft,
  active,
  sending,
  error,
  clearBefore,
  scrollOffset,
  width,
  height,
  onSubmit,
}: {
  snapshot: ScoutMonitorSnapshot;
  view: HarnessView;
  viewIndex: number;
  viewScrollOffset: number;
  helpDefinition: ScoutHarnessCommandDefinition | null;
  runtimeReport: Awaited<ReturnType<typeof loadScoutMonitorRuntimes>> | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  agents: AgentRow[];
  currentDirectory: string;
  activeProfile: string | null;
  activeRuntime: string | null;
  activeAgentId: string | null;
  targetLabel: string;
  targetDetail: string;
  senderId: string | null;
  conversationId: string | null;
  messages: ScoutBrokerMessageRecord[];
  localEntries: HarnessLocalEntry[];
  draft: ComposerDraft;
  active: boolean;
  sending: boolean;
  error: string | null;
  clearBefore: number;
  scrollOffset: number;
  width: number;
  height: number;
  onSubmit: (value: string) => Promise<boolean>;
}) {
  const lineWidth = Math.max(24, width - 4);
  const availableRows = Math.max(3, height - (view === "conversation" ? 12 : 10));
  const brokerLines = messages
    .filter((message) => (normalizeTimestamp(message.createdAt) ?? 0) >= clearBefore)
    .flatMap((message): TailLine[] => {
      const timestamp = normalizeTimestamp(message.createdAt) ?? 0;
      const actorName = message.actorId === senderId ? operatorName : displayName(message.actorId);
      const actor = truncate(sourceText(actorName), 13).padEnd(13, " ");
      return wrapText(sourceText(message.body), Math.max(16, lineWidth - 27)).map((line, index) => ({
        key: `harness:${message.id}:${index}`,
        timestamp,
        color: message.actorId === senderId ? C.accent : messageTone(message),
        text: index === 0
          ? `${formatClock(message.createdAt)}  ${actor}  ${line}`
          : `${" ".repeat(10)}${" ".repeat(15)}  ${line}`,
      }));
    });
  const localLines = localEntries
    .filter((entry) => entry.createdAt >= clearBefore)
    .flatMap((entry): TailLine[] => {
      const actor = truncate(entry.actor, 13).padEnd(13, " ");
      return wrapText(entry.body, Math.max(16, lineWidth - 27)).map((line, index) => ({
        key: `local:${entry.id}:${index}`,
        timestamp: entry.createdAt,
        color: entry.color,
        text: index === 0
          ? `${formatClock(entry.createdAt)}  ${actor}  ${line}`
          : `${" ".repeat(10)}${" ".repeat(15)}  ${line}`,
      }));
    });
  const rendered = [...brokerLines, ...localLines]
    .sort((left, right) => left.timestamp - right.timestamp || left.key.localeCompare(right.key));
  const conversationEnd = Math.max(0, rendered.length - scrollOffset);
  const conversationStart = Math.max(0, conversationEnd - availableRows);
  const conversationVisible = rendered.slice(conversationStart, conversationEnd);
  const counts = snapshot.brokerHealth.counts;
  const primitiveSummary = [
    counts ? `${counts.agents} agents` : "agents",
    counts ? `${counts.messages} msgs` : "messages",
    counts ? `${counts.flights} flights` : "flights",
    counts ? `${counts.conversations} convos` : "conversations",
    `${SCOUT_RESERVED_RUNTIME_PROFILE_IDS.length} profiles`,
  ].join("  ·  ");

  const inspectorLines: TailLine[] = [];
  const pushLine = (key: string, text: string, color = C.text, selected = false) => {
    inspectorLines.push({ key, text, color, selected, timestamp: 0 });
  };
  const pushWrapped = (key: string, text: string, color = C.muted, indent = "") => {
    wrapText(text, Math.max(16, lineWidth - indent.length - 2)).forEach((line, index) => {
      pushLine(`${key}:${index}`, `${indent}${line}`, color);
    });
  };

  if (view === "help") {
    const definitions = helpDefinition ? [helpDefinition] : [...SCOUT_HARNESS_COMMANDS];
    pushLine("help:title", helpDefinition ? `Command help · /${helpDefinition.name}` : "All harness commands", C.accent);
    pushLine("help:intro", helpDefinition
      ? "This command is part of the same registry used by the parser."
      : "Plain text talks to Scout. Slash commands open views or choose an explicit target.", C.dim);
    definitions.forEach((definition) => {
      const aliases = definition.aliases?.length ? `  aliases: ${definition.aliases.map((alias) => `/${alias}`).join(", ")}` : "";
      pushLine(`help:${definition.name}:usage`, `${definition.usage}${aliases}`, C.text);
      pushWrapped(`help:${definition.name}:summary`, definition.summary, C.muted, "  ");
    });
  } else if (view === "profiles") {
    const profiles = [...SCOUT_RESERVED_RUNTIME_PROFILE_IDS];
    const selectedProfile = profiles[clampScoutTuiSelection(viewIndex, profiles.length)] ?? profiles[0];
    pushLine("profiles:title", "Runtime profiles · broker-owned launch presets", C.accent);
    pushLine(
      "profiles:choices",
      profiles.map((profile, index) => index === viewIndex ? `[${profile}]` : profile).join("  "),
      C.accent,
      true,
    );
    if (selectedProfile) {
      pushLine("profile:detail:title", `profile:${selectedProfile}`, C.accent);
      pushLine("profile:detail:contract", "Launch: fresh session in the current project", C.text);
      pushLine("profile:detail:scope", `Project: ${compactPath(currentDirectory) ?? currentDirectory}`, C.muted);
      pushLine("profile:detail:owner", "Resolution: broker-owned harness, model, and effort mapping", C.muted);
      pushLine("profile:detail:drift", "Verification: launch resolution and observed runtime stay broker-reported", C.muted);
      pushLine("profile:detail:action", activeProfile === selectedProfile ? "Active target · Enter returns to chat" : "Enter selects this profile and returns to chat", C.dim);
    }
  } else if (view === "runtimes") {
    const harnesses = runtimeReport?.runtimeCapabilities.harnesses ?? [];
    const selectedHarness = harnesses[clampScoutTuiSelection(viewIndex, harnesses.length)] ?? harnesses[0];
    pushLine("runtimes:title", "Live runtime capabilities · broker validated at launch", C.accent);
    if (runtimeLoading) pushLine("runtimes:loading", "Loading runtime catalog…", C.yellow);
    else if (runtimeError) pushWrapped("runtimes:error", runtimeError, C.red);
    else if (harnesses.length === 0) pushLine("runtimes:empty", "No launchable runtimes were reported.", C.dim);
    const runtimeWindowStart = Math.max(0, Math.min(harnesses.length - 3, viewIndex - 1));
    harnesses.slice(runtimeWindowStart, runtimeWindowStart + 3).forEach((harness, offset) => {
      const index = runtimeWindowStart + offset;
      const state = harness.ready ? "ready" : harness.state ?? "unknown";
      const active = harness.id === activeRuntime ? "  active" : "";
      pushLine(`runtime:${harness.id}`, `${index === viewIndex ? "›" : " "} ${harness.id.padEnd(12, " ")} ${state}${active}`, harness.ready ? (index === viewIndex ? C.accent : C.text) : C.yellow, index === viewIndex);
    });
    if (selectedHarness) {
      const models = runtimeReport?.runtimeCapabilities.models.filter((model) => model.harnesses.includes(selectedHarness.id)) ?? [];
      const efforts = runtimeReport?.runtimeCapabilities.efforts.filter((effort) => effort.harnesses.includes(selectedHarness.id)) ?? [];
      pushLine("runtime:detail:title", `${selectedHarness.label} · ${selectedHarness.id}`, C.accent);
      pushWrapped("runtime:detail:description", selectedHarness.description || selectedHarness.detail || "No runtime description was reported.");
      pushWrapped("runtime:detail:models", `Models: ${models.length > 0 ? models.map((model) => model.id).join(", ") : "provider default"}`);
      pushWrapped("runtime:detail:efforts", `Effort: ${efforts.length > 0 ? efforts.map((effort) => effort.id).join(", ") : "not exposed"}`);
      pushWrapped("runtime:detail:action", "Enter selects the harness default. Type /runtime harness/model/effort for an exact tuple.", C.dim);
    }
  } else if (view === "agents") {
    const selectedAgent = agents[clampScoutTuiSelection(viewIndex, agents.length)] ?? agents[0];
    pushLine("agents:title", "Live agents · choose one for exact worker continuity", C.accent);
    if (agents.length === 0) pushLine("agents:empty", "No agents are currently registered in broker home.", C.dim);
    const agentWindowStart = Math.max(0, Math.min(agents.length - 3, viewIndex - 1));
    agents.slice(agentWindowStart, agentWindowStart + 3).forEach((agent, offset) => {
      const index = agentWindowStart + offset;
      const active = agent.key === activeAgentId ? "  active" : "";
      pushLine(`agent:${agent.key}`, `${index === viewIndex ? "›" : " "} ${truncate(agent.title, 22).padEnd(22, " ")} ${agent.status}${active}`, index === viewIndex ? C.accent : C.text, index === viewIndex);
    });
    if (selectedAgent) {
      pushLine("agent:detail:title", `${selectedAgent.title} · ${selectedAgent.key}`, C.accent);
      pushWrapped("agent:detail:project", `Project: ${selectedAgent.project}`);
      pushWrapped("agent:detail:runtime", `Runtime: ${selectedAgent.runtime} · ${selectedAgent.status} · ${selectedAgent.age}`);
      pushWrapped("agent:detail:action", "Press Enter to attach this harness to the exact agent.", C.dim);
    }
  } else if (view === "status") {
    pushLine("status:title", "Harness status", C.accent);
    pushLine("status:broker", `Broker: ${snapshot.brokerHealth.ok ? "online" : "offline"} · ${snapshot.brokerUrl}`, snapshot.brokerHealth.ok ? C.accent : C.red);
    pushLine("status:project", `Project: ${compactPath(currentDirectory) ?? currentDirectory}`, C.text);
    pushLine("status:target", `Active target: ${targetLabel}`, C.text);
    pushWrapped("status:target-detail", targetDetail, C.muted);
    if (counts) {
      pushLine("status:counts", `${counts.agents} agents · ${counts.messages} messages · ${counts.flights} flights · ${counts.conversations} conversations`, C.text);
    } else {
      pushLine("status:counts", "Broker aggregate counts are unavailable.", C.yellow);
    }
    pushLine("status:conversation", conversationId ? `Conversation: ${conversationId}` : "Conversation: not linked yet", C.dim);
    pushLine("status:refresh", `Snapshot: ${formatRelative(snapshot.refreshedAt)}`, C.dim);
    snapshot.errors.forEach((message, index) => pushWrapped(`status:error:${index}`, message, C.red));
  }

  const selectedInspectorLine = inspectorLines.findIndex((line) => line.selected);
  const inspectorStart = view === "help" || view === "status"
    ? Math.min(Math.max(0, inspectorLines.length - availableRows), Math.max(0, viewScrollOffset))
    : selectedInspectorLine >= 0
    ? Math.min(
        Math.max(0, inspectorLines.length - availableRows),
        Math.max(0, selectedInspectorLine - Math.floor(availableRows / 2)),
      )
    : 0;
  const inspectorVisible = inspectorLines.slice(inspectorStart, inspectorStart + availableRows);
  const viewLabel = view === "conversation" ? "Chat" : view[0]!.toUpperCase() + view.slice(1);
  const viewFooter = view === "conversation"
    ? (scrollOffset > 0 ? `${scrollOffset} newer lines below` : "enter sends  ·  slash commands open interactive views")
    : view === "help" || view === "status"
    ? "↑↓ or pgup/pgdn scroll  ·  / type command  ·  esc chat"
    : "↑↓ choose  ·  enter select  ·  / type command  ·  esc chat";

  return (
    <box flexDirection="column" width={width} height={height} border borderStyle="rounded" borderColor={error ? C.red : C.borderStrong} backgroundColor={C.surface} padding={1} title={`Harness · ${viewLabel}`}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={C.accent}>{truncate(`target  ${targetLabel}`, Math.max(18, Math.floor(lineWidth * 0.55)))}</text>
        <text fg={conversationId ? C.dim : C.yellow}>{truncate(conversationId ? `linked  ${conversationId}` : "new conversation", Math.max(16, Math.floor(lineWidth * 0.4)))}</text>
      </box>
      <box height={1}>
        <text fg={C.dim}>{fitLine(targetDetail, lineWidth)}</text>
      </box>
      <box height={1}>
        <text fg={C.dim}>{fitLine(primitiveSummary, lineWidth)}</text>
      </box>
      <box flexDirection="column" flexGrow={1} backgroundColor={C.bg} paddingLeft={1} paddingRight={1}>
        {view === "conversation" && conversationVisible.length === 0 ? (
          <box flexDirection="column">
            <text fg={C.muted}>{fitLine("Scout is the front door: ask about the fleet, route work, or explore the primitives.", Math.max(12, lineWidth - 2))}</text>
            <text fg={C.dim}>{fitLine("Plain text talks to Scoutbot. Try /help, /profile, /runtime, /agents, /new, or /status.", Math.max(12, lineWidth - 2))}</text>
          </box>
        ) : (view === "conversation" ? conversationVisible : inspectorVisible).map((line) => (
          <box key={line.key} height={1} backgroundColor={line.selected ? C.selected : C.bg}>
            <text fg={line.color}>{fitLine(line.text, Math.max(12, lineWidth - 2))}</text>
          </box>
        ))}
      </box>
      {view === "conversation" ? (
        <MessageComposer
          draft={draft}
          prefix="scout› "
          placeholder="Ask Scout or enter /help"
          sending={sending}
          active={active}
          error={error}
          width={lineWidth}
          submitLabel="send"
          idleHint={scrollOffset > 0 ? `${scrollOffset} newer lines below` : "Plain text talks to Scout; slash commands stay local to the harness."}
          onSubmit={onSubmit}
        />
      ) : (
        <box height={3} border borderStyle="single" borderColor={C.borderStrong} backgroundColor={C.bg} paddingLeft={1} paddingRight={1}>
          <text fg={C.accent}>{fitLine(`${viewLabel} is interactive. ${viewFooter}`, lineWidth - 2)}</text>
        </box>
      )}
      {view !== "conversation" ? (
        <box height={1} flexDirection="row" justifyContent="space-between">
          <text fg={error ? C.red : C.dim}>{truncate(error ?? viewFooter, Math.max(18, lineWidth - 24))}</text>
          <text fg={C.dim}>{`${inspectorStart + 1}–${Math.min(inspectorLines.length, inspectorStart + inspectorVisible.length)} / ${inspectorLines.length}`}</text>
        </box>
      ) : null}
    </box>
  );
}

function CommandPalette({
  commands,
  query,
  selectedIndex,
  width,
  height,
  onQueryChange,
  onSelect,
  onRun,
}: {
  commands: ScoutTuiCommand[];
  query: string;
  selectedIndex: number;
  width: number;
  height: number;
  onQueryChange: (value: string) => void;
  onSelect: (index: number) => void;
  onRun: (index?: number) => void;
}) {
  const modalWidth = Math.min(76, Math.max(40, width - 8));
  const modalHeight = Math.min(18, Math.max(10, height - 6));
  const lineWidth = modalWidth - 4;
  const visibleCount = Math.max(1, Math.floor((modalHeight - 7) / 2));
  const windowStart = Math.min(
    Math.max(0, commands.length - visibleCount),
    Math.max(0, selectedIndex - visibleCount + 1),
  );
  const visible = commands.slice(windowStart, windowStart + visibleCount);
  const rangeLabel = commands.length === 0
    ? "0 results"
    : `${windowStart + 1}–${windowStart + visible.length} / ${commands.length}`;

  return (
    <box
      position="absolute"
      zIndex={50}
      top={0}
      left={0}
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
      backgroundColor={C.bg}
    >
      <box
        flexDirection="column"
        width={modalWidth}
        height={modalHeight}
        border
        borderStyle="rounded"
        borderColor={C.accent}
        backgroundColor={C.surface}
        padding={1}
        title={`Command palette · ${rangeLabel}`}
      >
        <box flexDirection="row" height={1} backgroundColor={C.bg}>
          <text fg={C.accent}>› </text>
          <input
            width={Math.max(10, lineWidth - 2)}
            value={query}
            placeholder="Type a command…"
            placeholderColor={C.dim}
            textColor={C.text}
            focusedTextColor={C.text}
            backgroundColor={C.bg}
            focusedBackgroundColor={C.bg}
            cursorColor={C.accent}
            focused
            onInput={onQueryChange}
            onSubmit={() => onRun()}
          />
        </box>
        <box height={1}><text fg={C.dim}>{fitLine("", lineWidth)}</text></box>
        {visible.length === 0 ? (
          <text fg={C.dim}>{fitLine("No matching commands", lineWidth)}</text>
        ) : visible.map((command, index) => {
          const commandIndex = windowStart + index;
          return (
          <box
            key={command.id}
            flexDirection="row"
            justifyContent="space-between"
            height={2}
            backgroundColor={commandIndex === selectedIndex ? C.selected : C.surface}
            onMouseDown={() => {
              onSelect(commandIndex);
              onRun(commandIndex);
            }}
          >
            <box flexDirection="column">
              <text fg={commandIndex === selectedIndex ? C.accent : C.text}>
                {truncate(`${commandIndex === selectedIndex ? "›" : " "} ${command.label}`, Math.max(20, lineWidth - 14))}
              </text>
              <text fg={C.dim}>{truncate(`  ${command.description}`, Math.max(20, lineWidth - 14))}</text>
            </box>
            <text fg={C.dim}>{command.shortcut ?? ""}</text>
          </box>
          );
        })}
        <box flexGrow={1} />
        <box height={1} flexDirection="row" justifyContent="space-between">
          <text fg={C.dim}>↑↓ choose  enter run</text>
          <text fg={C.dim}>esc close</text>
        </box>
      </box>
    </box>
  );
}

function AskComposer({
  agent,
  draft,
  sending,
  error,
  width,
  height,
  onSubmit,
}: {
  agent: ScoutMonitorAgent;
  draft: ComposerDraft;
  sending: boolean;
  error: string | null;
  width: number;
  height: number;
  onSubmit: (value: string) => Promise<boolean>;
}) {
  const modalWidth = Math.min(88, Math.max(44, width - 8));
  const lineWidth = modalWidth - 4;

  return (
    <box
      position="absolute"
      zIndex={60}
      top={0}
      left={0}
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
      backgroundColor={C.bg}
    >
      <box
        flexDirection="column"
        width={modalWidth}
        height={12}
        border
        borderStyle="rounded"
        borderColor={error ? C.red : C.accent}
        backgroundColor={C.surface}
        padding={1}
        title={`Ask · ${agent.title}`}
      >
        <box height={1}>
          <text fg={C.muted}>{fitLine(`Broker-native work request to id:${agent.id}`, lineWidth)}</text>
        </box>
        <box height={1}>
          <text fg={C.dim}>{fitLine(compactPath(agent.projectRoot) ?? "No project path reported", lineWidth)}</text>
        </box>
        <MessageComposer
          draft={draft}
          prefix="ask› "
          placeholder="What should this agent do?"
          sending={sending}
          error={error}
          width={lineWidth}
          submitLabel="ask"
          idleHint="Broker-native work request; Esc closes without losing the draft."
          onSubmit={onSubmit}
        />
      </box>
    </box>
  );
}

function StatusBar({ tab, notice }: { tab: MonitorTab; notice: string | null }) {
  const hints: Record<MonitorTab, string> = {
    home: "↑↓ / jk select  ·  a / enter ask",
    harness: "ask Scout  ·  /help  /profile  /runtime  ·  tab next",
    tail: "↑↓ choose  ·  enter context  ·  tab next",
    new: "enter dispatch  ·  ^t target  ·  tab next",
  };

  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} height={2}>
      <text fg={notice ? C.accent : C.dim}>{truncate(notice ?? hints[tab], 72)}</text>
      <text fg={C.dim}>{tab === "harness" || tab === "new" ? "^c quit" : "/ commands  ·  r refresh  ·  q quit"}</text>
    </box>
  );
}

function sortMessages(messages: ScoutBrokerMessageRecord[]): ScoutBrokerMessageRecord[] {
  return messages
    .slice()
    .sort((left, right) => {
      const leftTs = normalizeTimestamp(left.createdAt) ?? 0;
      const rightTs = normalizeTimestamp(right.createdAt) ?? 0;
      if (leftTs !== rightTs) return leftTs - rightTs;
      return String(left.id).localeCompare(String(right.id));
    });
}

export function ScoutMonitorApp(props: ScoutMonitorAppProps) {
  const { width, height } = useTerminalDimensions();
  const [tab, setTab] = useState<MonitorTab>("home");
  const [snapshot, setSnapshot] = useState<ScoutMonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [tailSelectionOffset, setTailSelectionOffset] = useState(0);
  const [tailDetailOpen, setTailDetailOpen] = useState(false);
  const [tailDetailScrollOffset, setTailDetailScrollOffset] = useState(0);
  const [selectedAgentIndex, setSelectedAgentIndex] = useState(0);
  const [overlay, setOverlay] = useState<MonitorOverlay>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const askDraft = useRef("");
  const [askSending, setAskSending] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const newCommandDraft = useRef("");
  const [newCommandTargetIndex, setNewCommandTargetIndex] = useState(0);
  const [newCommandChoosingTarget, setNewCommandChoosingTarget] = useState(false);
  const [newCommandError, setNewCommandError] = useState<string | null>(null);
  const harnessDraft = useRef("");
  const [harnessSending, setHarnessSending] = useState(false);
  const [harnessError, setHarnessError] = useState<string | null>(null);
  const [harnessSenderId, setHarnessSenderId] = useState<string | null>(null);
  const [harnessView, setHarnessView] = useState<HarnessView>("conversation");
  const [harnessViewIndex, setHarnessViewIndex] = useState(0);
  const [harnessViewScrollOffset, setHarnessViewScrollOffset] = useState(0);
  const [harnessHelpDefinition, setHarnessHelpDefinition] = useState<ScoutHarnessCommandDefinition | null>(null);
  const [harnessRuntimeReport, setHarnessRuntimeReport] = useState<Awaited<ReturnType<typeof loadScoutMonitorRuntimes>> | null>(null);
  const [harnessRuntimeLoading, setHarnessRuntimeLoading] = useState(false);
  const [harnessRuntimeError, setHarnessRuntimeError] = useState<string | null>(null);
  const [harnessTargetAgentId, setHarnessTargetAgentId] = useState<string | null>(null);
  const [harnessProfile, setHarnessProfile] = useState<string | null>(null);
  const [harnessRuntimeLiteral, setHarnessRuntimeLiteral] = useState<string | null>(null);
  const [harnessContinuationHandle, setHarnessContinuationHandle] = useState<string | null>(null);
  const [harnessConversationId, setHarnessConversationId] = useState<string | null>(null);
  const [harnessMessages, setHarnessMessages] = useState<ScoutBrokerMessageRecord[]>([]);
  const [harnessEntries, setHarnessEntries] = useState<HarnessLocalEntry[]>([]);
  const [harnessClearBefore, setHarnessClearBefore] = useState(0);
  const [harnessScrollOffset, setHarnessScrollOffset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const stopped = useRef(false);
  const refreshRunning = useRef(false);
  const refreshQueued = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseAbort = useRef<AbortController | null>(null);
  const orderedAgentRows = useMemo(
    () => buildAgentRows(snapshot?.agents ?? []),
    [snapshot?.agents],
  );
  const tailEntries = useMemo(
    () => snapshot ? buildTailEntries(snapshot) : [],
    [snapshot],
  );
  const newCommandTargets = useMemo<NewCommandTarget[]>(() => [
    {
      key: "scoutbot",
      kind: "scoutbot",
      label: "Scoutbot",
      detail: "Durable assistant conversation; Scout chooses the conversational backend.",
    },
    ...SCOUT_RESERVED_RUNTIME_PROFILE_IDS.map((profile): NewCommandTarget => ({
      key: `profile:${profile}`,
      kind: "profile",
      profile,
      label: `Fresh ${profile}`,
      detail: "Start a new broker-managed runtime in this project.",
    })),
    ...orderedAgentRows.map((agent): NewCommandTarget => ({
      key: `agent:${agent.key}`,
      kind: "agent",
      agentId: agent.key,
      label: agent.title,
      detail: `${agent.status} · ${agent.project} · ${agent.runtime}`,
    })),
  ], [orderedAgentRows]);
  const selectedTailIndex = tailEntries.length === 0
    ? 0
    : clampScoutTuiSelection(tailEntries.length - 1 - tailSelectionOffset, tailEntries.length);
  const selectedTailEntry = tailEntries[selectedTailIndex] ?? null;
  const tailDetailVisibleRows = Math.max(3, Math.max(8, height - 5) - 5);
  const tailDetailLineCount = selectedTailEntry
    ? buildTailDetailLines(selectedTailEntry, Math.max(24, width - 6)).length
    : 0;
  const tailDetailMaxOffset = Math.max(0, tailDetailLineCount - tailDetailVisibleRows);
  const selectedAgentRow = orderedAgentRows[selectedAgentIndex];
  const selectedAgent = selectedAgentRow && snapshot
    ? snapshot.agents.find((agent) => agent.id === selectedAgentRow.key) ?? null
    : null;
  const harnessTargetAgent = snapshot?.agents.find((agent) => agent.id === harnessTargetAgentId) ?? null;
  const harnessTargetLabel = harnessProfile
    ? `profile:${harnessProfile}`
    : harnessRuntimeLiteral
    ? `runtime:${harnessRuntimeLiteral}`
    : harnessTargetAgent?.title ?? harnessTargetAgentId ?? "Scoutbot";
  const harnessTargetDetail = harnessProfile
    ? `Fresh ${harnessProfile} runtime in ${compactPath(props.currentDirectory) ?? props.currentDirectory}; its returned ref preserves exact follow-up context.`
    : harnessRuntimeLiteral
    ? `Exact broker runtime request in ${compactPath(props.currentDirectory) ?? props.currentDirectory}; validation stays broker-owned.`
    : harnessTargetAgent
    ? `${harnessTargetAgent.statusLabel}  ·  ${compactPath(harnessTargetAgent.projectRoot) ?? "unknown project"}  ·  ${harnessContinuationHandle ?? `id:${harnessTargetAgent.id}`}`
    : "Stable Scout assistant identity; the conversational backend can change without changing the harness.";

  const clearPollTimer = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const clearEventTimer = useCallback(() => {
    if (eventRefreshTimer.current) {
      clearTimeout(eventRefreshTimer.current);
      eventRefreshTimer.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (stopped.current) {
      return;
    }
    if (refreshRunning.current) {
      refreshQueued.current = true;
      return;
    }

    refreshRunning.current = true;
    setLoading(true);
    try {
      do {
        refreshQueued.current = false;
        const next = await loadScoutMonitorSnapshot({
          currentDirectory: props.currentDirectory,
          channel: props.channel,
          limit: props.limit,
        });
        if (stopped.current) return;
        setSnapshot(next);
        setRefreshError(null);
        const nextTailCount = buildTailEntries(next).length;
        setTailSelectionOffset((current) => clampScoutTuiSelection(current, nextTailCount));
      } while (refreshQueued.current && !stopped.current);
    } catch (error) {
      if (!stopped.current) {
        setRefreshError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      refreshRunning.current = false;
      if (!stopped.current) {
        setLoading(false);
      }
    }
  }, [props.channel, props.currentDirectory, props.limit]);

  const queueEventRefresh = useCallback(() => {
    if (stopped.current) return;
    clearEventTimer();
    eventRefreshTimer.current = setTimeout(() => {
      eventRefreshTimer.current = null;
      void refresh();
    }, 250);
  }, [clearEventTimer, refresh]);

  const shutdown = useCallback(() => {
    if (stopped.current) return;
    stopped.current = true;
    clearPollTimer();
    clearEventTimer();
    sseAbort.current?.abort();
    sseAbort.current = null;
    props.onQuit();
  }, [clearEventTimer, clearPollTimer, props]);

  const openPalette = useCallback(() => {
    setPaletteQuery("");
    setPaletteIndex(0);
    setOverlay("palette");
  }, []);

  const openAsk = useCallback(() => {
    if (!selectedAgent) {
      setNotice("No agent is available to ask.");
      return;
    }
    setAskError(null);
    setOverlay("ask");
  }, [selectedAgent]);

  const appendHarnessEntry = useCallback((
    actor: string,
    body: string,
    color = C.muted,
  ) => {
    const createdAt = Date.now() / 1000;
    setHarnessEntries((current) => [...current, {
      id: `${createdAt}:${current.length}`,
      actor,
      body,
      color,
      createdAt,
    }].slice(-64));
    setHarnessScrollOffset(0);
  }, []);

  const openHarness = useCallback(() => {
    setHarnessError(null);
    setHarnessView("conversation");
    setTab("harness");
  }, []);

  const openNewCommand = useCallback(() => {
    setNewCommandError(null);
    setNewCommandChoosingTarget(false);
    setTab("new");
  }, []);

  const resolveHarnessSenderId = useCallback(async () => {
    if (harnessSenderId) return harnessSenderId;
    const senderId = await resolveScoutSenderId(
      resolveHumanAskSenderName(null, process.env),
      props.currentDirectory,
      process.env,
    );
    setHarnessSenderId(senderId);
    return senderId;
  }, [harnessSenderId, props.currentDirectory]);

  const refreshHarness = useCallback(async (input?: {
    agentId?: string | null;
    conversationId?: string | null;
    senderId?: string;
  }) => {
    const agentId = input?.agentId === undefined ? harnessTargetAgentId : input.agentId;
    const conversationId = input?.conversationId === undefined
      ? harnessConversationId
      : input.conversationId;
    if (!agentId && !conversationId) {
      setHarnessMessages([]);
      return;
    }
    const senderId = input?.senderId ?? await resolveHarnessSenderId();
    const next = await loadScoutMonitorHarness({
      senderId,
      ...(agentId ? { agentId } : {}),
      ...(conversationId ? { conversationId } : {}),
      limit: props.limit,
    });
    setHarnessConversationId(next.conversationId);
    setHarnessMessages(sortMessages(next.messages));
    setHarnessScrollOffset(0);
  }, [harnessConversationId, harnessTargetAgentId, props.limit, resolveHarnessSenderId]);

  const dispatchHarnessAsk = useCallback(async (
    body: string,
    target?: {
      profile: string | null;
      runtimeLiteral: string | null;
      agentId: string | null;
      continuationHandle: string | null;
    },
  ): Promise<string | null> => {
    if (harnessSending) return "A command is already dispatching.";
    const profile = target ? target.profile : harnessProfile;
    const runtimeLiteral = target ? target.runtimeLiteral : harnessRuntimeLiteral;
    const targetAgentId = target ? target.agentId : harnessTargetAgentId;
    const continuationHandle = target ? target.continuationHandle : harnessContinuationHandle;

    setHarnessSending(true);
    setHarnessError(null);
    try {
      if (!profile && !runtimeLiteral && !targetAgentId && !continuationHandle) {
        const receipt = await sendScoutMonitorAssistantMessage({
          body,
          currentDirectory: props.currentDirectory,
        });
        setHarnessSenderId("operator");
        setHarnessConversationId(receipt.conversationId);
        await refreshHarness({
          agentId: SCOUT_MONITOR_ASSISTANT_ID,
          conversationId: receipt.conversationId,
          senderId: "operator",
        });
        void refresh();
        return null;
      }

      const senderId = await resolveHarnessSenderId();
      const parsedRuntime = runtimeLiteral
        ? parseScoutHarnessRuntime(runtimeLiteral)
        : null;
      if (parsedRuntime && !parsedRuntime.ok) {
        throw new Error(parsedRuntime.message);
      }
      const receipt = await scoutAskHandler({
        senderId,
        ...(profile
          ? { runtimeProfile: profile, projectPath: props.currentDirectory }
          : parsedRuntime?.ok
          ? {
              projectPath: props.currentDirectory,
              runtimeLiteral: parsedRuntime.value.literal,
              harness: parsedRuntime.value.harness,
              ...(parsedRuntime.value.model ? { model: parsedRuntime.value.model } : {}),
              ...(parsedRuntime.value.reasoningEffort
                ? { reasoningEffort: parsedRuntime.value.reasoningEffort }
                : {}),
              executionSource: {
                harness: "literal" as const,
                ...(parsedRuntime.value.model ? { model: "literal" as const } : {}),
                ...(parsedRuntime.value.reasoningEffort
                  ? { reasoningEffort: "literal" as const }
                  : {}),
              },
              session: "new" as const,
            }
          : continuationHandle
          ? { existingHandle: continuationHandle }
          : { to: `id:${targetAgentId}` }),
        body,
        replyMode: "notify",
        currentDirectory: props.currentDirectory,
        source: "scout-tui-harness",
      });
      if (!receipt.ok) {
        throw new Error(
          receipt.error?.message
            ?? receipt.next?.reason
            ?? `Scout could not route the ask (${receipt.state}).`,
        );
      }

      const nextAgentId = receipt.ids.targetAgentId ?? targetAgentId;
      const nextContinuationHandle = receipt.ids.bindingRef
        ? `ref:${receipt.ids.bindingRef.replace(/^ref:/, "")}`
        : continuationHandle;
      if (nextAgentId) setHarnessTargetAgentId(nextAgentId);
      if (nextContinuationHandle) setHarnessContinuationHandle(nextContinuationHandle);
      if ((profile || runtimeLiteral) && nextAgentId) {
        setHarnessProfile(null);
        setHarnessRuntimeLiteral(null);
      }
      if (receipt.ids.conversationId) setHarnessConversationId(receipt.ids.conversationId);
      appendHarnessEntry(
        "scout",
        receipt.ids.flightId
          ? `queued flight ${receipt.ids.flightId}${nextAgentId ? ` for ${nextAgentId}` : ""}${nextContinuationHandle ? `  ·  ${nextContinuationHandle}` : ""}`
          : `ask queued${nextAgentId ? ` for ${nextAgentId}` : ""}`,
        C.accent,
      );
      await refreshHarness({
        agentId: nextAgentId,
        conversationId: receipt.ids.conversationId,
        senderId,
      });
      void refresh();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHarnessError(message);
      appendHarnessEntry("scout", message, C.red);
      return message;
    } finally {
      setHarnessSending(false);
    }
  }, [
    appendHarnessEntry,
    harnessContinuationHandle,
    harnessProfile,
    harnessRuntimeLiteral,
    harnessSending,
    harnessTargetAgentId,
    props.currentDirectory,
    refresh,
    refreshHarness,
    resolveHarnessSenderId,
  ]);

  const submitHarness = useCallback(async (value: string): Promise<boolean> => {
    if (harnessSending) return false;
    const command = parseScoutHarnessCommand(value);
    if (command.kind === "empty") return false;
    setHarnessError(null);

    if (command.kind === "invalid") {
      appendHarnessEntry("scout", command.message, C.red);
      return true;
    }
    if (command.kind === "help") {
      const definition = command.query ? findScoutHarnessCommandDefinition(command.query) : null;
      if (command.query && !definition) {
        appendHarnessEntry("scout", `No command matches “${command.query}”. Opening all help.`, C.red);
      }
      setHarnessHelpDefinition(definition);
      setHarnessViewScrollOffset(0);
      setHarnessView("help");
      return true;
    }
    if (command.kind === "status") {
      setHarnessViewScrollOffset(0);
      setHarnessView("status");
      return true;
    }
    if (command.kind === "chat") {
      setHarnessProfile(null);
      setHarnessRuntimeLiteral(null);
      setHarnessTargetAgentId(null);
      setHarnessContinuationHandle(null);
      setHarnessConversationId(null);
      setHarnessMessages([]);
      setHarnessSenderId("operator");
      setHarnessView("conversation");
      return true;
    }
    if (command.kind === "navigate") {
      if (command.tab === "new") {
        openNewCommand();
      } else {
        if (command.tab === "tail") {
          setTailDetailOpen(false);
          setTailDetailScrollOffset(0);
        }
        setTab(command.tab === "fleet" ? "home" : "tail");
      }
      return true;
    }
    if (command.kind === "clear") {
      setHarnessEntries([]);
      setHarnessClearBefore(Date.now() / 1000);
      setHarnessScrollOffset(0);
      setHarnessView("conversation");
      return true;
    }
    if (command.kind === "profile") {
      if (!command.profile) {
        const selectedIndex = harnessProfile
          ? SCOUT_RESERVED_RUNTIME_PROFILE_IDS.indexOf(harnessProfile as (typeof SCOUT_RESERVED_RUNTIME_PROFILE_IDS)[number])
          : 0;
        setHarnessViewIndex(Math.max(0, selectedIndex));
        setHarnessView("profiles");
        return true;
      }
      const profile = normalizeReservedRuntimeProfileId(command.profile);
      if (!profile) {
        appendHarnessEntry(
          "scout",
          `Unknown runtime profile: ${command.profile}. Available: ${SCOUT_RESERVED_RUNTIME_PROFILE_IDS.join(", ")}.`,
          C.red,
        );
        return true;
      }
      setHarnessProfile(profile);
      setHarnessRuntimeLiteral(null);
      setHarnessTargetAgentId(null);
      setHarnessContinuationHandle(null);
      setHarnessConversationId(null);
      setHarnessMessages([]);
      setHarnessViewIndex(Math.max(0, SCOUT_RESERVED_RUNTIME_PROFILE_IDS.indexOf(profile)));
      setHarnessView("profiles");
      return true;
    }
    if (command.kind === "runtime") {
      if (!command.runtime) {
        setHarnessViewIndex(0);
        setHarnessView("runtimes");
        return true;
      }
      const runtime = command.runtime.trim();
      setHarnessRuntimeLiteral(runtime);
      setHarnessProfile(null);
      setHarnessTargetAgentId(null);
      setHarnessContinuationHandle(null);
      setHarnessConversationId(null);
      setHarnessMessages([]);
      const harnessId = runtime.split("/")[0];
      const runtimeIndex = harnessRuntimeReport?.runtimeCapabilities.harnesses.findIndex((entry) => entry.id === harnessId) ?? -1;
      setHarnessViewIndex(Math.max(0, runtimeIndex));
      setHarnessView("runtimes");
      return true;
    }
    if (command.kind === "agent") {
      if (!command.query) {
        const currentIndex = orderedAgentRows.findIndex((agent) => agent.key === harnessTargetAgentId);
        setHarnessViewIndex(Math.max(0, currentIndex));
        setHarnessView("agents");
        return true;
      }
      const match = findScoutHarnessAgent(
        orderedAgentRows.map((agent) => ({ id: agent.key, title: agent.title })),
        command.query,
      );
      if (match.kind === "ambiguous") {
        const candidates = match.indices
          .map((index) => orderedAgentRows[index]?.key)
          .filter((id): id is string => Boolean(id));
        appendHarnessEntry(
          "scout",
          `Ambiguous agent “${command.query}”. Use one full id: ${candidates.join(", ")}.`,
          C.red,
        );
        return true;
      }
      if (match.kind === "missing") {
        appendHarnessEntry("scout", `No fleet agent matches “${command.query}”. Try /agents.`, C.red);
        return true;
      }
      const agent = orderedAgentRows[match.index]!;
      setSelectedAgentIndex(match.index);
      setHarnessTargetAgentId(agent.key);
      setHarnessProfile(null);
      setHarnessRuntimeLiteral(null);
      setHarnessContinuationHandle(null);
      setHarnessConversationId(null);
      setHarnessMessages([]);
      setHarnessViewIndex(match.index);
      setHarnessView("agents");
      return true;
    }

    return (await dispatchHarnessAsk(command.body)) === null;
  }, [
    appendHarnessEntry,
    dispatchHarnessAsk,
    harnessProfile,
    harnessTargetAgentId,
    harnessRuntimeReport,
    orderedAgentRows,
    openNewCommand,
  ]);

  const submitNewCommand = useCallback(async (value: string): Promise<boolean> => {
    const body = value.trim();
    const target = newCommandTargets[
      clampScoutTuiSelection(newCommandTargetIndex, newCommandTargets.length)
    ];
    if (!body || !target || harnessSending) return false;
    if (!snapshot?.brokerHealth.ok) {
      setNewCommandError("Broker offline. Run scout doctor, then retry.");
      return false;
    }

    setNewCommandError(null);
    setHarnessConversationId(null);
    setHarnessMessages([]);
    setHarnessContinuationHandle(null);
    let dispatchTarget: {
      profile: string | null;
      runtimeLiteral: string | null;
      agentId: string | null;
      continuationHandle: string | null;
    };

    if (target.kind === "profile") {
      setHarnessProfile(target.profile);
      setHarnessRuntimeLiteral(null);
      setHarnessTargetAgentId(null);
      dispatchTarget = {
        profile: target.profile,
        runtimeLiteral: null,
        agentId: null,
        continuationHandle: null,
      };
    } else if (target.kind === "agent") {
      setHarnessProfile(null);
      setHarnessRuntimeLiteral(null);
      setHarnessTargetAgentId(target.agentId);
      const agentIndex = orderedAgentRows.findIndex((agent) => agent.key === target.agentId);
      if (agentIndex >= 0) setSelectedAgentIndex(agentIndex);
      dispatchTarget = {
        profile: null,
        runtimeLiteral: null,
        agentId: target.agentId,
        continuationHandle: null,
      };
    } else {
      setHarnessProfile(null);
      setHarnessRuntimeLiteral(null);
      setHarnessTargetAgentId(null);
      dispatchTarget = {
        profile: null,
        runtimeLiteral: null,
        agentId: null,
        continuationHandle: null,
      };
    }

    const dispatchError = await dispatchHarnessAsk(body, dispatchTarget);
    if (dispatchError) {
      setNewCommandError(dispatchError);
      return false;
    }
    setNewCommandChoosingTarget(false);
    setHarnessView("conversation");
    setTab("harness");
    return true;
  }, [
    dispatchHarnessAsk,
    harnessSending,
    newCommandTargetIndex,
    newCommandTargets,
    orderedAgentRows,
    snapshot?.brokerHealth.ok,
  ]);

  const harnessViewItemCount = harnessView === "profiles"
    ? SCOUT_RESERVED_RUNTIME_PROFILE_IDS.length
    : harnessView === "runtimes"
    ? harnessRuntimeReport?.runtimeCapabilities.harnesses.length ?? 0
    : harnessView === "agents"
    ? orderedAgentRows.length
    : 0;

  const activateHarnessViewSelection = useCallback(() => {
    if (harnessView === "profiles") {
      const profile = SCOUT_RESERVED_RUNTIME_PROFILE_IDS[
        clampScoutTuiSelection(harnessViewIndex, SCOUT_RESERVED_RUNTIME_PROFILE_IDS.length)
      ];
      if (!profile) return;
      setHarnessProfile(profile);
      setHarnessRuntimeLiteral(null);
      setHarnessTargetAgentId(null);
      setHarnessContinuationHandle(null);
      setHarnessConversationId(null);
      setHarnessMessages([]);
      appendHarnessEntry("target", `profile:${profile} selected · next request starts a fresh broker-managed runtime`, C.accent);
      setHarnessView("conversation");
      return;
    }
    if (harnessView === "runtimes") {
      const runtime = harnessRuntimeReport?.runtimeCapabilities.harnesses[
        clampScoutTuiSelection(harnessViewIndex, harnessRuntimeReport.runtimeCapabilities.harnesses.length)
      ];
      if (!runtime) return;
      setHarnessRuntimeLiteral(runtime.id);
      setHarnessProfile(null);
      setHarnessTargetAgentId(null);
      setHarnessContinuationHandle(null);
      setHarnessConversationId(null);
      setHarnessMessages([]);
      appendHarnessEntry("target", `runtime:${runtime.id} selected · broker validation happens when the request starts`, C.accent);
      setHarnessView("conversation");
      return;
    }
    if (harnessView === "agents") {
      const agent = orderedAgentRows[clampScoutTuiSelection(harnessViewIndex, orderedAgentRows.length)];
      if (!agent) return;
      setSelectedAgentIndex(orderedAgentRows.findIndex((candidate) => candidate.key === agent.key));
      setHarnessTargetAgentId(agent.key);
      setHarnessProfile(null);
      setHarnessRuntimeLiteral(null);
      setHarnessContinuationHandle(null);
      setHarnessConversationId(null);
      setHarnessMessages([]);
      appendHarnessEntry("target", `${agent.title} selected · id:${agent.key}`, C.accent);
      setHarnessView("conversation");
    }
  }, [
    appendHarnessEntry,
    harnessRuntimeReport,
    harnessView,
    harnessViewIndex,
    orderedAgentRows,
  ]);

  const submitAsk = useCallback(async (value: string): Promise<boolean> => {
    const body = value.trim();
    if (!selectedAgent || !body || askSending) return false;

    setAskSending(true);
    setAskError(null);
    try {
      const senderId = await resolveScoutSenderId(
        resolveHumanAskSenderName(null, process.env),
        props.currentDirectory,
        process.env,
      );
      const receipt = await scoutAskHandler({
        senderId,
        to: `id:${selectedAgent.id}`,
        body,
        replyMode: "notify",
        currentDirectory: props.currentDirectory,
        source: "scout-tui",
      });
      if (!receipt.ok) {
        throw new Error(
          receipt.error?.message
            ?? receipt.next?.reason
            ?? `Scout could not route the ask (${receipt.state}).`,
        );
      }

      setOverlay(null);
      setNotice(
        receipt.ids.flightId
          ? `Asked ${selectedAgent.title} · flight ${receipt.ids.flightId}`
          : `Asked ${selectedAgent.title}`,
      );
      void refresh();
      return true;
    } catch (error) {
      setAskError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setAskSending(false);
    }
  }, [askSending, props.currentDirectory, refresh, selectedAgent]);

  const paletteCommands = useMemo<ScoutTuiCommand[]>(() => [
    { id: "fleet", label: "Show fleet", description: "Return to the live agent control plane", shortcut: "1" },
    { id: "harness", label: "Open interactive harness", description: "Talk to Scout and explore agents, profiles, and runtimes", shortcut: "2" },
    { id: "tail", label: "Open live tail", description: "Follow recent broker activity and messages", shortcut: "3" },
    { id: "new", label: "New command", description: "Choose a target, dispatch work, and open its conversation", shortcut: "n" },
    { id: "ask", label: "Ask selected agent", description: selectedAgent ? `Dispatch work to ${selectedAgent.title}` : "Select an agent first", shortcut: "a", enabled: Boolean(selectedAgent) },
    { id: "next-agent", label: "Select next agent", description: "Move the fleet cursor down", shortcut: "↓", enabled: orderedAgentRows.length > 0 },
    { id: "previous-agent", label: "Select previous agent", description: "Move the fleet cursor up", shortcut: "↑", enabled: orderedAgentRows.length > 0 },
    { id: "refresh", label: "Refresh broker state", description: "Reload health, fleet, activity, and messages", shortcut: "r" },
    { id: "quit", label: "Quit Scout TUI", description: "Return to the terminal", shortcut: "q" },
  ], [orderedAgentRows.length, selectedAgent]);
  const visiblePaletteCommands = useMemo(
    () => filterScoutTuiCommands(paletteCommands, paletteQuery),
    [paletteCommands, paletteQuery],
  );

  const runPaletteCommand = useCallback((index = paletteIndex) => {
    const command = visiblePaletteCommands[index];
    if (!command) return;
    setOverlay(null);
    switch (command.id) {
      case "fleet":
        setTab("home");
        break;
      case "tail":
        setTailDetailOpen(false);
        setTailDetailScrollOffset(0);
        setTab("tail");
        break;
      case "harness":
        openHarness();
        break;
      case "new":
        openNewCommand();
        break;
      case "ask":
        openAsk();
        break;
      case "next-agent":
        setTab("home");
        setSelectedAgentIndex((current) => moveScoutTuiSelection(current, 1, orderedAgentRows.length));
        break;
      case "previous-agent":
        setTab("home");
        setSelectedAgentIndex((current) => moveScoutTuiSelection(current, -1, orderedAgentRows.length));
        break;
      case "refresh":
        void refresh();
        break;
      case "quit":
        shutdown();
        break;
    }
  }, [openAsk, openHarness, openNewCommand, orderedAgentRows.length, paletteIndex, refresh, shutdown, visiblePaletteCommands]);

  useEffect(() => {
    setSelectedAgentIndex((current) => clampScoutTuiSelection(current, orderedAgentRows.length));
  }, [orderedAgentRows.length]);

  useEffect(() => {
    setNewCommandTargetIndex((current) => clampScoutTuiSelection(current, newCommandTargets.length));
  }, [newCommandTargets.length]);

  useEffect(() => {
    setTailSelectionOffset((current) => clampScoutTuiSelection(current, tailEntries.length));
  }, [tailEntries.length]);

  useEffect(() => {
    if (
      tab !== "harness"
      || harnessProfile
      || harnessRuntimeLiteral
      || (!harnessTargetAgentId && !harnessConversationId)
    ) {
      return;
    }
    void refreshHarness().catch((error) => {
      setHarnessError(error instanceof Error ? error.message : String(error));
    });
  }, [
    harnessConversationId,
    harnessProfile,
    harnessRuntimeLiteral,
    harnessTargetAgentId,
    refreshHarness,
    tab,
  ]);

  useEffect(() => {
    if (tab !== "harness" || harnessView !== "runtimes" || harnessRuntimeReport || harnessRuntimeLoading || harnessRuntimeError) {
      return;
    }
    setHarnessRuntimeLoading(true);
    setHarnessRuntimeError(null);
    void loadScoutMonitorRuntimes(props.currentDirectory)
      .then((report) => {
        setHarnessRuntimeReport(report);
        setHarnessViewIndex((current) => clampScoutTuiSelection(
          current,
          report.runtimeCapabilities.harnesses.length,
        ));
      })
      .catch((error) => {
        setHarnessRuntimeError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setHarnessRuntimeLoading(false));
  }, [
    harnessRuntimeLoading,
    harnessRuntimeError,
    harnessRuntimeReport,
    harnessView,
    props.currentDirectory,
    tab,
  ]);

  useEffect(() => {
    setPaletteIndex((current) => clampScoutTuiSelection(current, visiblePaletteCommands.length));
  }, [visiblePaletteCommands.length]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [paletteQuery]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const pollMs = Math.max(props.refreshIntervalMs, 5_000);
  useEffect(() => {
    stopped.current = false;

    async function tick() {
      await refresh();
      if (stopped.current) return;
      pollTimer.current = setTimeout(() => void tick(), pollMs);
    }

    void tick();
    return () => {
      stopped.current = true;
      clearPollTimer();
      clearEventTimer();
      sseAbort.current?.abort();
      sseAbort.current = null;
    };
  }, [clearEventTimer, clearPollTimer, pollMs, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    sseAbort.current = controller;
    const relayConversationId = scoutConversationIdForChannel(props.channel);

    async function connect() {
      try {
        const response = await fetch(new URL(scoutBrokerPaths.v1.eventsStream, resolveScoutBrokerUrl()), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const index = buffer.indexOf("\n\n");
            if (index === -1) break;
            const block = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 2);
            if (!block) continue;

            let eventName = "";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length === 0) continue;

            let event: { kind?: string; payload?: Record<string, unknown> };
            try {
              event = JSON.parse(dataLines.join("\n"));
            } catch {
              continue;
            }

            const kind = eventName || event.kind;
            if (kind === "message.posted" || event.kind === "message.posted") {
              const message = event.payload?.message as ScoutBrokerMessageRecord | undefined;
              if (!message) continue;
              if (message.conversationId === relayConversationId) {
                setSnapshot((current) => {
                  if (!current || current.recentMessages.some((entry) => entry.id === message.id)) {
                    return current;
                  }
                  const recentMessages = sortMessages([...current.recentMessages, message]).slice(-props.limit);
                  return { ...current, recentMessages, refreshedAt: Date.now() };
                });
              }
              if (message.conversationId === harnessConversationId) {
                setHarnessMessages((current) => {
                  if (current.some((entry) => entry.id === message.id)) return current;
                  return sortMessages([...current, message]).slice(-props.limit);
                });
                setHarnessScrollOffset(0);
              }
              queueEventRefresh();
              continue;
            }

            if (
              kind === "agent.endpoint.upserted"
              || kind === "flight.updated"
              || kind === "collaboration.updated"
            ) {
              queueEventRefresh();
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    }

    void connect();
    return () => {
      controller.abort();
      if (sseAbort.current === controller) {
        sseAbort.current = null;
      }
    };
  }, [harnessConversationId, props.channel, props.limit, queueEventRefresh]);

  useKeyboard((key) => {
    if (key.name === "c" && key.ctrl) {
      shutdown();
      return;
    }

    if (overlay === "palette") {
      if (key.name === "escape") {
        setOverlay(null);
        return;
      }
      if (key.name === "up") {
        setPaletteIndex((current) => moveScoutTuiSelection(current, -1, visiblePaletteCommands.length));
        return;
      }
      if (key.name === "down") {
        setPaletteIndex((current) => moveScoutTuiSelection(current, 1, visiblePaletteCommands.length));
      }
      return;
    }

    if (overlay === "ask") {
      if (key.name === "escape" && !askSending) {
        setAskError(null);
        setOverlay(null);
      }
      return;
    }

    if (key.name === "tab") {
      const index = MONITOR_TABS.indexOf(tab);
      const direction = key.shift ? -1 : 1;
      const next = MONITOR_TABS[(index + direction + MONITOR_TABS.length) % MONITOR_TABS.length] ?? "home";
      if (next === "harness") openHarness();
      else if (next === "new") openNewCommand();
      else {
        if (next === "tail") {
          setTailDetailOpen(false);
          setTailDetailScrollOffset(0);
        }
        setTab(next);
      }
      return;
    }

    if (tab === "harness") {
      if (key.name === "escape") {
        if (harnessView !== "conversation") {
          setHarnessView("conversation");
        } else {
          setTab("home");
        }
        return;
      }
      if (key.name === "p" && key.ctrl) {
        openPalette();
        return;
      }
      if (key.name === "r" && key.ctrl) {
        if (harnessView === "runtimes") {
          setHarnessRuntimeReport(null);
          setHarnessRuntimeError(null);
        }
        void refreshHarness();
        return;
      }
      if (harnessView !== "conversation") {
        if (key.name === "/" || key.name === "slash") {
          setHarnessView("conversation");
          harnessDraft.current = "/";
          return;
        }
        if (key.name === "up" || key.name === "k") {
          if (harnessViewItemCount > 0) {
            setHarnessViewIndex((current) => moveScoutTuiSelection(current, -1, harnessViewItemCount));
          } else {
            setHarnessViewScrollOffset((current) => Math.max(0, current - 1));
          }
          return;
        }
        if (key.name === "down" || key.name === "j") {
          if (harnessViewItemCount > 0) {
            setHarnessViewIndex((current) => moveScoutTuiSelection(current, 1, harnessViewItemCount));
          } else {
            setHarnessViewScrollOffset((current) => current + 1);
          }
          return;
        }
        if (key.name === "pageup" || (key.name === "u" && key.ctrl)) {
          setHarnessViewScrollOffset((current) => Math.max(0, current - 5));
          return;
        }
        if (key.name === "pagedown" || (key.name === "d" && key.ctrl)) {
          setHarnessViewScrollOffset((current) => current + 5);
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          activateHarnessViewSelection();
        }
        return;
      }
      if (key.name === "pageup") {
        setHarnessScrollOffset((current) => current + 5);
        return;
      }
      if (key.name === "pagedown") {
        setHarnessScrollOffset((current) => Math.max(0, current - 5));
      }
      return;
    }

    if (tab === "new") {
      if (key.name === "escape") {
        if (newCommandChoosingTarget) {
          setNewCommandChoosingTarget(false);
        } else {
          setTab("home");
        }
        return;
      }
      if (key.name === "p" && key.ctrl) {
        openPalette();
        return;
      }
      if (key.name === "r" && key.ctrl) {
        void refresh();
        return;
      }
      if (key.name === "t" && key.ctrl && !harnessSending) {
        setNewCommandChoosingTarget((current) => !current);
        setNewCommandError(null);
        return;
      }
      if (newCommandChoosingTarget) {
        if (key.name === "up" || key.name === "k") {
          setNewCommandTargetIndex((current) => moveScoutTuiSelection(current, -1, newCommandTargets.length));
          return;
        }
        if (key.name === "down" || key.name === "j") {
          setNewCommandTargetIndex((current) => moveScoutTuiSelection(current, 1, newCommandTargets.length));
          return;
        }
        if (key.name === "pageup") {
          setNewCommandTargetIndex((current) => clampScoutTuiSelection(current - 5, newCommandTargets.length));
          return;
        }
        if (key.name === "pagedown") {
          setNewCommandTargetIndex((current) => clampScoutTuiSelection(current + 5, newCommandTargets.length));
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          setNewCommandChoosingTarget(false);
        }
        return;
      }
      return;
    }

    if (tab === "tail") {
      if (tailDetailOpen) {
        if (key.name === "escape" || key.name === "return" || key.name === "enter") {
          setTailDetailOpen(false);
          setTailDetailScrollOffset(0);
          return;
        }
        if (key.name === "up" || key.name === "k") {
          setTailDetailScrollOffset((current) => Math.max(0, current - 1));
          return;
        }
        if (key.name === "down" || key.name === "j") {
          setTailDetailScrollOffset((current) => Math.min(tailDetailMaxOffset, current + 1));
          return;
        }
        if (key.name === "pageup" || (key.name === "u" && key.ctrl)) {
          setTailDetailScrollOffset((current) => Math.max(0, current - 5));
          return;
        }
        if (key.name === "pagedown" || (key.name === "d" && key.ctrl)) {
          setTailDetailScrollOffset((current) => Math.min(tailDetailMaxOffset, current + 5));
          return;
        }
      } else {
        if (key.name === "escape") {
          setTab("home");
          return;
        }
        if (key.name === "up" || key.name === "k") {
          setTailSelectionOffset((current) => clampScoutTuiSelection(current + 1, tailEntries.length));
          setTailDetailScrollOffset(0);
          return;
        }
        if (key.name === "down" || key.name === "j") {
          setTailSelectionOffset((current) => Math.max(0, current - 1));
          setTailDetailScrollOffset(0);
          return;
        }
        if (key.name === "pageup" || (key.name === "u" && key.ctrl)) {
          setTailSelectionOffset((current) => clampScoutTuiSelection(current + 5, tailEntries.length));
          setTailDetailScrollOffset(0);
          return;
        }
        if (key.name === "pagedown" || (key.name === "d" && key.ctrl)) {
          setTailSelectionOffset((current) => Math.max(0, current - 5));
          setTailDetailScrollOffset(0);
          return;
        }
        if ((key.name === "return" || key.name === "enter") && selectedTailEntry) {
          setTailDetailOpen(true);
          setTailDetailScrollOffset(0);
          return;
        }
      }
    }

    if (key.name === "q") {
      shutdown();
      return;
    }
    if (key.name === "escape") {
      if (tab === "home") shutdown();
      else setTab("home");
      return;
    }
    if (
      key.name === "/"
      || key.name === "slash"
      || key.name === "?"
      || key.name === "question"
      || (key.name === "p" && key.ctrl)
    ) {
      openPalette();
      return;
    }
    if (key.name === "r") {
      void refresh();
      return;
    }
    if (key.name === "1") {
      setTab("home");
      return;
    }
    if (key.name === "2") {
      openHarness();
      return;
    }
    if (key.name === "3") {
      setTailDetailOpen(false);
      setTailDetailScrollOffset(0);
      setTab("tail");
      return;
    }
    if (key.name === "4") {
      openNewCommand();
      return;
    }
    if (key.name === "h") {
      openHarness();
      return;
    }
    if (key.name === "n") {
      openNewCommand();
      return;
    }
    if (tab === "home" && (key.name === "up" || key.name === "k")) {
      setSelectedAgentIndex((current) => moveScoutTuiSelection(current, -1, orderedAgentRows.length));
      return;
    }
    if (tab === "home" && (key.name === "down" || key.name === "j")) {
      setSelectedAgentIndex((current) => moveScoutTuiSelection(current, 1, orderedAgentRows.length));
      return;
    }
    if (tab === "home" && (key.name === "a" || key.name === "return" || key.name === "enter")) {
      openAsk();
      return;
    }
  });

  const content = useMemo(() => {
    if (!snapshot) {
      return (
        <box flexGrow={1} padding={1}>
          <text fg={refreshError ? C.red : C.dim}>
            {refreshError ? `Scout TUI failed: ${refreshError}` : "Loading Scout broker aggregate..."}
          </text>
        </box>
      );
    }

    if (tab === "home") {
      return (
        <HomePanel
          snapshot={snapshot}
          selectedIndex={selectedAgentIndex}
          onSelect={setSelectedAgentIndex}
          width={width}
          height={height}
        />
      );
    }

    if (tab === "tail") {
      return (
        <box flexGrow={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
          <TailPanel
            entries={tailEntries}
            channel={snapshot.channel}
            selectionOffset={tailSelectionOffset}
            detailOpen={tailDetailOpen}
            detailScrollOffset={tailDetailScrollOffset}
            width={Math.max(32, width - 2)}
            height={Math.max(8, height - 5)}
            onSelectOffset={(offset) => {
              setTailSelectionOffset(offset);
              setTailDetailScrollOffset(0);
            }}
          />
        </box>
      );
    }

    if (tab === "harness") {
      return (
        <box flexGrow={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
          <HarnessPanel
            snapshot={snapshot}
            view={harnessView}
            viewIndex={harnessViewIndex}
            viewScrollOffset={harnessViewScrollOffset}
            helpDefinition={harnessHelpDefinition}
            runtimeReport={harnessRuntimeReport}
            runtimeLoading={harnessRuntimeLoading}
            runtimeError={harnessRuntimeError}
            agents={orderedAgentRows}
            currentDirectory={props.currentDirectory}
            activeProfile={harnessProfile}
            activeRuntime={harnessRuntimeLiteral}
            activeAgentId={harnessTargetAgentId}
            targetLabel={harnessTargetLabel}
            targetDetail={harnessTargetDetail}
            senderId={harnessSenderId}
            conversationId={harnessConversationId}
            messages={harnessMessages}
            localEntries={harnessEntries}
            draft={harnessDraft}
            active={overlay === null}
            sending={harnessSending}
            error={harnessError}
            clearBefore={harnessClearBefore}
            scrollOffset={harnessScrollOffset}
            width={Math.max(32, width - 2)}
            height={Math.max(8, height - 5)}
            onSubmit={submitHarness}
          />
        </box>
      );
    }

    return (
      <box flexGrow={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
        <NewCommandPanel
          snapshot={snapshot}
          targets={newCommandTargets}
          selectedIndex={newCommandTargetIndex}
          choosingTarget={newCommandChoosingTarget}
          draft={newCommandDraft}
          active={overlay === null}
          sending={harnessSending}
          error={newCommandError}
          width={Math.max(32, width - 2)}
          height={Math.max(8, height - 5)}
          onSelect={setNewCommandTargetIndex}
          onChooseTarget={() => setNewCommandChoosingTarget(false)}
          onSubmit={submitNewCommand}
        />
      </box>
    );
  }, [
    harnessClearBefore,
    harnessConversationId,
    harnessEntries,
    harnessError,
    harnessHelpDefinition,
    harnessMessages,
    harnessProfile,
    harnessRuntimeError,
    harnessRuntimeLiteral,
    harnessRuntimeLoading,
    harnessRuntimeReport,
    harnessScrollOffset,
    harnessSenderId,
    harnessSending,
    harnessTargetDetail,
    harnessTargetLabel,
    harnessTargetAgentId,
    harnessView,
    harnessViewIndex,
    harnessViewScrollOffset,
    height,
    refreshError,
    newCommandChoosingTarget,
    newCommandError,
    newCommandTargetIndex,
    newCommandTargets,
    selectedAgentIndex,
    orderedAgentRows,
    overlay,
    props.currentDirectory,
    snapshot,
    submitHarness,
    submitNewCommand,
    tab,
    tailDetailOpen,
    tailDetailScrollOffset,
    tailEntries,
    tailSelectionOffset,
    width,
  ]);

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={C.bg}>
      <Header snapshot={snapshot} loading={loading} tab={tab} width={width} />
      {content}
      <StatusBar tab={tab} notice={notice} />
      {overlay === "palette" ? (
        <CommandPalette
          commands={visiblePaletteCommands}
          query={paletteQuery}
          selectedIndex={paletteIndex}
          width={width}
          height={height}
          onQueryChange={setPaletteQuery}
          onSelect={setPaletteIndex}
          onRun={runPaletteCommand}
        />
      ) : null}
      {overlay === "ask" && selectedAgent ? (
        <AskComposer
          agent={selectedAgent}
          draft={askDraft}
          sending={askSending}
          error={askError}
          width={width}
          height={height}
          onSubmit={submitAsk}
        />
      ) : null}
    </box>
  );
}
