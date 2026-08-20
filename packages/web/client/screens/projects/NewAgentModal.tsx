import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Rocket, X } from "lucide-react";
import { api } from "../../lib/api.ts";
import type { AgentConfigurationState, Route } from "../../lib/types.ts";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import { openContent } from "../../scout/slots/openContent.ts";
import type { RepoWatchWorktree } from "../../scout/repo-watch/types.ts";
import type { SessionInitiationResult } from "../agents/model.ts";
import { shortHomePath, worktreeLine } from "./project-overview-helpers.ts";
import {
  PROJECT_LAUNCH_HARNESSES,
  existingHandleSet,
  routingPreview,
  suggestHandles,
  validateHandle,
  type ProjectLaunchHarness,
  type ProjectLaunchPersistence,
} from "./new-agent-model.ts";
import "./new-agent-modal.css";

type Navigate = (route: Route) => void;

type RuntimeReadiness = {
  state: "ready" | "configured" | "installed" | "missing";
  detail: string;
  loginCommand: string | null;
};

const READINESS_LABEL: Record<RuntimeReadiness["state"], string> = {
  ready: "ready",
  configured: "configured",
  installed: "login needed",
  missing: "not found",
};

const READINESS_TONE: Record<RuntimeReadiness["state"], "ok" | "warn" | "off"> = {
  ready: "ok",
  configured: "ok",
  installed: "warn",
  missing: "off",
};

export type NewAgentExistingAgent = {
  name: string;
  handle: string | null;
  harness: string | null;
};

