import type { Context } from "hono";
import type { MachineRecord } from "@openscout/protocol";
import type { ScoutWebSessionAuthority, ScoutWebAssetMode, ScoutWebLanAccessScope } from "./server-core.ts";
import { requestScoutHostWeb } from "./core/broker/service.ts";
import type { RepoDiffSnapshotOptions, ScoutRepoDiffSnapshot } from "@openscout/runtime";
import type { RepoPullRequestLoadOptions, RepoPullRequestSnapshot } from "./routes/repo-diff.ts";
import type { WebTailRuntime } from "./routes/scoutbot.ts";
import type { ScoutbotCodexAssistantInvoker } from "./scoutbot-assistant.ts";
import type { HerdrContinuationOptions } from "./core/attention/herdr-continuation-host.ts";

export type TerminalRunRequest = {
  command: string;
  cwd?: string | null;
  agentId?: string | null;
};

export type TmuxPanePeekRequest = {
  agentId: string;
  sessionId: string;
  paneTarget: string;
  cwd: string | null;
  lines: number;
  columns: number;
};

export type TmuxPanePeekCapture = {
  body: string;
  lineCount?: number;
  truncated?: boolean;
};

export type CreateOpenScoutWebServerOptions = {
  currentDirectory: string;
  shellStateCacheTtlMs?: number;
  assetMode: ScoutWebAssetMode;
  viteDevUrl?: string;
  staticRoot?: string;
  webPort?: number;
  publicOrigin?: string;
  portalHost?: string;
  advertisedHost?: string;
  trustedHosts?: string[];
  trustedOrigins?: string[];
  /** Required credential for privileged /api routes. Production hosts must set it. */
  authToken?: string;
  /** Minted browser sessions; when absent the auth cookie carries the token itself. */
  sessions?: ScoutWebSessionAuthority;
  /** Socket peer resolver. Injectable for tests; Bun connection info is used in production. */
  resolvePeerAddress?: (c: Context) => string | undefined;
  /** Network exposure policy. Defaults to OPENSCOUT_WEB_LAN_SCOPE. */
  lanAccessScope?: ScoutWebLanAccessScope;
  runTerminalCommand?: (request: TerminalRunRequest) => Promise<void>;
  destroyTerminalRelaySession?: (sessionId: string) => Promise<boolean>;
  destroyTerminalRelaySurface?: (backend: "tmux" | "zellij" | "herdr", sessionName: string) => Promise<number>;
  terminalRelayHealthcheck?: () => Promise<boolean>;
  revealPath?: (targetPath: string) => Promise<void> | void;
  /** Injectable for tests; spawns a surface's attach argv in a real terminal app. */
  openLocalTerminal?: (argv: readonly string[], options: { cwd?: string | null }) => Promise<{ app: string }> | { app: string };
  captureTmuxPane?: (request: TmuxPanePeekRequest) => Promise<TmuxPanePeekCapture | null> | TmuxPanePeekCapture | null;
  /**
   * Continuation over Herdr-hosted Claude panes. Tests inject this; `false`
   * disables it. Production reads the operator's grant file, and a pane with
   * no grant is `ask` (notify only, never answered). Omit `sendKeys` for shadow.
   */
  herdrContinuation?: HerdrContinuationOptions;
  scoutbotAssistant?: {
    invokeCodex?: ScoutbotCodexAssistantInvoker;
    /** Injectable for tests; defaults to the cached codex-executable probe. */
    agentAvailable?: () => boolean;
  };
  scoutbot?: {
    enabled?: boolean;
    brokerBaseUrl?: string;
  };
  /** Run process-wide discovery/watch services. Embedded and test hosts can
   * disable these to avoid owning UDP beacons and filesystem watchers. */
  backgroundServices?: boolean;
  /**
   * Machines the scout.local doorway lists. Defaults to the broker machine
   * roster (`/v1/machines`); injectable so tests never need a live broker.
   */
  portalMachines?: () => Promise<MachineRecord[]>;
  /** Fetch used to proxy `*.portalHost` peer doorway requests. For tests. */
  portalFetch?: typeof fetch;
  hostWebRequest?: typeof requestScoutHostWeb;
  // Injectable for tests; defaults to the runtime native diff producer.
  repoDiffSnapshot?: (options: RepoDiffSnapshotOptions) => Promise<ScoutRepoDiffSnapshot>;
  repoPullRequests?: (options: RepoPullRequestLoadOptions) => Promise<RepoPullRequestSnapshot>;
  tailRuntime?: Partial<WebTailRuntime>;
};
