import {
  describeProvisionalAgentNamePool,
  normalizeProvisionalAgentNamesSetting,
} from "./provisional-agent-names-config.js";
import {
  loadUserConfig,
  resolveOperatorHandle,
  resolveOperatorName,
  type CommsChannel,
  type CommsTone,
  type CommsVerbosity,
  type InterruptThreshold,
  type OpenScoutUserConfig,
  type ProvisionalAgentNamesMode,
  type TailThinkingMode,
} from "./user-config.js";

export type UserConfigFieldKind = "string" | "number" | "enum" | "string-list";

export type UserConfigFieldDefinition = {
  /** CLI identifier, e.g. scout config set <id> <value> */
  id: string;
  /** Key in ~/.openscout/user.json */
  key: keyof OpenScoutUserConfig;
  label: string;
  kind: UserConfigFieldKind;
  summary?: string;
  /** Include in `scout config` / `scout config show` summary output */
  showInSummary?: boolean;
  enumValues?: readonly string[];
  aliases?: readonly string[];
  /** Parse CLI args after the field id. Undefined means unset. */
  parse?: (args: string[]) => unknown;
  /** Value for scout config get (defaults to stored config[key]). */
  resolveGet?: (config: OpenScoutUserConfig) => string;
  /** One-line value for scout config show. */
  formatSummary?: (config: OpenScoutUserConfig) => string;
  apply?: (config: OpenScoutUserConfig, value: unknown) => void;
  clear?: (config: OpenScoutUserConfig) => void;
};

export type UserConfigFieldSaveContext = {
  currentDirectory?: string;
};

export type UserConfigFieldAfterSetHook = (
  context: UserConfigFieldSaveContext,
  value: unknown,
) => void | Promise<void>;

const INTERRUPT_THRESHOLDS = ["always", "blocking-only", "batched", "never"] as const;
const COMMS_CHANNELS = ["here", "mobile", "here+mobile"] as const;
const COMMS_VERBOSITIES = ["terse", "normal", "detailed"] as const;
const COMMS_TONES = ["direct", "warm", "formal"] as const;
const AGENT_NAME_MODES = ["replace", "extend"] as const;
const TAIL_THINKING_MODES = ["hide", "tag"] as const;

function parseStringValue(args: string[]): string | undefined {
  const value = args.join(" ").trim();
  return value || undefined;
}

function parseNumberValue(args: string[]): number | undefined {
  const raw = args[0]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`expected a number, got "${raw}"`);
  }
  return value;
}

