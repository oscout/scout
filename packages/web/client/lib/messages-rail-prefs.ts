/**
 * Messages rail view prefs — which of the two rail views is active and how the
 * Sessions queue groups. Browser-local like conversation-prefs: a view choice
 * is a reading preference, not broker state.
 */

export type RailView = "agents" | "sessions";
export type SessionsGroupKey = "project" | "agent" | "day" | "state";

export type MessagesRailPrefs = {
  view: RailView;
  groupBy: SessionsGroupKey;
};

const STORAGE_KEY = "scout:messages:rail:v1";

const DEFAULTS: MessagesRailPrefs = { view: "agents", groupBy: "project" };

/** Private-mode fallback so prefs survive within the tab when storage throws. */
let memoryPrefs: MessagesRailPrefs | null = null;

function isRailView(value: unknown): value is RailView {
  return value === "agents" || value === "sessions";
}

function isGroupKey(value: unknown): value is SessionsGroupKey {
  return value === "project" || value === "agent" || value === "day" || value === "state";
}

export function loadMessagesRailPrefs(): MessagesRailPrefs {
  if (memoryPrefs) return memoryPrefs;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<MessagesRailPrefs>;
    return {
      view: isRailView(parsed.view) ? parsed.view : DEFAULTS.view,
      groupBy: isGroupKey(parsed.groupBy) ? parsed.groupBy : DEFAULTS.groupBy,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveMessagesRailPrefs(prefs: MessagesRailPrefs): MessagesRailPrefs {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    memoryPrefs = prefs;
  }
  return prefs;
}
