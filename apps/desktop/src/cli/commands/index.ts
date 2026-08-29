import type { ScoutCommandContext } from "../context.ts";

export type ScoutCommandHandler = (context: ScoutCommandContext, args: string[]) => Promise<void>;

export type ScoutCommandName =
  | "app"
  | "attention"
  | "ask"
  | "alias"
  | "broadcast"
  | "card"
  | "channel"
  | "config"
  | "diff"
  | "down"
  | "doctor"
  | "env"
  | "flight"
  | "init"
  | "inbox"
  | "install"
  | "label"
  | "latest"
  | "match"
  | "mcp"
  | "menu"
  | "mesh"
  | "monitor"
  | "need"
  | "pair"
  | "ps"
  | "providers"
  | "restart"
  | "role"
  | "runtimes"
  | "search"
  | "send"
  | "session"
  | "server"
  | "setup"
  | "speak"
  | "statusline"
  | "tail"
  | "tui"
  | "up"
  | "wait"
  | "watch"
  | "who"
  | "whoami";

export async function loadScoutCommandHandler(name: ScoutCommandName): Promise<ScoutCommandHandler> {
  switch (name) {
    case "app":
      return (await import("./app.ts")).runAppCommand;
    case "attention":
      return (await import("./attention.ts")).runAttentionCommand;
    case "ask":
      return (await import("./ask.ts")).runAskCommand;
    case "alias":
      return (await import("./alias.ts")).runAliasCommand;
    case "broadcast":
      return (await import("./broadcast.ts")).runBroadcastCommand;
    case "card":
      return (await import("./card.ts")).runCardCommand;
    case "channel":
      return (await import("./channel.ts")).runChannelCommand;
    case "config":
      return (await import("./config.ts")).runConfigCommand;
    case "diff":
      return (await import("./diff.ts")).runDiffCommand;
    case "down":
      return (await import("./down.ts")).runDownCommand;
    case "doctor":
      return (await import("./doctor.ts")).runDoctorCommand;
    case "env":
      return (await import("./env.ts")).runEnvCommand;
    case "flight":
      return (await import("./flight.ts")).runFlightCommand;
    case "init":
      return (await import("./init.ts")).runInitCommand;
    case "inbox":
      return (await import("./inbox.ts")).runInboxCommand;
    case "install":
      return (await import("./install.ts")).runInstallCommand;
    case "label":
      return (await import("./label.ts")).runLabelCommand;
    case "latest":
      return (await import("./latest.ts")).runLatestCommand;
    case "match":
      return (await import("./match.ts")).runMatchCommand;
    case "mcp":
      return (await import("./mcp.ts")).runMcpCommand;
    case "menu":
      return (await import("./menu.ts")).runMenuCommand;
    case "mesh":
      return (await import("./mesh.ts")).runMeshCommand;
    case "monitor":
      return (await import("./monitor.ts")).runMonitorCommand;
    case "pair":
      return (await import("./pair.ts")).runPairCommand;
    case "ps":
      return (await import("./ps.ts")).runPsCommand;
    case "providers":
      return (await import("./providers.ts")).runProvidersCommand;
    case "restart":
      return (await import("./restart.ts")).runRestartCommand;
    case "role":
      return (await import("./role.ts")).runRoleCommand;
    case "runtimes":
      return (await import("./runtimes.ts")).runRuntimesCommand;
    case "search":
      return (await import("./search.ts")).runSearchCommand;
    case "need":
      return (await import("./need.ts")).runNeedCommand;
    case "send":
      return (await import("./send.ts")).runSendCommand;
    case "session":
      return (await import("./session.ts")).runSessionCommand;
    case "server":
      return (await import("./server.ts")).runServerCommand;
    case "setup":
      return (await import("./setup.ts")).runSetupCommand;
    case "speak":
      return (await import("./speak.ts")).runSpeakCommand;
    case "statusline":
      return (await import("./statusline.ts")).runStatuslineCommand;
    case "tail":
      return (await import("./tail.ts")).runTailCommand;
    case "tui":
      return (await import("./tui.ts")).runTuiCommand;
    case "up":
      return (await import("./up.ts")).runUpCommand;
    case "wait":
      return (await import("./wait.ts")).runWaitCommand;
    case "watch":
      return (await import("./watch.ts")).runWatchCommand;
    case "who":
      return (await import("./who.ts")).runWhoCommand;
    case "whoami":
      return (await import("./whoami.ts")).runWhoAmICommand;
  }
}
