import { useEffect, useState } from "react";
import type { SoloProPhase, SoloProStatus } from "@openscout/runtime/solo-pro";

import { api } from "../lib/api.ts";
import { useConversationList } from "../lib/use-conversation-list.ts";
import { useScout } from "../scout/Provider.tsx";
import { onboardingResumable, soloSetupGaps, type SoloSetupGap } from "../scout/takeover/onboarding-gate.ts";
import { friendlyOnboardingError } from "../scout/takeover/onboarding-errors.ts";
import { basicDmConversations } from "./profile.ts";

const GAP_LABEL: Record<SoloSetupGap, string> = {
  local_config: "local config",
  identity: "your name",
  project: "a project folder",
  services: "the broker and an agent runtime",
};

/** Pro phases worth a line on Home; `active` needs nothing and `no_access` is an answer, not a step. */
const PRO_LINE: Partial<Record<SoloProPhase, string>> = {
  unconfirmed: "Have Solo Pro? Check this account's access.",
  finish_setup: "This account has Solo Pro. Finish installing it.",
  not_ready: "Solo Pro is installed but this server isn't serving it yet.",
};

/**
 * Home's next step for the basic web client, read from the same records the
 * takeover and Settings use: unfinished Solo setup first, then a first task,
 * plus one line toward Solo Pro. Renders nothing once there's nothing to do.
 */
export function BasicNextStep() {
  const { onboarding, onboardingSkipped, resumeOnboarding, navigate } = useScout();
  const resumable = onboardingResumable(onboarding, onboardingSkipped);
  // The server stamps completedAt once every Solo fact holds.
  const setupDone = Boolean(onboarding?.completedAt);
  const pro = useSoloProPhase();
  const { sessions, loading, loadError } = useConversationList();
  const firstTask = setupDone && !loading && !loadError && basicDmConversations(sessions).length === 0;
  const proLine = pro ? PRO_LINE[pro] : undefined;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      await resumeOnboarding();
    } catch (cause) {
      setError(friendlyOnboardingError("setup", cause));
    } finally {
      setBusy(false);
    }
  };

  if (!resumable && !firstTask && !proLine) return null;

  return (
    <section className="sb-next" aria-label="Next step">
      {resumable && onboarding ? (
        <div className="sb-next-row">
          <div className="sb-next-text">
            <strong>Setup isn't finished</strong>
            <span>Still needed: {soloSetupGaps(onboarding).map((gap) => GAP_LABEL[gap]).join(", ")}.</span>
            {error ? <span className="sb-next-error" role="alert">{error}</span> : null}
          </div>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void resume()}>
            {busy ? "Opening" : "Resume setup"}
          </button>
        </div>
      ) : firstTask ? (
        <div className="sb-next-row">
          <div className="sb-next-text">
            <strong>Give an agent its first task</strong>
            <span>Start a DM with an agent and say what you need. Its work shows up here and in Tail.</span>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => navigate({ view: "messages" })}>
            New DM
          </button>
        </div>
      ) : null}
      {proLine ? (
        <div className="sb-next-row sb-next-row--quiet">
          <div className="sb-next-text">
            <span>{proLine}</span>
          </div>
          <button type="button" className="btn" onClick={() => navigate({ view: "settings", section: "pro" })}>
            Solo Pro
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Local probes only (`GET /api/solo-pro` never asks the network or reads a key). */
function useSoloProPhase(): SoloProPhase | null {
  const [phase, setPhase] = useState<SoloProPhase | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<SoloProStatus>("/api/solo-pro")
      .then((status) => { if (!cancelled) setPhase(status.phase); })
      // A server without the route stays quiet; Settings explains the rest.
      .catch(() => { if (!cancelled) setPhase(null); });
    return () => { cancelled = true; };
  }, []);
  return phase;
}