export function NewAgentModal({
  open,
  onClose,
  projectTitle,
  projectRoot,
  primaryWt,
  worktreeCount,
  branches,
  existingAgents,
  agentCount,
  sessionCount,
  route,
  navigate,
}: {
  open: boolean;
  onClose: () => void;
  projectTitle: string;
  projectRoot: string | null;
  primaryWt: RepoWatchWorktree | null;
  worktreeCount: number;
  branches: string[];
  existingAgents: NewAgentExistingAgent[];
  agentCount: number;
  sessionCount: number;
  route: Extract<Route, { view: "agents-v2" }>;
  navigate: Navigate;
}) {
  const { ref, onKeyDown } = useFocusTrap<HTMLDivElement>(open);
  const [harness, setHarness] = useState<ProjectLaunchHarness>("codex");
  const [model, setModel] = useState("");
  const [persistence, setPersistence] = useState<ProjectLaunchPersistence>("sticky");
  const [handle, setHandle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [state, setState] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<Map<string, RuntimeReadiness> | null>(null);

  // Reset the form each time the modal opens so it never carries stale input.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setState("idle");
  }, [open]);

  // Pull harness readiness lazily — honest availability, not a guessed list.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const snapshot = await api<AgentConfigurationState>("/api/agent-config/snapshot").catch(
        () => null,
      );
      if (cancelled || !snapshot) return;
      const map = new Map<string, RuntimeReadiness>();
      for (const runtime of snapshot.runtimes) {
        map.set(runtime.id, {
          state: runtime.state,
          detail: runtime.detail,
          loginCommand: runtime.loginCommand,
        });
      }
      setRuntimes(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  const handleSlugs = useMemo(
    () => existingHandleSet(existingAgents.flatMap((a) => [a.name, a.handle])),
    [existingAgents],
  );
  const validation = useMemo(
    () => validateHandle(handle, handleSlugs, persistence),
    [handle, handleSlugs, persistence],
  );
  const suggestions = useMemo(
    () => suggestHandles(projectTitle, harness, handleSlugs, 3),
    [projectTitle, harness, handleSlugs],
  );
  const projectRootLabel = projectRoot ? shortHomePath(projectRoot) : "<no-root>";
  const preview = useMemo(
    () =>
      routingPreview({
        handle: validation.normalized,
        persistence,
        harness,
        projectRootLabel,
      }),
    [validation.normalized, persistence, harness, projectRootLabel],
  );

  const selectedReadiness = runtimes?.get(
    PROJECT_LAUNCH_HARNESSES.find((h) => h.value === harness)?.runtimeId ?? harness,
  );

  if (!open) return null;

  const canSubmit = Boolean(projectRoot)
    && state !== "starting"
    && validation.status !== "invalid"
    && validation.status !== "conflict";

  const createLabel =
    state === "starting"
      ? "Starting…"
      : persistence === "one_time"
        ? "Dispatch one-off"
        : validation.status === "conflict"
          ? "Handle exists"
          : validation.normalized
            ? `Create @${validation.normalized}`
            : "Create with auto handle";

  const start = async () => {
    if (!projectRoot || state === "starting") return;
    setState("starting");
    setError(null);
    try {
      const trimmedModel = model.trim();
      const trimmedInstructions = instructions.trim();
      const requestedHandle = validation.normalized;
      const result = await api<SessionInitiationResult>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          target: { projectPath: projectRoot },
          execution: {
            session: "new",
            harness,
            ...(trimmedModel ? { model: trimmedModel } : {}),
          },
          agent: {
            persistence,
            ...(requestedHandle ? { handle: requestedHandle } : {}),
          },
          ...(trimmedInstructions ? { seed: { instructions: trimmedInstructions } } : {}),
        }),
      });
      const agentId = result.agentId?.trim();
      const sessionId = result.sessionId?.trim();
      const conversationId = result.conversationId?.trim();
      if (sessionId) {
        onClose();
        openContent(navigate, { view: "sessions", sessionId }, { returnTo: route });
        return;
      }
      if (agentId) {
        onClose();
        navigate({
          ...route,
          view: "agents-v2",
          agentId,
          selectedAgentId: undefined,
          sessionId: undefined,
          ...(conversationId ? { conversationId, tab: "message" } : { tab: "profile" }),
        });
        return;
      }
      if (conversationId) {
        onClose();
        navigate({ view: "conversation", conversationId });
        return;
      }
      setError("Agent start was accepted, but no target came back.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start an agent.");
    } finally {
      setState("idle");
    }
  };

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void start();
      return;
    }
    onKeyDown(event);
  };

  const contextChips: Array<{ label: string; value: string; title?: string }> = [];
  contextChips.push({
    label: "root",
    value: projectRoot ? shortHomePath(projectRoot) : "no project root",
    title: projectRoot ?? undefined,
  });
  if (primaryWt) {
    contextChips.push({ label: "branch", value: worktreeLine(primaryWt), title: primaryWt.path });
  } else if (branches.length > 0) {
    contextChips.push({
      label: "branch",
      value: branches.length === 1 ? branches[0] : `${branches.length} branches`,
    });
  }
  if (worktreeCount > 1) {
    contextChips.push({ label: "worktrees", value: String(worktreeCount) });
  }
  contextChips.push({
    label: "existing",
    value: `${agentCount} agent${agentCount === 1 ? "" : "s"} · ${sessionCount} session${
      sessionCount === 1 ? "" : "s"
    }`,
  });

  return createPortal(
    <div className="na-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="na-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="na-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handlePanelKeyDown}
      >
        <header className="na-head">
          <div className="na-headIdent">
            <h2 id="na-title" className="na-title">
              New agent
            </h2>
            <span className="na-scope">/{projectTitle}</span>
          </div>
          <button type="button" className="na-close" onClick={onClose} aria-label="Close (Esc)">
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="na-context">
          {contextChips.map((chip) => (
            <span key={chip.label} className="na-contextChip" title={chip.title}>
              <span className="na-contextLabel">{chip.label}</span>
              <span className="na-contextValue">{chip.value}</span>
            </span>
          ))}
        </div>

        <div className="na-body">
          <section className="na-section na-modeSection">
            <span className="na-sectionLabel">What are you creating?</span>
            <div className="na-modeChoice" role="radiogroup" aria-label="Agent kind">
              <button
                type="button"
                role="radio"
                aria-checked={persistence === "one_time"}
                className="na-modeCard"
                data-active={persistence === "one_time" || undefined}
                onClick={() => setPersistence("one_time")}
              >
                <span className="na-modeTitle">One-off run</span>
                <span className="na-modeSub">Disposable session · not addressable later</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={persistence === "sticky"}
                className="na-modeCard"
                data-active={persistence === "sticky" || undefined}
                onClick={() => setPersistence("sticky")}
              >
                <span className="na-modeTitle">Named agent</span>
                <span className="na-modeSub">Reusable card · addressable by handle</span>
              </button>
            </div>
          </section>

          <section className="na-section">
            <span className="na-sectionLabel">Runtime</span>
            <div className="na-harnessRow" role="radiogroup" aria-label="Harness">
              {PROJECT_LAUNCH_HARNESSES.map((option) => {
                const readiness = runtimes?.get(option.runtimeId);
                const active = harness === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className="na-harness"
                    data-active={active || undefined}
                    onClick={() => setHarness(option.value)}
                  >
                    <span className="na-harnessName">{option.label}</span>
                    {readiness ? (
                      <span
                        className="na-harnessState"
                        data-tone={READINESS_TONE[readiness.state]}
                      >
                        <span className="na-dot" aria-hidden />
                        {READINESS_LABEL[readiness.state]}
                      </span>
                    ) : (
                      <span className="na-harnessState" data-tone="off">
                        …
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {selectedReadiness && selectedReadiness.state !== "ready" ? (
              <p className="na-readinessNote" data-tone={READINESS_TONE[selectedReadiness.state]}>
                {selectedReadiness.detail}
                {selectedReadiness.loginCommand ? (
                  <code className="na-code"> {selectedReadiness.loginCommand}</code>
                ) : null}
              </p>
            ) : null}
            <label className="na-field">
              <span>Model / profile</span>
              <input
                value={model}
                placeholder="default"
                onChange={(event) => setModel(event.currentTarget.value)}
              />
            </label>
          </section>

          {persistence === "sticky" ? (
            <section className="na-section">
              <span className="na-sectionLabel">Handle (optional)</span>
              <label className="na-field">
                <span>Address</span>
                <div className="na-handleWrap" data-tone={validation.tone}>
                  <span className="na-handleAt">@</span>
                  <input
                    value={handle}
                    placeholder={suggestions[0] ?? "auto"}
                    aria-invalid={validation.tone === "warn"}
                    autoFocus
                    onChange={(event) => setHandle(event.currentTarget.value)}
                  />
                </div>
              </label>
              {suggestions.length > 0 ? (
                <div className="na-suggestRow">
                  <span className="na-suggestLabel">suggest</span>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="na-suggest"
                      onClick={() => setHandle(suggestion)}
                    >
                      @{suggestion}
                    </button>
                  ))}
                </div>
              ) : null}
              {validation.message ? (
                <p className="na-validation" data-tone={validation.tone}>
                  {validation.message}
                </p>
              ) : validation.rewritten && validation.normalized ? (
                <p className="na-validation" data-tone="ok">
                  Saved as <code className="na-code">@{validation.normalized}</code>
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="na-section">
            <span className="na-sectionLabel">First instruction</span>
            <textarea
              className="na-prompt"
              value={instructions}
              rows={3}
              placeholder={`Start in /${projectTitle}…`}
              onChange={(event) => setInstructions(event.currentTarget.value)}
            />
          </section>

          <section className="na-section na-routing">
            <span className="na-sectionLabel">
              {preview.disposable ? "Dispatch preview" : "Routing preview"}
            </span>
            {preview.disposable ? (
              <div className="na-routingBody" data-disposable>
                <p className="na-routingResolves">{preview.resolves}</p>
                <button
                  type="button"
                  className="na-promote"
                  onClick={() => setPersistence("sticky")}
                >
                  Name it to keep it →
                </button>
              </div>
            ) : (
              <div className="na-routingBody">
                {preview.card ? (
                  <div className="na-routingLine">
                    <span className="na-routingKey">address</span>
                    <code className="na-routingValue na-routingCard">{preview.card}</code>
                  </div>
                ) : null}
                <div className="na-routingLine">
                  <span className="na-routingKey">cli</span>
                  <code className="na-routingValue">{preview.cli}</code>
                </div>
                <p className="na-routingResolves">{preview.resolves}</p>
                <p className="na-routingNote">{preview.note}</p>
              </div>
            )}
          </section>
        </div>

        {error ? <div className="na-error">{error}</div> : null}

        <footer className="na-foot">
          <span className="na-footRoot" title={projectRoot ?? undefined}>
            {projectRoot ? shortHomePath(projectRoot) : "No project root — cannot create."}
          </span>
          <div className="na-footActions">
            <button type="button" className="na-cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="na-create"
              disabled={!canSubmit}
              onClick={() => void start()}
            >
              <Rocket size={12} strokeWidth={2} aria-hidden />
              {createLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
