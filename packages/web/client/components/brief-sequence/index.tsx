/**
 * Brief-sequence components — drive the Home BRIEFING panel's live loading
 * treatment.
 *
 * What's here:
 *   - useBriefSequenceRuntime: drives a step sequence via requestAnimationFrame
 *   - BriefSequenceView: renders the step rows with inline data preview as each
 *     step transitions pending → active → done
 *   - SamplePanel + sample-type components: the per-step preview-as-hero
 *     panels (fleet chips, session cards, broker messages, tail rows, etc.)
 *
 * Types live in ./types.ts; the placeholder step sequence is in
 * ./sample-sequence.ts. CSS is co-located as ./brief-sequence.css under the
 * `bstudio-*` selector prefix (kept for legacy compatibility).
 */

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Inbox,
  Loader2,
  Network,
  Sparkles,
  Target,
  Telescope,
} from "lucide-react";

import type { BriefStep, StepSample } from "./types.ts";

export type StepState = "pending" | "active" | "done";

export type RuntimeStep = {
  step: BriefStep;
  state: StepState;
  progress: number;
};

export function buildInitialRuntime(steps: BriefStep[]): RuntimeStep[] {
  return steps.map((step) => ({ step, state: "pending", progress: 0 }));
}

export function stepIcon(kind: BriefStep["kind"]) {
  switch (kind) {
    case "scan":
      return Telescope;
    case "collect":
      return Inbox;
    case "inspect":
      return Archive;
    case "analyze":
      return Network;
    case "synthesize":
      return Sparkles;
    default:
      return Target;
  }
}

/**
 * Drive a step sequence via RAF. `active` is the on/off switch: flip to true
 * to start (or restart) the sequence, flip to false to freeze it. `speed`
 * multiplies the per-step durations (1 = mock-default, 2 = twice as fast).
 *
 * Returns the runtime steps + whether the sequence is currently playing.
 */
