import type {
  ScoutDoctorReport,
  ScoutLocalEdgeDoctorReport,
  ScoutLocalEdgeHostResolution,
  ScoutProjectInventoryEntry,
  ScoutRuntimesReport,
  ScoutSetupReport,
} from "../../core/setup/service.ts";

type LocalEdgeDependencyReport = ScoutSetupReport["localEdge"];

function renderBrokerHealthTransportLines(
  broker: ScoutDoctorReport["broker"] | ScoutSetupReport["broker"],
): string[] {
  const lines = [
    `  Broker socket: ${broker.brokerSocketPath}`,
    `  Health transport: ${broker.health.transport ?? "unknown"}`,
  ];
  if (broker.health.socketFallbackError) {
    lines.push(`  Socket fallback: ${broker.health.socketFallbackError}`);
  }
  return lines;
}

export function renderScoutDoctorStreamingLead(input: { repoRoot: string; currentDirectory: string }): string {
  return [
    "Scout doctor",
    `Repo root: ${input.repoRoot}`,
    `Context root: ${input.currentDirectory}`,
    "",
    "Discovering projects…",
    "",
  ].join("\n");
}

export function formatScoutDoctorStreamedProjectEntry(project: ScoutProjectInventoryEntry): string {
  const harnesses = project.harnesses
    .map((entry) => `${entry.harness} (${entry.detail})`)
    .join(" | ");

  const lines = [
    `  - ${project.displayName} (${project.agentId})`,
    `    Root: ${project.projectRoot}`,
    `    Source root: ${project.sourceRoot}`,
    `    Relative path: ${project.relativePath}`,
    `    State: ${project.registrationKind === "configured" ? "configured agent" : "discovered project"}`,
    `    Default harness: ${project.defaultHarness}`,
    `    Harnesses: ${harnesses}`,
  ];
  if (project.projectConfigPath) {
    lines.push(`    Manifest: ${project.projectConfigPath}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderScoutDoctorTailAfterStream(report: ScoutDoctorReport): string {
  const roots = report.setup.settings.discovery.workspaceRoots;
  const n = report.setup.projectInventory.length;
  const lines = [
    "",
    `Project inventory: ${n} project${n === 1 ? "" : "s"} (streamed above).`,
    "",
    `Support directory: ${report.setup.supportDirectory}`,
    `Settings: ${report.setup.settingsPath}`,
    `Harness catalog: ${report.setup.harnessCatalogPath}`,
    `Agent registry: ${report.setup.relayAgentsPath}`,
    `Managed installs: ${report.setup.managedInstallsPath}`,
    `Current project config: ${report.setup.currentProjectConfigPath ?? "not found"}`,
    "",
    "Source roots:",
    ...(roots.length > 0 ? roots.map((root) => `  - ${root}`) : ["  (none — Scout is not scanning any parent folders for repos.)"]),
    ...(roots.length === 0
      ? [
          "",
          "Tip: Set discovery.workspaceRoots in your OpenScout settings file, or run `scout setup --source-root <path>`.",
        ]
      : []),
    ...(roots.length > 0 && n === 0
      ? [
          "",
          "Tip: Under each source root, projects need a signal such as .git, a language manifest (Cargo.toml,",
          "go.mod, pyproject.toml, Gemfile, Package.swift, …), or agent docs (CLAUDE.md, AGENTS.md).",
          "Symlinked directories are followed.",
        ]
      : []),
    "",
    "Agent defaults:",
    `  Harness: ${report.setup.settings.agents.defaultHarness}`,
    `  Capabilities: ${report.setup.settings.agents.defaultCapabilities.join(", ")}`,
    `  Session prefix: ${report.setup.settings.agents.sessionPrefix}`,
    "",
    "Base service:",
    `  Label: ${report.broker.label}`,
    `  Broker URL: ${report.broker.brokerUrl}`,
    ...renderBrokerHealthTransportLines(report.broker),
    `  Installed: ${report.broker.installed ? "yes" : "no"}`,
    `  Loaded: ${report.broker.loaded ? "yes" : "no"}`,
    `  Reachable: ${report.broker.reachable ? "yes" : "no"}`,
    `  LaunchAgent: ${report.broker.launchAgentPath}`,
    `  Bootout: ${report.broker.bootoutCommand}`,
    `  Stdout: ${report.broker.stdoutLogPath}`,
    `  Stderr: ${report.broker.stderrLogPath}`,
    "",
    ...renderLocalEdgeDoctor(report.localEdge),
    "",
    ...renderTerminalPtyReport(report.terminalPty),
    "",
    ...renderSystemProbes(report.systemProbes),
    "",
    `Known runtimes: ${report.catalog.entries.length}`,
  ];

  for (const entry of report.catalog.entries) {
    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
    if (entry.readinessReport.missing.length > 0) {
      lines.push(`    Missing: ${entry.readinessReport.missing.join(" | ")}`);
    }
  }

  lines.push("", ...renderCapabilitySnapshotSummary(report.capabilities));

  return lines.join("\n");
}

function renderProjectInventory(projects: ScoutProjectInventoryEntry[]): string[] {
  const lines = [`Project inventory: ${projects.length}`];
  if (projects.length === 0) {
    lines.push("  No projects discovered yet.");
    return lines;
  }

  for (const project of projects) {
    const harnesses = project.harnesses
      .map((entry) => `${entry.harness} (${entry.detail})`)
      .join(" | ");

    lines.push(`  - ${project.displayName} (${project.agentId})`);
    lines.push(`    Root: ${project.projectRoot}`);
    lines.push(`    Source root: ${project.sourceRoot}`);
    lines.push(`    Relative path: ${project.relativePath}`);
    lines.push(`    State: ${project.registrationKind === "configured" ? "configured agent" : "discovered project"}`);
    lines.push(`    Default harness: ${project.defaultHarness}`);
    lines.push(`    Harnesses: ${harnesses}`);
    if (project.projectConfigPath) {
      lines.push(`    Manifest: ${project.projectConfigPath}`);
    }
  }

  return lines;
}

function renderLocalEdgeDependencyReport(report: LocalEdgeDependencyReport): string[] {
  const lines = [
    "Local edge:",
    `  Caddy: ${report.status}`,
    `  Detail: ${report.detail}`,
  ];
  if (report.caddyPath) {
    lines.push(`  Path: ${report.caddyPath}`);
  }
  if (report.caddyVersion) {
    lines.push(`  Version: ${report.caddyVersion}`);
  }
  if (report.installCommand) {
    lines.push(`  Install: ${report.installCommand}`);
  }
  return lines;
}

function renderTerminalPtyReport(report: ScoutDoctorReport["terminalPty"]): string[] {
  const lines = [
    "Web terminal (Node PTY relay):",
    `  State: ${report.status}`,
    `  Detail: ${report.detail}`,
  ];
  if (report.nodePath) {
    lines.push(`  Node: ${report.nodePath}${report.nodeVersion ? ` (${report.nodeVersion})` : ""}`);
  }
  lines.push(
    report.bindingPath
      ? `  Binding: ${report.bindingPackage} -> ${report.bindingPath}`
      : `  Binding: ${report.bindingPackage}`,
  );
  if (report.installCommand) {
    lines.push(`  Install: ${report.installCommand}`);
  }
  return lines;
}

function renderSystemProbes(report: ScoutDoctorReport["systemProbes"]): string[] {
  const lines = [
    "System probes:",
    `  Socket: ${report.socketPath}`,
    `  Socket exists: ${report.socketExists ? "yes" : "no"}`,
    `  Daemon observed: ${report.daemonObserved ? "yes" : "no"}`,
    `  Daemon version: ${report.daemonVersion ?? "-"}`,
    `  Capabilities: ${report.supportedProbeIds.length > 0 ? report.supportedProbeIds.join(", ") : "-"}`,
  ];
  if (report.lastError) {
    lines.push(`  Last scoutd error: ${report.lastError}`);
  }
  for (const family of report.families) {
    const fallback = family.fallbackSince
      ? `; fallback ${Math.round((family.fallbackAgeMs ?? 0) / 1000)}s: ${family.fallbackReason ?? "unknown"}`
      : "";
    lines.push(`  - ${family.id}: ${family.backend} (${family.status})${fallback}`);
  }
  for (const warning of report.warnings) {
    lines.push(`  Warning: ${warning}`);
  }
  return lines;
}

function formatLocalEdgeHostResolution(resolution: ScoutLocalEdgeHostResolution): string {
  if (resolution.resolved) {
    return `${resolution.host} -> ${resolution.addresses.join(", ")}`;
  }
  return `${resolution.host} -> not resolved${resolution.error ? ` (${resolution.error})` : ""}`;
}

function renderLocalEdgeDoctor(edge: ScoutLocalEdgeDoctorReport): string[] {
  const lines = [
    "Local web edge:",
    `  State: ${edge.state}`,
    `  Caddy: ${edge.dependency.status}`,
    `  Detail: ${edge.dependency.detail}`,
  ];
  if (edge.dependency.caddyPath) {
    lines.push(`  Path: ${edge.dependency.caddyPath}`);
  }
  if (edge.dependency.caddyVersion) {
    lines.push(`  Version: ${edge.dependency.caddyVersion}`);
  }
  if (edge.dependency.installCommand) {
    lines.push(`  Install: ${edge.dependency.installCommand}`);
  }
  lines.push(
    `  Portal host: ${formatLocalEdgeHostResolution(edge.dns.portal)}`,
    `  Node host: ${formatLocalEdgeHostResolution(edge.dns.node)}`,
    `  Caddyfile: ${edge.caddyfilePath}`,
    `  HTTP listener: ${edge.listeners.http.listening ? "yes" : "no"} (127.0.0.1:${edge.listeners.http.port})`,
    `  HTTPS listener: ${edge.listeners.https.listening ? "yes" : "no"} (127.0.0.1:${edge.listeners.https.port})`,
  );

  for (const hint of edge.hints) {
    lines.push(`  Hint: ${hint}`);
  }

  return lines;
}

function renderCapabilitySnapshotSummary(
  snapshot: ScoutDoctorReport["capabilities"],
): string[] {
  if (!snapshot) {
    return [
      "Capability snapshot:",
      "  Broker readout: unavailable",
    ];
  }

  const sourceCounts = new Map<string, number>();
  for (const source of snapshot.sources) {
    sourceCounts.set(source.kind, (sourceCounts.get(source.kind) ?? 0) + 1);
  }
  const sourceSummary = [...sourceCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(", ");
  const readinessCounts = new Map<string, number>();
  for (const capability of snapshot.capabilities) {
    readinessCounts.set(
      capability.readiness.state,
      (readinessCounts.get(capability.readiness.state) ?? 0) + 1,
    );
  }
  const readinessSummary = ["ready", "degraded", "missing", "disabled", "unknown"]
    .map((state) => `${state}: ${readinessCounts.get(state) ?? 0}`)
    .join(", ");
  const harnessSupportCount = Object.keys(snapshot.harnessSupport ?? {}).length;

  const lines = [
    "Capability snapshot:",
    `  Sources: ${snapshot.sources.length}${sourceSummary ? ` (${sourceSummary})` : ""}`,
    `  Harness support maps: ${harnessSupportCount}`,
    `  Capability definitions: ${snapshot.capabilities.length} (${readinessSummary})`,
    `  Warnings: ${snapshot.warnings.length}`,
  ];

  for (const warning of snapshot.warnings.slice(0, 3)) {
    lines.push(`    - ${warning}`);
  }
  return lines;
}

export function renderScoutDoctorReport(report: ScoutDoctorReport): string {
  const roots = report.setup.settings.discovery.workspaceRoots;
  const lines = [
    "Scout doctor",
    `Repo root: ${report.repoRoot}`,
    `Context root: ${report.currentDirectory}`,
    `Support directory: ${report.setup.supportDirectory}`,
    `Settings: ${report.setup.settingsPath}`,
    `Harness catalog: ${report.setup.harnessCatalogPath}`,
    `Agent registry: ${report.setup.relayAgentsPath}`,
    `Managed installs: ${report.setup.managedInstallsPath}`,
    `Current project config: ${report.setup.currentProjectConfigPath ?? "not found"}`,
    "",
    "Source roots:",
    ...(roots.length > 0 ? roots.map((root) => `  - ${root}`) : ["  (none — Scout is not scanning any parent folders for repos.)"]),
    ...(roots.length === 0
      ? [
          "",
          "Tip: Set discovery.workspaceRoots in your OpenScout settings file, or run `scout setup --source-root <path>`.",
        ]
      : []),
    ...(roots.length > 0 && report.setup.projectInventory.length === 0
      ? [
          "",
          "Tip: Under each source root, projects need a signal such as .git, a language manifest (Cargo.toml,",
          "go.mod, pyproject.toml, Gemfile, Package.swift, …), or agent docs (CLAUDE.md, AGENTS.md).",
          "Symlinked directories are followed.",
        ]
      : []),
    "",
    "Agent defaults:",
    `  Harness: ${report.setup.settings.agents.defaultHarness}`,
    `  Capabilities: ${report.setup.settings.agents.defaultCapabilities.join(", ")}`,
    `  Session prefix: ${report.setup.settings.agents.sessionPrefix}`,
    "",
    ...renderProjectInventory(report.setup.projectInventory),
    "",
    "Base service:",
    `  Label: ${report.broker.label}`,
    `  Broker URL: ${report.broker.brokerUrl}`,
    ...renderBrokerHealthTransportLines(report.broker),
    `  Installed: ${report.broker.installed ? "yes" : "no"}`,
    `  Loaded: ${report.broker.loaded ? "yes" : "no"}`,
    `  Reachable: ${report.broker.reachable ? "yes" : "no"}`,
    `  LaunchAgent: ${report.broker.launchAgentPath}`,
    `  Bootout: ${report.broker.bootoutCommand}`,
    `  Stdout: ${report.broker.stdoutLogPath}`,
    `  Stderr: ${report.broker.stderrLogPath}`,
    "",
    ...renderLocalEdgeDoctor(report.localEdge),
    "",
    ...renderTerminalPtyReport(report.terminalPty),
    "",
    ...renderSystemProbes(report.systemProbes),
    "",
    `Known runtimes: ${report.catalog.entries.length}`,
  ];

  for (const entry of report.catalog.entries) {
    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
    if (entry.readinessReport.missing.length > 0) {
      lines.push(`    Missing: ${entry.readinessReport.missing.join(" | ")}`);
    }
  }

  lines.push("", ...renderCapabilitySnapshotSummary(report.capabilities));

  return lines.join("\n");
}

export function renderScoutSetupReport(report: ScoutSetupReport): string {
  const lines = [
    "Scout initialized.",
    `Context root: ${report.currentDirectory}`,
    `Support directory: ${report.setup.supportDirectory}`,
    `Settings: ${report.setup.settingsPath}`,
    `Harness catalog: ${report.setup.harnessCatalogPath}`,
    `Agent registry: ${report.setup.relayAgentsPath}`,
    `Managed installs: ${report.setup.managedInstallsPath}`,
    `Claude statusline: ${report.claudeStatusline.status} (${report.claudeStatusline.wrapperPath})`,
    `Current project config: ${report.setup.currentProjectConfigPath ?? "not created"}`,
    `Created project config: ${report.setup.createdProjectConfig ? "yes" : "no"}`,
    "",
    "Source roots:",
    ...report.setup.settings.discovery.workspaceRoots.map((root) => `  - ${root}`),
    "",
    ...renderProjectInventory(report.setup.projectInventory),
    "",
    "Base service:",
    `  Label: ${report.broker.label}`,
    `  Broker URL: ${report.broker.brokerUrl}`,
    ...renderBrokerHealthTransportLines(report.broker),
    `  Reachable: ${report.broker.reachable ? "yes" : "no"}`,
    `  LaunchAgent: ${report.broker.launchAgentPath}`,
    `  Bootout: ${report.broker.bootoutCommand}`,
    `  Logs: ${report.broker.stdoutLogPath} | ${report.broker.stderrLogPath}`,
  ];

  if (report.brokerWarning) {
    lines.push(`  Warning: ${report.brokerWarning}`);
  }

  lines.push("", ...renderLocalEdgeDependencyReport(report.localEdge));

  lines.push("", "Harnesses:");
  for (const entry of report.catalog.entries) {
    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
  }

  lines.push(
    "",
    "Next:",
    "  scout doctor",
    "  scout runtimes",
  );

  return lines.join("\n");
}

export function renderScoutRuntimesReport(report: ScoutRuntimesReport): string {
  const lines = [
    `Context root: ${report.currentDirectory}`,
    `Harness catalog: ${report.harnessCatalogPath}`,
    `Known runtimes: ${report.catalog.entries.length}`,
  ];

  for (const entry of report.catalog.entries) {
    const support = Object.entries(entry.support)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key)
      .join(", ");

    lines.push(`  - ${entry.label} (${entry.name})`);
    lines.push(`    State: ${entry.readinessReport.state}`);
    lines.push(`    Detail: ${entry.readinessReport.detail}`);
    lines.push(`    Support: ${support || "none"}`);
    if (entry.readinessReport.binaryPath) {
      const version = entry.readinessReport.binaryVersion ? ` (${entry.readinessReport.binaryVersion})` : "";
      const source = entry.readinessReport.binarySource ? ` [${entry.readinessReport.binarySource}]` : "";
      lines.push(`    Binary: ${entry.readinessReport.binaryPath}${version}${source}`);
    }
    const alternates = entry.readinessReport.binaryCandidates
      ?.filter((candidate) => candidate.executable && !candidate.selected)
      .slice(0, 4) ?? [];
    if (alternates.length > 0) {
      lines.push("    Other binaries:");
      for (const candidate of alternates) {
        const version = candidate.version ? ` (${candidate.version})` : "";
        lines.push(`      - ${candidate.path}${version} [${candidate.source}]`);
      }
    }
    if (entry.readinessReport.missing.length > 0) {
      lines.push(`    Missing: ${entry.readinessReport.missing.join(" | ")}`);
    }
    if (entry.readinessReport.loginCommand) {
      lines.push(`    Login: ${entry.readinessReport.loginCommand}`);
    }
  }

  lines.push("", "Exact runtime capabilities:");
  for (const harness of report.runtimeCapabilities.harnesses) {
    const models = report.runtimeCapabilities.models
      .filter((model) => model.harnesses.includes(harness.id))
      .map((model) => model.id);
    const efforts = report.runtimeCapabilities.efforts
      .filter((effort) => effort.harnesses.includes(harness.id))
      .map((effort) => effort.id);
    lines.push(`  - ${harness.id}`);
    lines.push(`    Models: ${models.join(", ") || "not selectable"}`);
    lines.push(`    Efforts: ${efforts.join(", ") || "not selectable"}`);
  }

  lines.push("", ...renderCapabilitySnapshotSummary(report.capabilities));

  return lines.join("\n");
}
