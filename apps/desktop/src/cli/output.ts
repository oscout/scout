export type ScoutOutputMode = "plain" | "json";

export type ScoutOutput = {
  mode: ScoutOutputMode;
  writeText: (text: string) => void;
  writeValue: <T>(value: T, renderPlain: (value: T) => string) => void;
};

export function createScoutOutput(
  mode: ScoutOutputMode,
  stdout: (line: string) => void,
): ScoutOutput {
  return {
    mode,
    writeText(text: string) {
      stdout(text);
    },
    writeValue<T>(value: T, renderPlain: (current: T) => string) {
      if (mode === "json") {
        stdout(JSON.stringify(value, null, 2));
        return;
      }
      stdout(renderPlain(value));
    },
  };
}