export function useBriefSequenceRuntime(
  steps: BriefStep[],
  options: { active: boolean; speed?: number } = { active: false },
): { runtime: RuntimeStep[]; playing: boolean; done: boolean } {
  const speed = options.speed ?? 1;
  const [runtime, setRuntime] = useState<RuntimeStep[]>(() =>
    buildInitialRuntime(steps),
  );
  const [playing, setPlaying] = useState(false);
  const [done, setDone] = useState(false);

  const rafRef = useRef<number | null>(null);
  const stepStartRef = useRef<number | null>(null);
  const stepIndexRef = useRef<number>(0);

  useEffect(() => {
    if (!options.active) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      stepStartRef.current = null;
      stepIndexRef.current = 0;
      setRuntime(buildInitialRuntime(steps));
      setPlaying(false);
      setDone(false);
      return;
    }

    setPlaying(true);
    setDone(false);
    stepIndexRef.current = 0;
    stepStartRef.current = null;
    setRuntime(buildInitialRuntime(steps));

    const tick = (now: number) => {
      const idx = stepIndexRef.current;
      if (idx >= steps.length) {
        setDone(true);
        setPlaying(false);
        return;
      }
      const step = steps[idx]!;
      const stepDur = step.duration / speed;

      if (stepStartRef.current === null) {
        stepStartRef.current = now;
        setRuntime((prev) => {
          const next = [...prev];
          if (next[idx] && next[idx]!.state !== "done") {
            next[idx] = { ...next[idx]!, state: "active", progress: 0 };
          }
          return next;
        });
      }

      const elapsed = now - (stepStartRef.current ?? now);
      const progress = Math.min(1, elapsed / stepDur);

      setRuntime((prev) => {
        const next = [...prev];
        if (next[idx] && next[idx]!.state !== "done") {
          next[idx] = { ...next[idx]!, state: "active", progress };
        }
        return next;
      });

      if (progress >= 1) {
        setRuntime((prev) => {
          const next = [...prev];
          if (next[idx]) {
            next[idx] = { ...next[idx]!, state: "done", progress: 1 };
          }
          return next;
        });
        stepIndexRef.current = idx + 1;
        stepStartRef.current = null;
        if (idx + 1 >= steps.length) {
          setDone(true);
          setPlaying(false);
          return;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [options.active, steps, speed]);

  return { runtime, playing, done };
}

export function BriefSequenceView({ runtime }: { runtime: RuntimeStep[] }) {
  return (
    <div className="bstudio-seq">
      {runtime.map((r) => (
        <BriefSequenceRow key={r.step.id} runtime={r} />
      ))}
    </div>
  );
}

function BriefSequenceRow({ runtime }: { runtime: RuntimeStep }) {
  const { step, state } = runtime;
  const Icon = stepIcon(step.kind);

  return (
    <div className="bstudio-seq-row" data-state={state}>
      <div className="bstudio-seq-head">
        <span className="bstudio-seq-state" aria-hidden="true">
          {state === "done" ? (
            <CheckCircle2 size={12} />
          ) : state === "active" ? (
            <Loader2 size={12} className="bstudio-spin" />
          ) : (
            <Icon size={12} />
          )}
        </span>
        <span className="bstudio-seq-label">{step.label}</span>
        <span className="bstudio-seq-leader" aria-hidden="true" />
        <span
          className={`bstudio-seq-result${
            step.countTone ? ` bstudio-seq-result--${step.countTone}` : ""
          }`}
        >
          {state === "done" ? step.result : state === "active" ? "scanning…" : ""}
        </span>
      </div>

      {state === "active" && (
        <div className="bstudio-seq-body">
          <SamplePanel sample={step.sample} />
        </div>
      )}
    </div>
  );
}

export function SamplePanel({ sample }: { sample: StepSample }) {
  switch (sample.type) {
    case "fleet":
      return <FleetSample sample={sample} />;
    case "sessions":
      return <SessionsSample sample={sample} />;
    case "broker":
      return <BrokerSample sample={sample} />;
    case "tail":
      return <TailSample sample={sample} />;
    case "plans":
      return <PlansSample sample={sample} />;
    case "anomalies":
      return <AnomaliesSample sample={sample} />;
    case "synthesize":
      return <SynthesizeSample lines={sample.lines} />;
    default:
      return null;
  }
}

function FleetSample({
  sample,
}: {
  sample: Extract<StepSample, { type: "fleet" }>;
}) {
  return (
    <div className="bstudio-sample bstudio-sample--fleet">
      <div className="bstudio-sample-chips">
        {sample.agents.map((a, i) => (
          <span
            key={a.id}
            className={`bstudio-agent-chip bstudio-agent-chip--${a.tone ?? "active"}`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span className="bstudio-agent-dot" aria-hidden="true" />
            {a.name}
            <span className="bstudio-agent-project">/{a.project}</span>
          </span>
        ))}
        <span className="bstudio-sample-more">+ {sample.more} more</span>
      </div>
    </div>
  );
}

function SessionsSample({
  sample,
}: {
  sample: Extract<StepSample, { type: "sessions" }>;
}) {
  return (
    <div className="bstudio-sample">
      <ul className="bstudio-sample-rows">
        {sample.sessions.map((s, i) => (
          <li
            key={s.id}
            className="bstudio-session-card"
            style={{ animationDelay: `${i * 100}ms` }}
          >
            <div className="bstudio-session-meta">
              <span className="bstudio-session-id">{s.id}</span>
              <span className="bstudio-session-project-chip">{s.project}</span>
              <span className="bstudio-session-ago">· {s.lastActive}</span>
            </div>
            <p className="bstudio-session-summary">{s.summary}</p>
          </li>
        ))}
        <li className="bstudio-sample-more bstudio-sample-more--row">
          + {sample.more} more sessions
        </li>
      </ul>
    </div>
  );
}

function brokerInitials(name: string): string {
  const parts = name.split(/[-_/]/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function BrokerSample({
  sample,
}: {
  sample: Extract<StepSample, { type: "broker" }>;
}) {
  return (
    <div className="bstudio-sample">
      <ul className="bstudio-sample-rows">
        {sample.messages.map((m, i) => (
          <li
            key={`${m.from}-${i}`}
            className={`bstudio-broker-card${m.tone ? ` bstudio-broker-card--${m.tone}` : ""}`}
            style={{ animationDelay: `${i * 110}ms` }}
          >
            <div className="bstudio-broker-avatar" aria-hidden="true">
              {brokerInitials(m.from)}
            </div>
            <div className="bstudio-broker-main">
              <div className="bstudio-broker-meta">
                <span className="bstudio-broker-from">{m.from}</span>
                <span className="bstudio-broker-arrow">→</span>
                <span className="bstudio-broker-to">{m.to}</span>
                {m.tone && (
                  <span className={`bstudio-broker-tag bstudio-broker-tag--${m.tone}`}>
                    {m.tone === "err" ? "error" : "warning"}
                  </span>
                )}
                <span className="bstudio-broker-ago">{m.ago} ago</span>
              </div>
              <p className="bstudio-broker-body">{m.body}</p>
            </div>
          </li>
        ))}
        <li className="bstudio-sample-more bstudio-sample-more--row">
          + {sample.more} more messages in queue
        </li>
      </ul>
    </div>
  );
}

function TailSample({
  sample,
}: {
  sample: Extract<StepSample, { type: "tail" }>;
}) {
  return (
    <div className="bstudio-sample">
      <ul className="bstudio-sample-rows bstudio-tail-rows">
        {sample.events.map((e, i) => (
          <li
            key={`${e.ts}-${i}`}
            className="bstudio-tail-row"
            data-kind={e.kind}
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <span className="bstudio-tail-ts">{e.ts}</span>
            <span className="bstudio-tail-source">{e.source}</span>
            <span className="bstudio-tail-kind">{e.kind}</span>
            <span className="bstudio-tail-body">{e.body}</span>
          </li>
        ))}
        <li className="bstudio-sample-more bstudio-sample-more--row">
          streaming over {sample.more.toLocaleString()} more events…
        </li>
      </ul>
    </div>
  );
}

function PlansSample({
  sample,
}: {
  sample: Extract<StepSample, { type: "plans" }>;
}) {
  return (
    <div className="bstudio-sample">
      <ul className="bstudio-sample-rows">
        {sample.plans.map((p, i) => (
          <li
            key={p.title}
            className="bstudio-plan-row"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            <div className="bstudio-plan-meta">
              <span className="bstudio-plan-title">{p.title}</span>
              <span className="bstudio-plan-status">[{p.status}]</span>
            </div>
            <div className="bstudio-plan-sub">
              <span>owner: {p.owner}</span>
              <span className="bstudio-sep">·</span>
              <span>{p.files} associated files</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AnomaliesSample({
  sample,
}: {
  sample: Extract<StepSample, { type: "anomalies" }>;
}) {
  return (
    <div className="bstudio-sample">
      <ul className="bstudio-sample-rows">
        {sample.items.map((item, i) => (
          <li
            key={item.label}
            className={`bstudio-anom-card bstudio-anom-card--${item.kind}`}
            style={{ animationDelay: `${i * 120}ms` }}
          >
            <div className="bstudio-anom-head">
              <AlertCircle size={13} className="bstudio-anom-icon" />
              <span className="bstudio-anom-label">{item.label}</span>
              <span className="bstudio-anom-severity">{item.kind}</span>
            </div>
            <div className="bstudio-anom-rows">
              <div className="bstudio-anom-row">
                <span className="bstudio-anom-key">on</span>
                <span className="bstudio-anom-val">{item.resource}</span>
              </div>
              <div className="bstudio-anom-row">
                <span className="bstudio-anom-key">reason</span>
                <span className="bstudio-anom-val">{item.detail}</span>
              </div>
              <div className="bstudio-anom-row">
                <span className="bstudio-anom-key">action</span>
                <span className="bstudio-anom-val bstudio-anom-val--action">
                  {item.suggested}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SynthesizeSample({ lines }: { lines: number }) {
  return (
    <div className="bstudio-sample bstudio-sample--synth">
      <p className="bstudio-synth-copy">
        Folding {lines} observations into a briefing…
      </p>
      <div className="bstudio-synth-bars">
        {Array.from({ length: lines }).map((_, i) => (
          <span
            key={i}
            className="bstudio-synth-bar"
            style={{ animationDelay: `${i * 110}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
