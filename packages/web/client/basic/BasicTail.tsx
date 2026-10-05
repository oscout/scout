import { useScout } from "../scout/Provider.tsx";
import { useFollowTailQuery } from "../screens/ops/follow-tail-query.ts";
import { TailView } from "../screens/shared/TailView.tsx";

/** Tail: the live event stream with its own filters, keys and detail sheet. */
export function BasicTail() {
  const { route, navigate } = useScout();
  const tailQuery = route.view === "ops" ? route.tailQuery : undefined;
  const resolvedQuery = useFollowTailQuery(route, tailQuery);

  return (
    <div className="sb-tail">
      <TailView navigate={navigate} initialFilter={resolvedQuery.query} sessionId={resolvedQuery.sessionId} variant="tail" inlineDetail />
    </div>
  );
}
