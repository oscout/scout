import "./fleet-shared.css";

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
};

export function FleetSearch({ value, onChange, placeholder = "Search…", onKeyDown }: Props) {
  return (
    <input
      type="search"
      className="fleet-search"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
    />
  );
}
