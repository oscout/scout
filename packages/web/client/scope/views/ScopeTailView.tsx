import "./scope-views.css";

import { TailView } from "../../screens/shared/TailView.tsx";
import type { Route } from "../../lib/types.ts";
import { useScopePresentationAttrs } from "../hooks.ts";

export function ScopeTailView({
  navigate,
  tailQuery,
}: {
  navigate: (r: Route) => void;
  tailQuery?: string;
}) {
  const scopeAttrs = useScopePresentationAttrs();

  return (
    <div className="scope-tail-route" data-scope-view="tail" {...scopeAttrs}>
      <div className="scope-tail">
        <header className="scope-tail__bar">
          <div className="scope-tail__summary">
            <span className="scope-tail__count">tail</span>
            <span className="scope-tail__hint">live event stream</span>
            {tailQuery ? (
              <span className="scope-tail__query" title={tailQuery}>
                q={tailQuery}
              </span>
            ) : null}
          </div>
        </header>
        <div className="scope-tail__body">
          <div className="scope-tail__stream">
            <TailView
              navigate={navigate}
              initialFilter={tailQuery}
              variant="tail"
              chrome="embedded"
            />
          </div>
        </div>
      </div>
    </div>
  );
}