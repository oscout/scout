/**
 * Designed resting chip for model / harness / similar tools in the
 * MessageComposer toolbar. Native <select> is overlaid for a11y + OS menus;
 * the visible face is a pill chip with kicker + mono value + chevron.
 */

import "./message-composer.css";

export type MessageComposerToolOption = {
  value: string;
  label: string;
};

export type MessageComposerToolSelectProps = {
  /** Accessible name (also used as the tiny kicker when `kicker` is omitted). */
  label: string;
  /** Optional short kicker above/beside the value, e.g. "Model". */
  kicker?: string;
  value: string;
  onChange: (value: string) => void;
  options: MessageComposerToolOption[];
  disabled?: boolean;
  /** Hide the kicker; show only the value chip. */
  hideKicker?: boolean;
  className?: string;
};

function ChevronDown() {
  return (
    <svg
      className="s-msg-compose-tool-chevron"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function MessageComposerToolSelect({
  label,
  kicker,
  value,
  onChange,
  options,
  disabled = false,
  hideKicker = false,
  className,
}: MessageComposerToolSelectProps) {
  const selected = options.find((option) => option.value === value);
  const display = selected?.label
    ?? (value.trim() ? value : options[0]?.label ?? label);

  return (
    <label
      className={[
        "s-msg-compose-tool",
        disabled ? "s-msg-compose-tool--disabled" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Value-only face; `label` is for aria only (no visible kicker). */}
      <span className="s-msg-compose-tool-value">{display}</span>
      <ChevronDown />
      <select
        className="s-msg-compose-tool-native"
        aria-label={label}
        title={kicker && !hideKicker ? kicker : label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value || "__empty__"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
