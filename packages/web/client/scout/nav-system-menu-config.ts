import {
  projectCoreSystemMenuEntries,
  projectOpsSystemMenuEntries,
  type SystemMenuEntry,
} from "./nav-destinations.ts";

export type { SystemMenuEntry };

// Always present — the retrieval/ops-core surfaces that used to be lean top
// tabs or one go-shortcut away. Projected from the destination catalog.
export const CORE_SYSTEM_MENU_ENTRIES: SystemMenuEntry[] = projectCoreSystemMenuEntries();

// Power cluster — gated by `ops.control`, the same audience gate the old Ops
// top tab used. Mission Control remains here even though it is intentionally
// absent from the primary Home/Projects/Sessions/Chat navigation.
export const SYSTEM_OPS_ENTRIES: SystemMenuEntry[] = projectOpsSystemMenuEntries();
