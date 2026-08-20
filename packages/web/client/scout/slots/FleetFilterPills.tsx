import "./fleet-shared.css";

export type FleetStateToken = "in_turn" | "in_flight" | "needs_attention" | "callable" | "blocked";

const STATE_TOKENS: readonly FleetStateToken[] = ["needs_attention", "in_turn", "in_flight", "callable", "blocked"];

const STATE_LABELS: Record<FleetStateToken, string> = {
  in_turn: "in turn",
  in_flight: "in flight",
  needs_attention: "needs attention",
  callable: "callable",
  blocked: "blocked",
};

const STATE_CLASS_TOKENS: Record<FleetStateToken, string> = {
  in_turn: "working",
  in_flight: "working",
  needs_attention: "working",
  callable: "available",
  blocked: "offline",
};

type Props = {
  active: ReadonlySet<FleetStateToken>;
  onToggle: (token: FleetStateToken) => void;
};

export function FleetFilterPills({ active, onToggle }: Props) {
  return (
    <div className="fleet-pills" role="group" aria-label="State filters">
      {STATE_TOKENS.map((t) => {
        const on = active.has(t);
        return (
          <button
            key={t}
            type="button"
            className={`fleet-pill fleet-pill--${STATE_CLASS_TOKENS[t]}${on ? " fleet-pill--on" : ""}`}
            onClick={() => onToggle(t)}
            aria-pressed={on}
          >
            {STATE_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}
