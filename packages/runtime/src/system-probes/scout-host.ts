import type { RuntimeBinaryInput, RuntimeEnv } from "../portable-types.js";
import { resolveRepoServiceCommand, runRepoServiceJson } from "../repo-service/process.js";
import { execSystemFile, type ExecProbeFileResult } from "./exec.js";
import { gitBuildInfoProbe } from "./git-build-info.js";
import {
  gitDiffNumstat,
  gitDiffPatch,
  gitDiffRaw,
  gitDiffShortstat,
  gitLogLastCommitUnix,
  gitLogNameOnly,
  gitMergeBase,
  gitRemoteGetUrlOrigin,
  gitRevParse,
  gitStatusPorcelain,
  gitWorktreeListPorcelain,
  type GitCommandOptions,
  type GitDiffInput,
  type GitLogNameOnlyInput,
  type GitMergeBaseInput,
  type GitRevParseInput,
  type GitStatusPorcelainInput,
} from "./git.js";
import { netListenersProbe, type NetListenerSnapshot } from "./net-listeners.js";
import {
  processCwdProbe,
  psDiscoveryProbe,
  psRuntimeProbe,
  readProcessCwd,
  type ProcessDiscoverySnapshot,
  type PsRuntimeSnapshot,
} from "./ps.js";
import type { ProbeFreshOptions, ProbeSnapshot } from "./registry.js";
import { tailscaleStatusProbe } from "./tailscale-status.js";
import {
  captureTmuxPane,
  invalidateTmuxSessions,
  invalidateZellijSessions,
  readTmuxPaneDetail,
  readTmuxSessionExists,
  readZellijSessionExists,
  tmuxSessionsProbe,
  type TmuxSessionInfo,
  zellijSessionsProbe,
  type ZellijSessionInfo,
} from "./tmux.js";

export type ScoutHostRepoOptions = {
  timeoutMs?: number;
};

export type ScoutHostTmuxSocketOptions = {
  socketPath?: string | null;
  env?: RuntimeEnv;
};

export type ScoutHostZellijSocketOptions = {
  socketDir?: string | null;
  env?: RuntimeEnv;
};

export type ScoutHostTmuxCommandOptions = {
  socketPath?: string | null;
  timeoutMs?: number;
};

export type ScoutHostTmuxNewSessionOptions = ScoutHostTmuxCommandOptions & {
  detached?: boolean;
  printPane?: boolean;
  sessionName: string;
  windowName?: string;
  cwd?: string;
  format?: "#{pane_id}";
  columns?: number;
  rows?: number;
  command: string;
};

export type ScoutHostRevealMode =
  | "darwinReveal"
  | "darwinOpen"
  | "xdgOpen"
  | "windowsSelect";

function tmuxSocketArgs(socketPath: string | null | undefined): string[] {
  const socket = socketPath?.trim();
  return socket ? ["-S", socket] : [];
}

function timeoutMs(options: { timeoutMs?: number } | undefined, fallback: number): number {
  return Number.isFinite(options?.timeoutMs) && (options?.timeoutMs ?? 0) > 0
    ? options!.timeoutMs!
    : fallback;
}

function repoTimeoutMs(options: ScoutHostRepoOptions | undefined): number {
  return timeoutMs(options, 20_000);
}

function tmuxTimeoutMs(options: ScoutHostTmuxCommandOptions | undefined): number {
  return timeoutMs(options, 2_000);
}

function tmuxCommand(
  command: string,
  args: readonly string[],
  options: ScoutHostTmuxCommandOptions | undefined,
  input?: string | RuntimeBinaryInput,
): Promise<ExecProbeFileResult> {
  return execSystemFile("tmux", [...tmuxSocketArgs(options?.socketPath), command, ...args], {
    timeoutMs: tmuxTimeoutMs(options),
    ...(input === undefined ? {} : { input }),
  });
}