function parseEnumValue<T extends string>(args: string[], allowed: readonly T[]): T | undefined {
  const value = args[0]?.trim() as T | undefined;
  if (!value) return undefined;
  if (!allowed.includes(value)) {
    throw new Error(`expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

function parseCommaSeparatedList(args: string[]): string[] {
  const names = normalizeProvisionalAgentNamesSetting(
    args.join(" ").split(",").map((entry) => entry.trim()).filter(Boolean),
  );
  return names;
}

function formatStoredString(value: string | undefined): string {
  return value?.trim() ?? "";
}

function formatStoredNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function formatStoredEnum(value: string | undefined): string {
  return value?.trim() ?? "";
}

function formatStoredStringList(value: string[] | undefined): string {
  return normalizeProvisionalAgentNamesSetting(value).join(", ");
}

function setConfigValue<K extends keyof OpenScoutUserConfig>(
  config: OpenScoutUserConfig,
  key: K,
  value: OpenScoutUserConfig[K],
): void {
  config[key] = value;
}

function clearConfigValue(
  config: OpenScoutUserConfig,
  key: keyof OpenScoutUserConfig,
): void {
  delete config[key];
}

export const USER_CONFIG_FIELDS: readonly UserConfigFieldDefinition[] = [
  {
    id: "name",
    key: "name",
    label: "Display name",
    kind: "string",
    summary: "Operator display name",
    showInSummary: true,
    parse: parseStringValue,
    resolveGet: () => resolveOperatorName(),
    formatSummary: (config) => {
      const resolved = resolveOperatorName();
      return `${resolved}${config.name ? "" : " (default)"}`;
    },
  },
  {
    id: "handle",
    key: "handle",
    label: "Handle",
    kind: "string",
    summary: "Operator @mention handle",
    showInSummary: true,
    parse: parseStringValue,
    resolveGet: () => resolveOperatorHandle(),
    formatSummary: (config) => {
      const resolved = resolveOperatorHandle();
      return `@${resolved}${config.handle ? "" : " (default)"}`;
    },
  },
  {
    id: "pronouns",
    key: "pronouns",
    label: "Pronouns",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.pronouns),
    formatSummary: (config) => formatStoredString(config.pronouns) || "—",
  },
  {
    id: "hue",
    key: "hue",
    label: "Identity hue",
    kind: "number",
    parse: parseNumberValue,
    resolveGet: (config) => formatStoredNumber(config.hue),
    formatSummary: (config) => formatStoredNumber(config.hue) || "195 (default)",
  },
  {
    id: "bio",
    key: "bio",
    label: "Operator bio",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.bio),
    formatSummary: (config) => formatStoredString(config.bio) || "—",
  },
  {
    id: "timezone",
    key: "timezone",
    label: "Timezone",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.timezone),
    formatSummary: (config) => formatStoredString(config.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  {
    id: "working-hours",
    key: "workingHours",
    label: "Working hours",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.workingHours),
    formatSummary: (config) => formatStoredString(config.workingHours) || "08:00 – 18:00 (default)",
  },
  {
    id: "interrupt-threshold",
    key: "interruptThreshold",
    label: "Interrupt threshold",
    kind: "enum",
    enumValues: INTERRUPT_THRESHOLDS,
    parse: (args) => parseEnumValue(args, INTERRUPT_THRESHOLDS),
    resolveGet: (config) => formatStoredEnum(config.interruptThreshold),
    formatSummary: (config) => formatStoredEnum(config.interruptThreshold) || "blocking-only (default)",
    apply: (config, value) => {
      setConfigValue(config, "interruptThreshold", value as InterruptThreshold);
    },
  },
  {
    id: "tail-thinking",
    key: "tailThinking",
    label: "Tail thinking beats",
    kind: "enum",
    enumValues: TAIL_THINKING_MODES,
    summary: "Show a marker for thinking the model returned without text (hide | tag)",
    parse: (args) => parseEnumValue(args, TAIL_THINKING_MODES),
    resolveGet: (config) => formatStoredEnum(config.tailThinking),
    formatSummary: (config) => formatStoredEnum(config.tailThinking) || "hide (default)",
    apply: (config, value) => {
      setConfigValue(config, "tailThinking", value as TailThinkingMode);
    },
  },
  {
    id: "batch-window",
    key: "batchWindow",
    label: "Batch window",
    kind: "number",
    parse: parseNumberValue,
    resolveGet: (config) => formatStoredNumber(config.batchWindow),
    formatSummary: (config) => formatStoredNumber(config.batchWindow) || "15 (default)",
  },
  {
    id: "channel",
    key: "channel",
    label: "Comms channel",
    kind: "enum",
    enumValues: COMMS_CHANNELS,
    parse: (args) => parseEnumValue(args, COMMS_CHANNELS),
    resolveGet: (config) => formatStoredEnum(config.channel),
    formatSummary: (config) => formatStoredEnum(config.channel) || "here+mobile (default)",
    apply: (config, value) => {
      setConfigValue(config, "channel", value as CommsChannel);
    },
  },
  {
    id: "verbosity",
    key: "verbosity",
    label: "Comms verbosity",
    kind: "enum",
    enumValues: COMMS_VERBOSITIES,
    parse: (args) => parseEnumValue(args, COMMS_VERBOSITIES),
    resolveGet: (config) => formatStoredEnum(config.verbosity),
    formatSummary: (config) => formatStoredEnum(config.verbosity) || "terse (default)",
    apply: (config, value) => {
      setConfigValue(config, "verbosity", value as CommsVerbosity);
    },
  },
  {
    id: "tone",
    key: "tone",
    label: "Comms tone",
    kind: "enum",
    enumValues: COMMS_TONES,
    parse: (args) => parseEnumValue(args, COMMS_TONES),
    resolveGet: (config) => formatStoredEnum(config.tone),
    formatSummary: (config) => formatStoredEnum(config.tone) || "direct (default)",
    apply: (config, value) => {
      setConfigValue(config, "tone", value as CommsTone);
    },
  },
  {
    id: "quiet-hours",
    key: "quietHours",
    label: "Quiet hours",
    kind: "string",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.quietHours),
    formatSummary: (config) => formatStoredString(config.quietHours) || "22:00 – 07:00 (default)",
  },
  {
    id: "agent-names",
    key: "provisionalAgentNames",
    label: "Ephemeral agent names",
    kind: "string-list",
    summary: "Comma-separated rotation pool for one-off agents",
    showInSummary: true,
    parse: (args) => parseCommaSeparatedList(args),
    resolveGet: (config) => formatStoredStringList(config.provisionalAgentNames),
    formatSummary: (config) => describeProvisionalAgentNamePool(config),
    apply: (config, value) => {
      const names = Array.isArray(value) ? normalizeProvisionalAgentNamesSetting(value) : [];
      if (names.length === 0) {
        clearConfigValue(config, "provisionalAgentNames");
      } else {
        setConfigValue(config, "provisionalAgentNames", names);
      }
    },
    clear: (config) => clearConfigValue(config, "provisionalAgentNames"),
  },
  {
    id: "agent-names-mode",
    key: "provisionalAgentNamesMode",
    label: "Ephemeral agent name pool mode",
    kind: "enum",
    enumValues: AGENT_NAME_MODES,
    summary: "replace = your list only; extend = yours then Scout defaults",
    parse: (args) => parseEnumValue(args, AGENT_NAME_MODES),
    resolveGet: (config) => formatStoredEnum(config.provisionalAgentNamesMode) || "replace",
    formatSummary: (config) => formatStoredEnum(config.provisionalAgentNamesMode) || "replace (default)",
    apply: (config, value) => {
      setConfigValue(config, "provisionalAgentNamesMode", value as ProvisionalAgentNamesMode);
    },
  },
  {
    id: "agent-names-file",
    key: "provisionalAgentNamesFile",
    label: "Ephemeral agent names file",
    kind: "string",
    summary: "Advanced JSON pool override path",
    parse: parseStringValue,
    resolveGet: (config) => formatStoredString(config.provisionalAgentNamesFile),
    formatSummary: (config) => formatStoredString(config.provisionalAgentNamesFile) || "—",
  },
] as const;

const USER_CONFIG_FIELD_INDEX = new Map<string, UserConfigFieldDefinition>(
  USER_CONFIG_FIELDS.flatMap((field) => [
    [field.id, field],
    ...(field.aliases ?? []).map((alias) => [alias, field] as const),
  ]),
);

export function findUserConfigField(id: string): UserConfigFieldDefinition | undefined {
  return USER_CONFIG_FIELD_INDEX.get(id.trim());
}

export function listUserConfigFieldIds(): string[] {
  return USER_CONFIG_FIELDS.map((field) => field.id);
}

export function parseUserConfigFieldValue(
  field: UserConfigFieldDefinition,
  args: string[],
): unknown {
  if (args.length === 0) {
    return undefined;
  }
  const parser = field.parse ?? defaultParserForKind(field);
  return parser(args);
}

function defaultParserForKind(field: UserConfigFieldDefinition): (args: string[]) => unknown {
  switch (field.kind) {
    case "string":
      return parseStringValue;
    case "number":
      return parseNumberValue;
    case "enum":
      if (!field.enumValues?.length) {
        throw new Error(`field ${field.id} is missing enumValues`);
      }
      return (args) => parseEnumValue(args, field.enumValues!);
    case "string-list":
      return parseCommaSeparatedList;
    default:
      return parseStringValue;
  }
}

export function applyUserConfigField(
  config: OpenScoutUserConfig,
  field: UserConfigFieldDefinition,
  value: unknown,
): void {
  if (field.apply) {
    field.apply(config, value);
    return;
  }

  if (value === undefined) {
    clearUserConfigField(config, field);
    return;
  }

  setConfigValue(config, field.key, value as OpenScoutUserConfig[typeof field.key]);
}

export function clearUserConfigField(
  config: OpenScoutUserConfig,
  field: UserConfigFieldDefinition,
): void {
  if (field.clear) {
    field.clear(config);
    return;
  }
  clearConfigValue(config, field.key);
}

export function formatUserConfigFieldGet(
  field: UserConfigFieldDefinition,
  config: OpenScoutUserConfig = loadUserConfig(),
): string {
  if (field.resolveGet) {
    return field.resolveGet(config);
  }
  const value = config[field.key];
  return formatUserConfigFieldValue(field, value);
}

export function formatUserConfigFieldValue(
  field: UserConfigFieldDefinition,
  value: unknown,
): string {
  switch (field.kind) {
    case "number":
      return value === undefined || value === null ? "" : String(value);
    case "string-list":
      return formatStoredStringList(Array.isArray(value) ? value : undefined);
    case "enum":
    case "string":
      return typeof value === "string" ? value : "";
    default:
      return value === undefined || value === null ? "" : String(value);
  }
}

export function formatUserConfigFieldSummary(
  field: UserConfigFieldDefinition,
  config: OpenScoutUserConfig = loadUserConfig(),
): string {
  if (field.formatSummary) {
    return field.formatSummary(config);
  }
  return formatUserConfigFieldGet(field, config) || "—";
}

export function formatUserConfigSetMessage(
  field: UserConfigFieldDefinition,
  value: unknown,
): string {
  if (value === undefined) {
    if (field.id === "name") {
      return `Name reset to default: ${resolveOperatorName()}`;
    }
    if (field.id === "handle") {
      return `Handle reset to default: @${resolveOperatorHandle()}`;
    }
    if (field.id === "agent-names") {
      return "agent-names cleared (built-in pool)";
    }
    return `${field.id} cleared`;
  }

  const formatted = formatUserConfigFieldValue(field, value);
  if (field.id === "name") {
    return `Name set to: ${formatted}`;
  }
  if (field.id === "handle") {
    return `Handle set to: ${formatted}`;
  }
  return `${field.id} set to: ${formatted || "(empty)"}`;
}

export function listUserConfigSummaryLines(
  config: OpenScoutUserConfig = loadUserConfig(),
): string[] {
  return USER_CONFIG_FIELDS
    .filter((field) => field.showInSummary)
    .map((field) => `${field.id}: ${formatUserConfigFieldSummary(field, config)}`);
}

const USER_CONFIG_FIELD_AFTER_SET: Partial<
  Record<string, UserConfigFieldAfterSetHook>
> = {};

export function registerUserConfigFieldAfterSet(
  id: string,
  hook: UserConfigFieldAfterSetHook,
): void {
  USER_CONFIG_FIELD_AFTER_SET[id] = hook;
}

export async function runUserConfigFieldAfterSet(
  field: UserConfigFieldDefinition,
  context: UserConfigFieldSaveContext,
  value: unknown,
): Promise<void> {
  const hook = USER_CONFIG_FIELD_AFTER_SET[field.id];
  if (!hook) return;
  await hook(context, value);
}

export function formatUserConfigUsageLines(): string[] {
  const ids = listUserConfigFieldIds();
  return [
    "usage: scout config [show]",
    "       scout config list",
    "       scout config get <id>",
    "       scout config set <id> [value]",
    "       scout config agent-names [show]",
    "       scout config agent-names init [--empty] [--extend]",
    "       scout config set agent-names-init-file [--empty]",
    "",
    "ids:",
    ...ids.map((id) => `  ${id}`),
  ];
}