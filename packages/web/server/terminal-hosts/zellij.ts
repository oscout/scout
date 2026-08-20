import { homedir } from "node:os";
import { join } from "node:path";

import { execSystemFile, zellijSessionsProbe } from "@openscout/runtime/system-probes";
import { formatTerminalSurfaceId } from "@openscout/protocol";
import type { TerminalSurface } from "@openscout/protocol";

import { errorReason, probeCommand } from "./tmux.ts";
import type {
  TerminalHostAdapter,
  TerminalHostContext,
  TerminalHostControlResult,
  TerminalHostSession,
} from "./types.ts";

const ZELLIJ_TIMEOUT_MS = 2_000;

/** ASCII control bytes `zellij action write` takes as numbers. */
const CTRL_C = "3";
const CTRL_D = "4";

/**
 * Zellij needs a short socket dir on macOS: the default $TMPDIR blows past the
 * Unix socket-path length limit, and the failure mode is a baffling
 * "session name must be less than 0 characters". Any relay attaching to a
 * Scout-created zellij surface must use the same directory or it lands in a
 * different server namespace.
 */
export function resolveZellijSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZELLIJ_SOCKET_DIR?.trim()
    || env.OPENSCOUT_ZELLIJ_SOCKET_DIR?.trim()
    || join(env.HOME?.trim() || homedir(), ".openscout", "zellij-sockets");
}

function zellijEnv(context: TerminalHostContext): NodeJS.ProcessEnv {
  const base = context.env ?? process.env;
  return { ...base, ZELLIJ_SOCKET_DIR: resolveZellijSocketDir(base) };
}

export const zellijTerminalHost: TerminalHostAdapter = {
  id: "zellij",
  label: "Zellij",
  description: "Persistent session that survives closing this window",
  capabilities: {
    attach: true,
    relayAttach: true,
    observe: true,
    // `zellij action write-chars` / `write <byte>` reach a session with no
    // client attached; verified against 0.44.
    sendInput: true,
    // `zellij action dump-screen` prints the viewport to stdout.
    capture: true,
    // `zellij attach --create-background` materializes without a terminal.
    create: true,
    list: true,
    observedAgentState: false,
    control: ["interrupt", "quit", "detach", "force-quit-bridge"],
    // Nothing walks a zellij pane's process tree yet, and claiming otherwise
    // would put a button on screen that cannot work.
    harnessControl: [],
  },

  async probe(context = {}) {
    return probeCommand("zellij", ["--version"], { env: zellijEnv(context) });
  },

  async list(context = {}) {
    const env = zellijEnv(context);
    const snapshot = await zellijSessionsProbe
      .for({ env, socketDir: resolveZellijSocketDir(env) })
      .fresh();
    return (snapshot.value ?? []).map((session): TerminalHostSession => ({
      name: session.name,
      state: session.state,
      metadata: { backendState: session.state, raw: session.raw },
    }));
  },

  surface(session, context = {}): TerminalSurface {
    const socketDir = resolveZellijSocketDir(context.env ?? process.env);
    return {
      surfaceId: formatTerminalSurfaceId({
        backend: "zellij",
        hostSession: session.name,
        paneId: session.paneId ?? null,
      }),
      backend: "zellij",
      sessionName: session.name,
      paneId: session.paneId ?? null,
      attachCommand: ["env", `ZELLIJ_SOCKET_DIR=${socketDir}`, "zellij", "attach", session.name],
      observeCommand: ["env", `ZELLIJ_SOCKET_DIR=${socketDir}`, "zellij", "watch", session.name],
      relay: {
        backend: "zellij",
        sessionName: session.name,
        zellijSession: session.name,
        ...(session.paneId ? { zellijPaneId: session.paneId } : {}),
      },
      state: session.state,
      socketDir,
    };
  },

  async create(input, context = {}) {
    try {
      await execSystemFile("zellij", ["attach", "--create-background", input.sessionName], {
        timeoutMs: 5_000,
        env: zellijEnv(context),
      });
      // `attach --create-background` takes no command, and typing one into the
      // new session with `action write-chars` would be Scout guessing at a
      // shell prompt that may not be ready. So the session comes back and the
      // harness does not, and the caller is told which of those happened.
      return {
        created: true,
        resumed: input.resumeCommand?.trim() ? false : null,
        ...(input.resumeCommand?.trim()
          ? { reason: "zellij starts a background session with no command; the harness was not resumed" }
          : {}),
      };
    } catch (error) {
      return { created: false, reason: errorReason(error) };
    }
  },

  async control(action, target, context = {}): Promise<TerminalHostControlResult> {
    const run = (args: string[]) => execSystemFile("zellij", ["--session", target.sessionName, ...args], {
      timeoutMs: ZELLIJ_TIMEOUT_MS,
      env: zellijEnv(context),
    });
    try {
      switch (action) {
        case "interrupt":
          await run(["action", "write", CTRL_C]);
          return { delivered: true };
        case "quit":
          await run(["action", "write", CTRL_D]);
          return { delivered: true };
        case "detach":
          await run(["action", "detach"]);
          return { delivered: true };
        default:
          return { delivered: false, reason: `zellij does not perform ${action}` };
      }
    } catch (error) {
      return { delivered: false, reason: errorReason(error) };
    }
  },

  async capture(target, context = {}) {
    try {
      const { stdout } = await execSystemFile("zellij", [
        "--session",
        target.sessionName,
        "action",
        "dump-screen",
        ...(target.paneId ? ["--pane-id", target.paneId] : []),
      ], { timeoutMs: ZELLIJ_TIMEOUT_MS, env: zellijEnv(context), maxStdoutBytes: 1024 * 1024 });
      return stdout;
    } catch {
      return null;
    }
  },
};
