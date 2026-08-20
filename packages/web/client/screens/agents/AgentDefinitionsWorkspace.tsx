import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { api } from "../../lib/api.ts";
import { agentStateLabel } from "../../lib/agent-state.ts";
import { timeAgo } from "../../lib/time.ts";
import type { Agent, LocalAgentConfigState, Route, SessionCatalogWithResume } from "../../lib/types.ts";
import { useScout } from "../../scout/Provider.tsx";
import { agentSpecialization } from "../projects/agent-specialization.ts";
import { permissionLabel } from "../projects/project-overview-helpers.ts";
import { FileViewerPane, type ViewableProjectFile } from "./FileViewerPane.tsx";
import "../projects/projects.css";
import "./agent-definitions.css";

export type AgentDefinitionsPayload = {
  projectRoot: string;
  agentsRoot: string;
  agentsRootExists: boolean;
  selectedSlug: string | null;
  folders: Array<{
    slug: string;
    folderPath: string;
    files: Array<{
      name: string;
      relativePath: string;
      absolutePath: string;
      excerpt: string | null;
    }>;
  }>;
};

type SelectedFile = ViewableProjectFile & { slug: string; name: string };

function DefinitionsTree({
  payload,
  selectedSlug,
  selectedFile,
  filter,
  collapsed,
  onToggleFolder,
  onSelectFile,
}: {
  payload: AgentDefinitionsPayload;
  selectedSlug: string | null;
  selectedFile: SelectedFile | null;
  filter: string;
  collapsed: Set<string>;
  onToggleFolder: (slug: string) => void;
  onSelectFile: (file: SelectedFile) => void;
}) {
  const needle = filter.trim().toLowerCase();
  const folders = payload.folders.filter((folder) => {
    if (!needle) return true;
    if (folder.slug.includes(needle)) return true;
    return folder.files.some(
      (file) => file.name.toLowerCase().includes(needle) || file.relativePath.toLowerCase().includes(needle),
    );
  });

  if (folders.length === 0) {
    return (
      <div className="adef-treeEmpty">
        {payload.agentsRootExists
          ? "No agent folders in .agents yet."
          : "No .agents directory on disk."}
      </div>
    );
  }

  return (
    <>
      {folders.map((folder) => {
        const isCollapsed = collapsed.has(folder.slug);
        const isSelectedAgent = folder.slug === selectedSlug;
        return (
          <div key={folder.slug} className="adef-folder" data-selected-agent={isSelectedAgent || undefined}>
            <button
              type="button"
              className="adef-folderRow"
              onClick={() => onToggleFolder(folder.slug)}
            >
              <span className="adef-folderChevron" aria-hidden>
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </span>
              <span className="adef-folderIcon" aria-hidden>
                {isCollapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
              </span>
              <span className="adef-folderName">{folder.slug}</span>
            </button>
            {!isCollapsed
              ? folder.files.map((file) => {
                const selected = selectedFile?.absolutePath === file.absolutePath;
                return (
                  <button
                    key={file.absolutePath}
                    type="button"
                    className="adef-fileRow"
                    data-selected={selected || undefined}
                    onClick={() =>
                      onSelectFile({
                        slug: folder.slug,
                        name: file.name,
                        relativePath: `.agents/${file.relativePath}`,
                        absolutePath: file.absolutePath,
                        excerpt: file.excerpt,
                      })
                    }
                  >
                    <span className="adef-fileIcon" aria-hidden>
                      <FileText size={12} />
                    </span>
                    <span className="adef-fileName">{file.name}</span>
                  </button>
                );
              })
              : null}
          </div>
        );
      })}
    </>
  );
}

type LocalAgentConfigUpdateResponse = {
  config: LocalAgentConfigState;
  restarted: boolean;
};

function ConfigInspector({
  agent,
  config,
  onConfigSaved,
  sessionCatalog,
  navigate,
  homeView,
}: {
  agent: Agent;
  config: LocalAgentConfigState | null;
  onConfigSaved: (config: LocalAgentConfigState) => void;
  sessionCatalog: SessionCatalogWithResume | null;
  navigate: (route: Route) => void;
  homeView: "agents-v2";
}) {
  const spec = agentSpecialization(agent, config);
  const handle = agent.handle?.replace(/^@+/, "") || agent.name;
  const sessionCount = sessionCatalog?.sessions.length ?? 0;
  const [modelDraft, setModelDraft] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [harnessDraft, setHarnessDraft] = useState("");
  const [restartOnSave, setRestartOnSave] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) {
      setModelDraft("");
      setCwdDraft("");
      setHarnessDraft(agent.harness ?? "");
      return;
    }
    setModelDraft(config.model ?? "");
    setCwdDraft(config.runtime.cwd);
    setHarnessDraft(config.runtime.harness);
    setRestartOnSave(false);
    setSaveMessage(null);
    setSaveError(null);
  }, [agent.harness, agent.id, config]);

  const harnessOptions = useMemo(() => {
    const values = ["claude", "codex", "pi", config?.runtime.harness, agent.harness, harnessDraft]
      .filter((value): value is string => Boolean(value?.trim()));
    return Array.from(new Set(values));
  }, [agent.harness, config?.runtime.harness, harnessDraft]);

  const saveConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config || saveState === "saving") return;
    setSaveState("saving");
    setSaveMessage(null);
    setSaveError(null);
    try {
      const next = await api<LocalAgentConfigUpdateResponse>(`/api/agents/${encodeURIComponent(agent.id)}/config`, {
        method: "POST",
        body: JSON.stringify({
          model: modelDraft.trim() || null,
          runtime: {
            cwd: cwdDraft.trim() || config.runtime.cwd,
            harness: harnessDraft.trim() || config.runtime.harness,
          },
          restart: restartOnSave,
        }),
      });
      onConfigSaved(next.config);
      setRestartOnSave(false);
      setSaveMessage(next.restarted ? "Saved and restarted" : "Saved");
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not save config");
    } finally {
      setSaveState("idle");
    }
  };

  const openProfile = () =>
    navigate({
      view: homeView,
      agentId: agent.id,
      tab: "profile",
    });

  return (
    <aside className="adef-inspector">
      <header className="adef-inspectorHead">
        <AgentAvatar agent={agent} size={36} tile presence={false} />
        <div className="adef-inspectorIdent">
          <span className="adef-inspectorHandle">@{handle}</span>
          <span className="adef-inspectorSpec">{spec.headline}</span>
        </div>
      </header>
      <dl className="adef-inspectorFacts">
        <div>
          <dt>State</dt>
          <dd>{agentStateLabel(agent.state, agent)}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{sessionCount}</dd>
        </div>
      </dl>
      {config ? (
        <>
          <div className="adef-inspectorSec">Runtime</div>
          <form className="adef-configEdit" onSubmit={saveConfig}>
            <label className="adef-configField">
              <span>Model</span>
              <input
                value={modelDraft}
                placeholder="Harness default"
                disabled={!config.editable || saveState === "saving"}
                onChange={(event) => setModelDraft(event.currentTarget.value)}
              />
            </label>
            <label className="adef-configField">
              <span>Harness</span>
              <select
                value={harnessDraft}
                disabled={!config.editable || saveState === "saving"}
                onChange={(event) => setHarnessDraft(event.currentTarget.value)}
              >
                {harnessOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="adef-configField adef-configField--wide">
              <span>Working dir</span>
              <input
                value={cwdDraft}
                disabled={!config.editable || saveState === "saving"}
                onChange={(event) => setCwdDraft(event.currentTarget.value)}
              />
            </label>
            <div className="adef-configSaveRow">
              <label className="adef-configCheck">
                <input
                  type="checkbox"
                  checked={restartOnSave}
                  disabled={!config.editable || saveState === "saving"}
                  onChange={(event) => setRestartOnSave(event.currentTarget.checked)}
                />
                <span>Restart</span>
              </label>
              <button
                type="submit"
                className="adef-inspectorAct"
                data-primary
                disabled={!config.editable || saveState === "saving"}
              >
                {saveState === "saving" ? "Saving…" : "Save"}
              </button>
            </div>
            {saveMessage ? <p className="adef-inspectorMeta">{saveMessage}</p> : null}
            {saveError ? <p className="adef-configError">{saveError}</p> : null}
          </form>
          <div className="adef-inspectorSec">Permissions</div>
          <p className="adef-inspectorMono">{permissionLabel(config.permissionProfile)}</p>
          <div className="adef-inspectorSec">Tools</div>
          <div className="adef-inspectorChips">
            {(spec.capabilities.length > 0 ? spec.capabilities : ["—"]).map((cap) => (
              <span key={cap} className="adef-inspectorChip">{cap}</span>
            ))}
          </div>
        </>
      ) : (
        <p className="adef-inspectorMeta">No editable local config on disk.</p>
      )}
      {agent.updatedAt ? (
        <p className="adef-inspectorMeta">Updated {timeAgo(agent.updatedAt)}</p>
      ) : null}
      <div className="adef-inspectorActs">
        <button type="button" className="adef-inspectorAct" data-primary onClick={openProfile}>
          Sessions
        </button>
      </div>
    </aside>
  );
}

