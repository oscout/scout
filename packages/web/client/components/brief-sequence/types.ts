/**
 * Type contract for the brief-sequence component.
 *
 * A `BriefStep` represents one phase Scoutbot goes through to assemble a brief
 * (scanning fleet, reading sessions, inspecting broker queue, etc.) and carries
 * a `StepSample` of the data that phase would surface.
 *
 * Consumers feed an array of `BriefStep`s into `useBriefSequenceRuntime` /
 * `BriefSequenceView` (see `index.tsx`). Sample fixtures live in
 * `./sample-sequence.ts`.
 */

export type BriefStepKind =
  | "scan"
  | "collect"
  | "inspect"
  | "analyze"
  | "synthesize";

export type FleetAgentPreview = {
  id: string;
  name: string;
  project: string;
  tone?: "active" | "idle" | "err";
};

export type SessionPreview = {
  id: string;
  project: string;
  lastActive: string;
  summary: string;
};

export type BrokerMessagePreview = {
  from: string;
  to: string;
  body: string;
  ago: string;
  tone?: "warn" | "err";
};

export type TailEventPreview = {
  ts: string;
  source: string;
  kind: string;
  body: string;
};

export type PlanPreview = {
  title: string;
  owner: string;
  status: string;
  files: number;
};

export type AnomalyPreview = {
  kind: "idle" | "error" | "stalled";
  label: string;
  detail: string;
  resource: string;
  suggested: string;
};

export type StepSample =
  | { type: "fleet"; agents: FleetAgentPreview[]; more: number }
  | { type: "sessions"; sessions: SessionPreview[]; more: number }
  | { type: "broker"; messages: BrokerMessagePreview[]; more: number }
  | { type: "tail"; events: TailEventPreview[]; more: number }
  | { type: "plans"; plans: PlanPreview[] }
  | { type: "anomalies"; items: AnomalyPreview[] }
  | { type: "synthesize"; lines: number };

export type BriefStep = {
  id: string;
  kind: BriefStepKind;
  label: string;
  duration: number;
  result: string;
  sample: StepSample;
  countTone?: "neutral" | "warn" | "err";
};