export const scoutHost = {
  tailscale: {
    status(options?: ProbeFreshOptions) {
      return tailscaleStatusProbe.fresh(options);
    },
    snapshot() {
      return tailscaleStatusProbe.snapshot();
    },
    invalidate(reason?: string) {
      tailscaleStatusProbe.invalidate(reason);
    },
    cert(input: {
      certFile: string;
      keyFile: string;
      hostname: string;
      timeoutMs?: number;
    }) {
      return execSystemFile("tailscale", [
        "cert",
        "--cert-file",
        input.certFile,
        "--key-file",
        input.keyFile,
        input.hostname,
      ], { timeoutMs: timeoutMs(input, 30_000) });
    },
  },
  git: {
    buildInfo(repoRoot: string, options?: ProbeFreshOptions) {
      return gitBuildInfoProbe.for(repoRoot).fresh(options);
    },
    buildInfoSnapshot(repoRoot: string) {
      return gitBuildInfoProbe.for(repoRoot).snapshot();
    },
    invalidateBuildInfo(repoRoot: string, reason?: string) {
      gitBuildInfoProbe.invalidate(repoRoot, reason);
    },
    revParse(input: GitRevParseInput, options?: GitCommandOptions) {
      return gitRevParse(input, options);
    },
    diffShortstat(input: GitDiffInput, options?: GitCommandOptions) {
      return gitDiffShortstat(input, options);
    },
    mergeBase(input: GitMergeBaseInput, options?: GitCommandOptions) {
      return gitMergeBase(input, options);
    },
    statusPorcelain(input: GitStatusPorcelainInput, options?: GitCommandOptions) {
      return gitStatusPorcelain(input, options);
    },
    diffRaw(input: GitDiffInput, options?: GitCommandOptions) {
      return gitDiffRaw(input, options);
    },
    diffNumstat(input: GitDiffInput & { z?: boolean }, options?: GitCommandOptions) {
      return gitDiffNumstat(input, options);
    },
    diffPatch(input: GitDiffInput, options?: GitCommandOptions) {
      return gitDiffPatch(input, options);
    },
    logNameOnly(input: GitLogNameOnlyInput, options?: GitCommandOptions) {
      return gitLogNameOnly(input, options);
    },
    logLastCommitUnix(repoRoot: string, options?: GitCommandOptions) {
      return gitLogLastCommitUnix(repoRoot, options);
    },
    worktreeListPorcelain(repoRoot: string, options?: GitCommandOptions) {
      return gitWorktreeListPorcelain(repoRoot, options);
    },
    remoteGetUrlOrigin(repoRoot: string, options?: GitCommandOptions) {
      return gitRemoteGetUrlOrigin(repoRoot, options);
    },
  },
  tmux: {
    sessions(input: ScoutHostTmuxSocketOptions = {}, options?: ProbeFreshOptions): Promise<ProbeSnapshot<TmuxSessionInfo[]>> {
      return tmuxSessionsProbe.for(input).fresh(options);
    },
    sessionSnapshot(input: ScoutHostTmuxSocketOptions = {}) {
      return tmuxSessionsProbe.for(input).snapshot();
    },
    sessionExists(sessionName: string, options: ScoutHostTmuxSocketOptions & { maxAgeMs?: number } = {}) {
      return readTmuxSessionExists(sessionName, options);
    },
    invalidateSessions(options: ScoutHostTmuxSocketOptions & { reason?: string } = {}) {
      invalidateTmuxSessions(options);
    },
    paneDetail(target: string, options: { socketPath?: string | null; maxAgeMs?: number } = {}) {
      return readTmuxPaneDetail(target, options);
    },
    capturePane(target: string, input: {
      start: string;
      end?: string;
      joinWrapped?: boolean;
      maxBytes?: number;
      maxAgeMs?: number;
      socketPath?: string | null;
    }) {
      return captureTmuxPane(target, input);
    },
    sendKeys(target: string, keys: readonly string[], options?: ScoutHostTmuxCommandOptions) {
      return tmuxCommand("send-keys", ["-t", target, ...keys], options);
    },
    sendKeysLiteral(target: string, text: string, options?: ScoutHostTmuxCommandOptions) {
      return tmuxCommand("send-keys", ["-t", target, "-l", text], options);
    },
    loadBuffer(bufferName: string, content: string | RuntimeBinaryInput, options?: ScoutHostTmuxCommandOptions) {
      return tmuxCommand("load-buffer", ["-b", bufferName, "-"], options, content);
    },
    pasteBuffer(target: string, bufferName: string, flags = "-dpr", options?: ScoutHostTmuxCommandOptions) {
      return tmuxCommand("paste-buffer", [flags, "-b", bufferName, "-t", target], options);
    },
    deleteBuffer(bufferName: string, options?: ScoutHostTmuxCommandOptions) {
      return tmuxCommand("delete-buffer", ["-b", bufferName], options);
    },
    killSession(target: string, options?: ScoutHostTmuxCommandOptions) {
      return tmuxCommand("kill-session", ["-t", target], options);
    },
    detachClient(sessionName: string, options?: ScoutHostTmuxCommandOptions) {
      return tmuxCommand("detach-client", ["-s", sessionName], options);
    },
    newSession(input: ScoutHostTmuxNewSessionOptions) {
      const args: string[] = [];
      if (input.detached === true && input.printPane === true) {
        args.push("-dP");
      } else {
        if (input.detached !== false) args.push("-d");
        if (input.printPane === true) args.push("-P");
      }
      if (input.windowName) args.push("-n", input.windowName);
      if (input.cwd) args.push("-c", input.cwd);
      if (input.format) args.push("-F", input.format);
      if (input.columns !== undefined) args.push("-x", String(input.columns));
      if (input.rows !== undefined) args.push("-y", String(input.rows));
      args.push("-s", input.sessionName, input.command);
      return tmuxCommand("new-session", args, input);
    },
  },
  zellij: {
    sessions(input: ScoutHostZellijSocketOptions = {}, options?: ProbeFreshOptions): Promise<ProbeSnapshot<ZellijSessionInfo[]>> {
      return zellijSessionsProbe.for(input).fresh(options);
    },
    sessionSnapshot(input: ScoutHostZellijSocketOptions = {}) {
      return zellijSessionsProbe.for(input).snapshot();
    },
    sessionExists(sessionName: string, options: ScoutHostZellijSocketOptions & { maxAgeMs?: number } = {}) {
      return readZellijSessionExists(sessionName, options);
    },
    invalidateSessions(options: ScoutHostZellijSocketOptions & { reason?: string } = {}) {
      invalidateZellijSessions(options);
    },
  },
  ps: {
    runtime(options?: ProbeFreshOptions): Promise<ProbeSnapshot<PsRuntimeSnapshot>> {
      return psRuntimeProbe.fresh(options);
    },
    runtimeSnapshot() {
      return psRuntimeProbe.snapshot();
    },
    discovery(options?: ProbeFreshOptions): Promise<ProbeSnapshot<ProcessDiscoverySnapshot>> {
      return psDiscoveryProbe.fresh(options);
    },
    discoverySnapshot() {
      return psDiscoveryProbe.snapshot();
    },
    cwd(pid: number | string, options?: ProbeFreshOptions): Promise<ProbeSnapshot<string | null>> {
      return processCwdProbe.for(pid).fresh(options);
    },
    readCwd(pid: number, maxAgeMs?: number) {
      return readProcessCwd(pid, maxAgeMs);
    },
  },
  net: {
    listeners(port: number | string, options?: ProbeFreshOptions): Promise<ProbeSnapshot<NetListenerSnapshot>> {
      return netListenersProbe.for(port).fresh(options);
    },
    listenerSnapshot(port: number | string) {
      return netListenersProbe.for(port).snapshot();
    },
  },
  repo: {
    scan(input: unknown, options?: ScoutHostRepoOptions) {
      return runRepoServiceJson(resolveRepoServiceCommand("scan"), input, repoTimeoutMs(options), "scan");
    },
    diff(input: unknown, options?: ScoutHostRepoOptions) {
      return runRepoServiceJson(resolveRepoServiceCommand("diff"), input, repoTimeoutMs(options), "diff");
    },
  },
  reveal: {
    open(targetPath: string, mode: ScoutHostRevealMode, options: { timeoutMs?: number } = {}) {
      if (mode === "darwinReveal") {
        return execSystemFile("open", ["-R", targetPath], { timeoutMs: timeoutMs(options, 1_500) });
      }
      if (mode === "darwinOpen") {
        return execSystemFile("open", [targetPath], { timeoutMs: timeoutMs(options, 1_500) });
      }
      if (mode === "xdgOpen") {
        return execSystemFile("xdg-open", [targetPath], { timeoutMs: timeoutMs(options, 1_500) });
      }
      return execSystemFile("explorer.exe", [`/select,${targetPath}`], { timeoutMs: timeoutMs(options, 1_500) });
    },
  },
} as const;

export const scout = {
  host: scoutHost,
} as const;

export type ScoutHostClient = typeof scoutHost;
export type ScoutHost = typeof scout.host;
export type ScoutHostTmuxSessions = TmuxSessionInfo[];
