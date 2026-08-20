import type { Route } from "../../lib/types.ts";
import { RawSessionsTable } from "./RawSessionsTable.tsx";

export function SessionsScreen({
  navigate,
}: {
  navigate: (r: Route) => void;
}) {
  // Sessions is its own top-level tab — no agents subnav shell.
  return <RawSessionsTable navigate={navigate} />;
}
