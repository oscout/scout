/**
 * Launch form for "Assign for review" on a PR:
 * project · harness · model · effort · optional agent · new/existing session.
 */

import { useEffect, useMemo, useState } from "react";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import type { Agent } from "../../lib/types.ts";
import type { RepoPullRequestItem } from "./api.ts";
import {
  assignPullRequestForReview,
  defaultHarnessForLaunch,
  defaultModelForLaunch,
  modelOptionsForLaunch,
  projectOptionsForPullRequest,
  PR_REVIEW_EFFORTS,
  PR_REVIEW_HARNESSES,
  PR_REVIEW_SESSION_MODES,
  rankAgentsForPullRequest,
  type AssignPullRequestSessionMode,
  type PullRequestReviewAgent,
} from "./pull-request-actions.ts";

export type PullRequestAssignDialogProps = {
  pr: RepoPullRequestItem;
  agents: Agent[];
  projects: readonly { root: string; name: string }[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
  onError: (message: string | null) => void;
  onAssigned: (result: {
    message: string;
    flightId: string | null;
    conversationId: string | null;
    targetAgentId: string | null;
  }) => void;
};

function shortPath(path: string): string {
  if (path.startsWith("/Users/")) {
    const parts = path.split("/");
    return `~/${parts.slice(3).join("/")}`;
  }
  return path;
}

function agentOptionLabel(agent: PullRequestReviewAgent): string {
  const handle = agent.handle?.trim() || agent.name?.trim() || agent.id;
  const bits = [
    agent.harness?.trim(),
    agent.model?.trim(),
    agent.state?.trim(),
    agent.harnessSessionId?.trim() ? "session" : null,
  ].filter(Boolean);
  return bits.length > 0 ? `@${handle} · ${bits.join(" · ")}` : `@${handle}`;
}

function compactSessionId(sessionId: string | null | undefined): string | null {
  const trimmed = sessionId?.trim();
  if (!trimmed) return null;
  return trimmed.length > 18 ? `${trimmed.slice(0, 10)}…${trimmed.slice(-4)}` : trimmed;
}

export function PullRequestAssignDialog({
  pr,
  agents,
  projects,
  pending,
  error,
  onClose,
  onPendingChange,
  onError,
  onAssigned,
}: PullRequestAssignDialogProps) {
  const focusTrap = useFocusTrap<HTMLDivElement>();
  const projectOptions = useMemo(
    () => projectOptionsForPullRequest(pr, projects),
    [pr, projects],
  );

  const [projectPath, setProjectPath] = useState(
    () => projectOptions[0]?.path ?? pr.path?.trim() ?? "",
  );
  const [agentId, setAgentId] = useState(""); // empty = one-time session
  const rankedAgents = useMemo(
    () => rankAgentsForPullRequest(pr, agents, projectPath),
    [agents, pr, projectPath],
  );
  const selectedAgent = rankedAgents.find((agent) => agent.id === agentId) ?? null;
  const hasExistingSession = Boolean(selectedAgent?.harnessSessionId?.trim());

  const [harness, setHarness] = useState(() => defaultHarnessForLaunch(null));
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [sessionMode, setSessionMode] = useState<AssignPullRequestSessionMode>("new");

  // Reset defaults when the PR changes.
  useEffect(() => {
    const nextProjects = projectOptionsForPullRequest(pr, projects);
    const nextPath = nextProjects[0]?.path ?? pr.path?.trim() ?? "";
    setProjectPath(nextPath);
    setAgentId("");
    setHarness(defaultHarnessForLaunch(null));
    setModel("");
    setEffort("medium");
    setSessionMode("new");
    onError(null);
  }, [pr.id]); // eslint-disable-line react-hooks/exhaustive-deps -- only reset on PR change

  // Repo-watch data can arrive after the dialog opens. Adopt the first project
  // only while the current choice is empty or has disappeared.
  useEffect(() => {
    if (projectPath && projectOptions.some((project) => project.path === projectPath)) return;
    setProjectPath(projectOptions[0]?.path ?? pr.path?.trim() ?? "");
  }, [pr.path, projectOptions, projectPath]);

  // When an existing agent is chosen, seed runtime from them (user can still edit).
  useEffect(() => {
    if (!selectedAgent) {
      setSessionMode("new");
      return;
    }
    setHarness(defaultHarnessForLaunch(selectedAgent));
    setModel(defaultModelForLaunch(selectedAgent));
    // Prefer continue when they already have a live harness session.
    setSessionMode(selectedAgent.harnessSessionId?.trim() ? "existing" : "new");
  }, [selectedAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep agent selection valid when project filter changes ranking set.
  useEffect(() => {
    if (!agentId) return;
    if (!rankedAgents.some((agent) => agent.id === agentId)) {
      setAgentId("");
    }
  }, [agentId, rankedAgents]);

  // If "continue" is chosen but the agent has no session, force new.
  useEffect(() => {
    if (sessionMode === "existing" && selectedAgent && !hasExistingSession) {
      setSessionMode("new");
    }
  }, [hasExistingSession, selectedAgent, sessionMode]);

  const modelOptions = useMemo(
    () => modelOptionsForLaunch(rankedAgents, selectedAgent),
    [rankedAgents, selectedAgent],
  );

  const canSubmit = Boolean(projectPath.trim())
    && !pending
    && !(selectedAgent && sessionMode === "existing" && !hasExistingSession);

  const submit = async () => {
    if (!canSubmit) return;
    onPendingChange(true);
    onError(null);
    try {
      const result = await assignPullRequestForReview(pr, {
        projectPath: projectPath.trim(),
        harness,
        model,
        reasoningEffort: effort,
        agent: selectedAgent,
        sessionMode: selectedAgent ? sessionMode : "new",
      });
      onAssigned(result);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      onPendingChange(false);
    }
  };

  const submitLabel = pending
    ? "Assigning…"
    : !selectedAgent
      ? "Start review"
      : sessionMode === "existing"
        ? "Continue session · review"
        : "New session · review";

  const hint = !selectedAgent
    ? "Starts a disposable one-time reviewer on the project with the runtime above."
    : sessionMode === "existing"
      ? `Continues @${selectedAgent.handle?.trim() || selectedAgent.name}'s current session${
        compactSessionId(selectedAgent.harnessSessionId)
          ? ` (${compactSessionId(selectedAgent.harnessSessionId)})`
          : ""
      }.`
      : `Starts a fresh harness session for @${selectedAgent.handle?.trim() || selectedAgent.name}.`;

  return (
    <div
      className="rw-pr-assign-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        ref={focusTrap.ref}
        className="rw-pr-assign-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rw-pr-assign-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          focusTrap.onKeyDown(event);
          if (event.key === "Escape" && !pending) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="rw-pr-assign-head">
          <div>
            <div className="rw-pr-assign-eyebrow">Assign for review</div>
            <h2 id="rw-pr-assign-title" className="rw-pr-assign-title">
              #{pr.number} · launch review
            </h2>
            <p className="rw-pr-assign-copy" title={pr.title}>{pr.title}</p>
            <p className="rw-pr-assign-meta">
              {pr.repo}
              {" · "}
              {pr.headRefName || "head"} → {pr.baseRefName || "base"}
            </p>
          </div>
          <button
            type="button"
            className="rw-pr-assign-close"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
        </div>

        <div className="rw-pr-assign-body">
          <div className="rw-pr-assign-fields">
            <label className="rw-pr-assign-field">
              <span>Project</span>
              <select
                value={projectPath}
                disabled={pending || projectOptions.length === 0}
                onChange={(event) => setProjectPath(event.target.value)}
                aria-label="Project path"
              >
                {projectOptions.length === 0 ? (
                  <option value="">No local project</option>
                ) : projectOptions.map((project) => (
                  <option key={project.path} value={project.path}>
                    {project.label} · {shortPath(project.path)}
                  </option>
                ))}
              </select>
            </label>

            <label className="rw-pr-assign-field">
              <span>Harness</span>
              <select
                value={harness}
                disabled={pending}
                onChange={(event) => setHarness(event.target.value)}
                aria-label="Harness"
              >
                {PR_REVIEW_HARNESSES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
                {harness && !PR_REVIEW_HARNESSES.some((option) => option.value === harness) ? (
                  <option value={harness}>{harness}</option>
                ) : null}
              </select>
            </label>

            <label className="rw-pr-assign-field">
              <span>Model</span>
              <input
                list="rw-pr-assign-models"
                value={model}
                disabled={pending}
                placeholder="Default for harness"
                onChange={(event) => setModel(event.target.value)}
                aria-label="Model"
              />
              <datalist id="rw-pr-assign-models">
                {modelOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </label>

            <label className="rw-pr-assign-field">
              <span>Effort</span>
              <select
                value={effort}
                disabled={pending}
                onChange={(event) => setEffort(event.target.value)}
                aria-label="Reasoning effort"
              >
                {PR_REVIEW_EFFORTS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="rw-pr-assign-field rw-pr-assign-field--wide">
              <span>Agent <em>(optional)</em></span>
              <select
                value={agentId}
                disabled={pending}
                onChange={(event) => setAgentId(event.target.value)}
                aria-label="Existing agent (optional)"
              >
                <option value="">New one-time reviewer on project</option>
                {rankedAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agentOptionLabel(agent)}
                  </option>
                ))}
              </select>
            </label>

            {selectedAgent ? (
              <fieldset className="rw-pr-assign-session" disabled={pending}>
                <legend>Session</legend>
                <div className="rw-pr-assign-session-choices" role="radiogroup" aria-label="Session mode">
                  {PR_REVIEW_SESSION_MODES.map((option) => {
                    const existingBlocked = option.value === "existing" && !hasExistingSession;
                    const active = sessionMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className="rw-pr-assign-session-choice"
                        data-active={active || undefined}
                        disabled={existingBlocked}
                        title={
                          existingBlocked
                            ? "This agent has no live harness session to continue"
                            : option.hint
                        }
                        onClick={() => setSessionMode(option.value)}
                      >
                        <span className="rw-pr-assign-session-title">{option.label}</span>
                        <span className="rw-pr-assign-session-sub">
                          {existingBlocked
                            ? "No live session on this agent"
                            : option.value === "existing" && compactSessionId(selectedAgent.harnessSessionId)
                              ? compactSessionId(selectedAgent.harnessSessionId)
                              : option.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}
          </div>

          <p className="rw-pr-assign-hint">{hint}</p>

          {error ? (
            <div className="rw-pr-assign-error" role="alert">{error}</div>
          ) : null}

          <div className="rw-pr-assign-actions">
            <button
              type="button"
              className="rw-pr-assign-submit"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
