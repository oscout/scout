export { TerminalLeft } from "./left.tsx";
export {
  TerminalContent,
  TerminalScreen,
  type TerminalContentProps,
  type TerminalNavigate,
  type TerminalRoute,
  type TerminalScreenProps,
} from "./Terminal.tsx";
export { TerminalInspector as TerminalRight } from "./right.tsx";

/** @deprecated Use TerminalLeft */
export { TerminalLeft as ScoutTerminalLeftPanel } from "./left.tsx";

/** @deprecated Use TerminalRight */
export { TerminalInspector } from "./right.tsx";