export function AgentDefinitionsWorkspace({
  agent,
  navigate,
  homeView = "agents-v2",
}: {
  agent: Agent;
  navigate: (route: Route) => void;
  homeView?: "agents-v2";
}) {
  const { openFilePreview } = useScout();
  const [payload, setPayload] = useState<AgentDefinitionsPayload | null>(null);
  const [config, setConfig] = useState<LocalAgentConfigState | null>(null);
  const [catalog, setCatalog] = useState<SessionCatalogWithResume | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<SessionCatalogWithResume | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  const revealPath = useCallback(async (path: string) => {
    await api("/api/file/reveal", {
      method: "POST",
      body: JSON.stringify({ path }),
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    void (async () => {
      const [definitions, configResult, catalog] = await Promise.allSettled([
        api<AgentDefinitionsPayload>(`/api/agents/${encodeURIComponent(agent.id)}/definitions`),
        api<LocalAgentConfigState>(`/api/agents/${encodeURIComponent(agent.id)}/config`).catch(() => null),
        api<SessionCatalogWithResume>(`/api/agents/${encodeURIComponent(agent.id)}/session-catalog`).catch(() => null),
      ]);
      if (cancelled) return;
      if (definitions.status === "fulfilled") setPayload(definitions.value);
      if (configResult.status === "fulfilled") setConfig(configResult.value);
      if (catalog.status === "fulfilled") setCatalog(catalog.value);
      setPhase("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const defaultFile = useMemo((): SelectedFile | null => {
    if (!payload) return null;
    const folder =
      payload.folders.find((entry) => entry.slug === payload.selectedSlug)
      ?? payload.folders[0]
      ?? null;
    const file = folder?.files.find((entry) => entry.name === "AGENT.md") ?? folder?.files[0] ?? null;
    if (!folder || !file) return null;
    return {
      slug: folder.slug,
      name: file.name,
      relativePath: `.agents/${file.relativePath}`,
      absolutePath: file.absolutePath,
      excerpt: file.excerpt,
    };
  }, [payload]);

  useEffect(() => {
    if (!defaultFile) return;
    setSelectedFile((current) => {
      if (current && payload?.folders.some((folder) =>
        folder.files.some((file) => file.absolutePath === current.absolutePath),
      )) {
        return current;
      }
      return defaultFile;
    });
    if (payload?.selectedSlug) {
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(payload.selectedSlug!);
        return next;
      });
    }
  }, [defaultFile, payload]);

  const fileCount = payload?.folders.reduce((sum, folder) => sum + folder.files.length, 0) ?? 0;

  const toggleFolder = useCallback((slug: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  return (
    <div className="adef-workspace">
      <header className="adef-head">
        <div className="adef-headCopy">
          <span className="adef-headKind">Config</span>
          <span className="adef-headPath" title={payload?.agentsRoot}>
            {payload?.agentsRootExists ? ".agents · explore & edit" : "explore & edit"}
            {payload ? ` · ${payload.folders.length} agents · ${fileCount} files` : ""}
          </span>
        </div>
        <input
          type="search"
          className="adef-filter"
          placeholder="Filter agents & files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </header>

      {phase === "loading" ? (
        <div className="adef-loading">Loading agent config…</div>
      ) : (
        <div className="adef-frame">
          <aside className="adef-tree" aria-label="Agent definition files">
            {payload ? (
              <DefinitionsTree
                payload={payload}
                selectedSlug={payload.selectedSlug}
                selectedFile={selectedFile}
                filter={filter}
                collapsed={collapsed}
                onToggleFolder={toggleFolder}
                onSelectFile={setSelectedFile}
              />
            ) : null}
          </aside>
          <section className="adef-viewer" aria-label="Definition file">
            {selectedFile ? (
              <FileViewerPane
                artifact={selectedFile}
                onOpen={openFilePreview}
                onReveal={(path) => void revealPath(path)}
                onBrowse={payload ? (path) => navigate({
                  view: "code",
                  root: payload.projectRoot,
                  file: path,
                }) : undefined}
              />
            ) : (
              <div className="av2-repoViewerState">
                {payload?.agentsRootExists
                  ? "Select a definition file — or create .agents/<handle>/AGENT.md"
                  : "Create .agents/<handle>/AGENT.md in the project root to define this expert on disk."}
              </div>
            )}
          </section>
          <ConfigInspector
            agent={agent}
            config={config}
            onConfigSaved={setConfig}
            sessionCatalog={sessionCatalog}
            navigate={navigate}
            homeView={homeView}
          />
        </div>
      )}
    </div>
  );
}
